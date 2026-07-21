import { LLMProvider, ProviderMessage, ToolCallRequest } from '../providers/base.js';
import { ProviderToolDefinition } from '../providers/base.js';
import { estimateTokens, truncateText } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

const SNIP_SAFETY_BUFFER = 1024;
const MICROCOMPACT_KEEP_RECENT = 10;
const MICROCOMPACT_MIN_CHARS = 500;
const INFLIGHT_COMPACT_TARGET_RATIO = 0.85;

const COMPACTABLE_TOOLS = new Set([
  'read_file', 'exec', 'grep', 'find_files',
  'web_search', 'web_fetch', 'list_dir', 'list_exec_sessions',
]);

const TOOL_RESULT_OFFLOAD_EXEMPT_TOOLS = new Set(['read_file']);

const BACKFILL_CONTENT = '[Tool result unavailable — call was interrupted or lost]';

const PLACEHOLDER_TEXTS = new Set([
  '[Previous assistant message omitted.]',
]);

function _toolCallNameIsValid(toolCall: unknown): boolean {
  if (typeof toolCall !== 'object' || toolCall === null) return false;
  const tc = toolCall as Record<string, unknown>;
  const fn = tc['function'] as Record<string, unknown> | undefined;
  const name = fn && typeof fn === 'object' ? fn['name'] : tc['name'];
  return typeof name === 'string' && name.length > 0;
}

export interface ContextGovernanceConfig {
  provider: LLMProvider;
  model: string;
  tools: { getDefinitions(): ProviderToolDefinition[] };
  workspace?: string | null;
  sessionKey?: string | null;
  maxToolResultChars: number;
  contextWindowTokens?: number | null;
  contextBlockLimit?: number | null;
  maxTokens?: number | null;
  inflightStartIndex?: number;
}

export class ContextGovernor {
  prepareForModel(
    config: ContextGovernanceConfig,
    messages: ProviderMessage[],
    compactedToolCallIds: Set<string>,
  ): ProviderMessage[] {
    let updated = this.stripPlaceholderAssistantMessages(messages);
    updated = this.stripMalformedToolCalls(updated);
    updated = this.dropOrphanToolResults(updated);
    updated = this.backfillMissingToolResults(updated);
    updated = this.applyToolResultBudget(config, updated);
    updated = this.compactInflightOverflow(config, updated, compactedToolCallIds);
    updated = this.snipHistory(config, updated);
    updated = this.dropOrphanToolResults(updated);
    return this.backfillMissingToolResults(updated);
  }

  static inputBudget(config: ContextGovernanceConfig): number {
    if (!config.contextWindowTokens) return 0;

    const maxOutput = config.maxTokens ?? 4096;
    const budget = config.contextBlockLimit ?? (
      config.contextWindowTokens - maxOutput - SNIP_SAFETY_BUFFER
    );
    return budget > 0 ? budget : 0;
  }

  static normalizeToolResult(
    config: ContextGovernanceConfig,
    toolCallId: string,
    toolName: string,
    result: unknown,
  ): unknown {
    let content = result;
    if (TOOL_RESULT_OFFLOAD_EXEMPT_TOOLS.has(toolName)) {
      return result;
    }
    if (typeof content === 'string' && content.length > config.maxToolResultChars) {
      return truncateText(content, config.maxToolResultChars);
    }
    return content;
  }

  stripPlaceholderAssistantMessages(messages: ProviderMessage[]): ProviderMessage[] {
    let updated: ProviderMessage[] | null = null;
    for (let idx = 0; idx < messages.length; idx++) {
      const msg = messages[idx];
      if (msg.role !== 'assistant') {
        if (updated !== null) updated.push(msg);
        continue;
      }
      const content = msg.content;
      const text = typeof content === 'string' ? content : '';
      const isPlaceholder = PLACEHOLDER_TEXTS.has(text.trim());
      const hasToolCalls = !!(msg.tool_calls && msg.tool_calls.length > 0);

      if (isPlaceholder && !hasToolCalls) {
        if (updated === null) {
          updated = messages.slice(0, idx);
        }
        logger.debug(
          { content: text.slice(0, 60) },
          'Stripping placeholder assistant message from history',
        );
        continue;
      }
      if (updated !== null) updated.push(msg);
    }
    return updated ?? messages;
  }

  stripMalformedToolCalls(messages: ProviderMessage[]): ProviderMessage[] {
    let updated: ProviderMessage[] | null = null;
    for (let idx = 0; idx < messages.length; idx++) {
      const msg = messages[idx];
      if (msg.role !== 'assistant') {
        if (updated !== null) updated.push(msg);
        continue;
      }
      const calls = msg.tool_calls;
      if (!calls || calls.length === 0) {
        if (updated !== null) updated.push(msg);
        continue;
      }
      const kept = calls.filter(tc => _toolCallNameIsValid(tc));
      if (kept.length === calls.length) {
        if (updated !== null) updated.push(msg);
        continue;
      }
      if (updated === null) {
        updated = messages.slice(0, idx).map(m => ({ ...m }));
      }
      logger.warn(
        { count: calls.length - kept.length },
        'Stripping malformed tool_call(s) with missing/non-string name',
      );
      const repaired: ProviderMessage = { ...msg };
      if (kept.length > 0) {
        repaired.tool_calls = kept;
      } else {
        delete repaired.tool_calls;
      }
      const hasContent = !!repaired.content;
      if (kept.length === 0 && !hasContent) {
        continue;
      }
      updated.push(repaired);
    }
    return updated ?? messages;
  }

  dropOrphanToolResults(messages: ProviderMessage[]): ProviderMessage[] {
    const declared = new Set<string>();
    let updated: ProviderMessage[] | null = null;
    for (let idx = 0; idx < messages.length; idx++) {
      const msg = messages[idx];
      if (msg.role === 'assistant') {
        for (const tc of msg.tool_calls || []) {
          const tcObj = tc as unknown as Record<string, unknown>;
          if (tcObj && tcObj['id']) {
            declared.add(String(tcObj['id']));
          }
        }
      }
      if (msg.role === 'tool') {
        const tid = msg.tool_call_id;
        if (tid && !declared.has(String(tid))) {
          if (updated === null) {
            updated = messages.slice(0, idx).map(m => ({ ...m }));
          }
          continue;
        }
      }
      if (updated !== null) updated.push({ ...msg });
    }
    return updated ?? messages;
  }

  backfillMissingToolResults(messages: ProviderMessage[]): ProviderMessage[] {
    const declared: Array<{ idx: number; id: string; name: string }> = [];
    const fulfilled = new Set<string>();

    for (let idx = 0; idx < messages.length; idx++) {
      const msg = messages[idx];
      if (msg.role === 'assistant') {
        for (const tc of msg.tool_calls || []) {
          const tcObj = tc as unknown as Record<string, unknown>;
          if (tcObj && tcObj['id']) {
            let name = '';
            const func = tcObj['function'] as Record<string, unknown> | undefined;
            if (func && typeof func === 'object') {
              name = String(func['name'] || '');
            }
            declared.push({ idx, id: String(tcObj['id']), name });
          }
        }
      } else if (msg.role === 'tool') {
        const tid = msg.tool_call_id;
        if (tid) {
          fulfilled.add(String(tid));
        }
      }
    }

    const missing = declared.filter(d => !fulfilled.has(d.id));
    if (missing.length === 0) return messages;

    const updated = [...messages];
    let offset = 0;
    for (const { idx, id, name } of missing) {
      let insertAt = idx + 1 + offset;
      while (insertAt < updated.length && updated[insertAt].role === 'tool') {
        insertAt++;
      }
      updated.splice(insertAt, 0, {
        role: 'tool',
        tool_call_id: id,
        name,
        content: BACKFILL_CONTENT,
      });
      offset++;
    }
    return updated;
  }

  applyToolResultBudget(
    config: ContextGovernanceConfig,
    messages: ProviderMessage[],
  ): ProviderMessage[] {
    let updated = messages;
    for (let idx = 0; idx < messages.length; idx++) {
      const message = messages[idx];
      if (message.role !== 'tool') continue;
      const normalized = ContextGovernor.normalizeToolResult(
        config,
        message.tool_call_id || `tool_${idx}`,
        message.name || 'tool',
        message.content,
      );
      if (normalized !== message.content) {
        if (updated === messages) {
          updated = messages.map(m => ({ ...m }));
        }
        updated[idx].content = normalized as string | ProviderMessage['content'];
      }
    }
    return updated;
  }

  compactInflightOverflow(
    config: ContextGovernanceConfig,
    messages: ProviderMessage[],
    compactedToolCallIds: Set<string>,
  ): ProviderMessage[] {
    const budget = ContextGovernor.inputBudget(config);
    if (budget <= 0) return messages;

    const tools = config.tools.getDefinitions();
    let updated = this._applyRecordedCompactions(messages, compactedToolCallIds);
    const [estimate] = this._estimatePromptTokens(config.model, updated, tools);
    if (estimate <= budget) return updated;

    const target = Math.floor(budget * INFLIGHT_COMPACT_TARGET_RATIO);
    const candidates = this._inflightCompactionCandidates(
      config,
      updated,
      compactedToolCallIds,
    );
    if (candidates.length === 0) return updated;

    for (let candidateIdx = 0; candidateIdx < candidates.length; candidateIdx++) {
      const isNewestCandidate = candidateIdx === candidates.length - 1;
      if (isNewestCandidate && estimate <= budget) break;

      const [idx, toolCallId] = candidates[candidateIdx];
      if (compactedToolCallIds.has(toolCallId)) continue;

      if (updated === messages) {
        updated = messages.map(m => ({ ...m }));
      }
      compactedToolCallIds.add(toolCallId);
      this._compactToolResultAt(updated, idx);

      const [newEstimate] = this._estimatePromptTokens(config.model, updated, tools);
      if (newEstimate <= target) break;
    }

    logger.debug(
      {
        session_key: config.sessionKey || 'default',
        budget,
        target,
        compacted_count: compactedToolCallIds.size,
      },
      'In-flight context compaction',
    );
    return updated;
  }

  snipHistory(
    config: ContextGovernanceConfig,
    messages: ProviderMessage[],
  ): ProviderMessage[] {
    if (messages.length === 0 || !config.contextWindowTokens) return messages;

    const budget = ContextGovernor.inputBudget(config);
    if (budget <= 0) return messages;

    const tools = config.tools.getDefinitions();
    const [estimate] = this._estimatePromptTokens(config.model, messages, tools);
    if (estimate <= budget) return messages;

    const systemMessages = messages.filter(m => m.role === 'system').map(m => ({ ...m }));
    const nonSystem = messages.filter(m => m.role !== 'system').map(m => ({ ...m }));
    if (nonSystem.length === 0) return messages;

    const systemTokens = systemMessages.reduce((sum, msg) => sum + this._estimateMessageTokens(msg), 0);
    const [fixedTokens] = this._estimatePromptTokens(config.model, systemMessages, tools);
    const remainingBudget = Math.max(0, budget - Math.max(systemTokens, fixedTokens));

    const kept: ProviderMessage[] = [];
    let keptTokens = 0;
    for (let i = nonSystem.length - 1; i >= 0; i--) {
      const message = nonSystem[i];
      const msgTokens = this._estimateMessageTokens(message);
      if (kept.length > 0 && keptTokens + msgTokens > remainingBudget) break;
      kept.unshift(message);
      keptTokens += msgTokens;
    }

    return [...systemMessages, ...this._legalHistoryTail(kept, nonSystem)];
  }

  private static _summaryFor(message: ProviderMessage): string {
    const name = message.name || 'tool';
    return `[Prior ${name} result compacted to fit context; the tool call already completed.]`;
  }

  private _legalHistoryTail(
    kept: ProviderMessage[],
    nonSystem: ProviderMessage[],
  ): ProviderMessage[] {
    const fallback = kept.length > 0 ? kept : (nonSystem.length > 0 ? [nonSystem[nonSystem.length - 1]] : []);
    const result = this._userTail(kept) || this._userTail(nonSystem, true) || fallback;
    return result;
  }

  private _userTail(messages: ProviderMessage[], last = false): ProviderMessage[] {
    if (last) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          return messages.slice(i);
        }
      }
    } else {
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'user') {
          return messages.slice(i);
        }
      }
    }
    return [];
  }

  private _applyRecordedCompactions(
    messages: ProviderMessage[],
    compactedToolCallIds: Set<string>,
  ): ProviderMessage[] {
    if (compactedToolCallIds.size === 0) return messages;
    let updated = messages;
    for (let idx = 0; idx < messages.length; idx++) {
      const msg = messages[idx];
      if (msg.role !== 'tool') continue;
      const toolCallId = msg.tool_call_id;
      if (!toolCallId || !compactedToolCallIds.has(String(toolCallId))) continue;
      const summary = ContextGovernor._summaryFor(msg);
      if (msg.content === summary) continue;
      if (updated === messages) {
        updated = messages.map(m => ({ ...m }));
      }
      updated[idx].content = summary;
    }
    return updated;
  }

  private _inflightCompactionCandidates(
    config: ContextGovernanceConfig,
    messages: ProviderMessage[],
    compactedToolCallIds: Set<string>,
  ): Array<[number, string]> {
    const compactable: Array<[number, string]> = [];
    const startIndex = config.inflightStartIndex ?? 0;
    for (let idx = 0; idx < messages.length; idx++) {
      if (idx < startIndex) continue;
      const msg = messages[idx];
      if (msg.role !== 'tool' || !COMPACTABLE_TOOLS.has(msg.name || '')) continue;
      const toolCallId = msg.tool_call_id;
      if (!toolCallId || compactedToolCallIds.has(String(toolCallId))) continue;
      const content = msg.content;
      if (typeof content !== 'string' || content.length < MICROCOMPACT_MIN_CHARS) continue;
      compactable.push([idx, String(toolCallId)]);
    }
    if (compactable.length === 0) return [];
    const primaryCount = Math.max(0, compactable.length - MICROCOMPACT_KEEP_RECENT);
    const primary = compactable.slice(0, primaryCount);
    const fallback = compactable.slice(primaryCount);
    return [...primary, ...fallback];
  }

  private _compactToolResultAt(messages: ProviderMessage[], idx: number): void {
    messages[idx].content = ContextGovernor._summaryFor(messages[idx]);
  }

  private _estimateMessageTokens(message: ProviderMessage): number {
    const content = message.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content.map(block => {
        const b = block as Record<string, unknown>;
        return typeof b['text'] === 'string' ? b['text'] : '';
      }).join(' ');
    }
    return estimateTokens(text);
  }

  private _estimatePromptTokens(
    _model: string,
    messages: ProviderMessage[],
    _tools: ProviderToolDefinition[],
  ): [number, string] {
    let total = 0;
    for (const msg of messages) {
      total += this._estimateMessageTokens(msg);
    }
    return [total, 'simple'];
  }
}
