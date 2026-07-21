import crypto from 'crypto';
import {
  LLMProvider,
  LLMResponse,
  LLMRuntime,
  ProviderMessage,
  ProviderToolDefinition,
  StreamCallback,
  StreamResult,
  ToolCallRequest,
  parseToolArguments,
  resolveStreamIdleTimeoutS,
  toolArgumentsObjectForReplay,
  ProviderContentBlock,
} from './base.js';
import { logger } from '../utils/logger.js';
import axios, { AxiosInstance } from 'axios';

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function genToolId(): string {
  let id = 'toolu_';
  for (let i = 0; i < 22; i++) {
    id += ALNUM[Math.floor(Math.random() * ALNUM.length)];
  }
  return id;
}

const VALID_TOOL_ID = /^[a-zA-Z0-9_-]+$/;

function sanitizeToolId(tid: string): string {
  if (!tid || VALID_TOOL_ID.test(tid)) {
    return tid;
  }
  const safePrefix = tid.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48).replace(/^_+|_+$/g, '') || 'toolu';
  const digest = crypto.createHash('sha1').update(tid).digest('hex').slice(0, 8);
  return `${safePrefix}_${digest}`;
}

export interface AnthropicProviderConfig {
  name: string;
  api_key?: string;
  base_url?: string;
  default_model?: string;
  extra_headers?: Record<string, string>;
}

export class AnthropicProvider extends LLMProvider {
  name = 'anthropic';
  private client: AxiosInstance;
  private config: AnthropicProviderConfig;
  defaultModel: string;

  constructor(config: AnthropicProviderConfig) {
    super();
    this.config = config;
    this.name = config.name || 'anthropic';
    this.defaultModel = config.default_model || 'claude-sonnet-4-6';

    const baseURL = this.normalizeBaseUrl(config.base_url || 'https://api.anthropic.com');
    this.client = axios.create({
      baseURL,
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(config.api_key ? { 'x-api-key': config.api_key } : {}),
        ...config.extra_headers,
      },
    });
  }

  private normalizeBaseUrl(apiBase: string): string {
    const normalized = apiBase.replace(/\/+$/, '');
    if (normalized.endsWith('/v1')) {
      return normalized.slice(0, -('/v1'.length));
    }
    return normalized;
  }

  private static stripPrefix(model: string): string {
    if (model.startsWith('anthropic/')) {
      return model.slice('anthropic/'.length);
    }
    return model;
  }

  private convertMessages(messages: ProviderMessage[]): [string | ProviderContentBlock[], ProviderMessage[]] {
    let system: string | ProviderContentBlock[] = '';
    const raw: ProviderMessage[] = [];
    const seenToolIds = new Set<string>();
    const pendingToolIds = new Map<string, string[]>();

    const uniqueToolId = (value: unknown): string => {
      const rawKey = value ? String(value) : '';
      const mappedId = rawKey ? sanitizeToolId(rawKey) : genToolId();
      if (mappedId && !seenToolIds.has(mappedId)) {
        seenToolIds.add(mappedId);
        if (rawKey) {
          const queue = pendingToolIds.get(rawKey) || [];
          queue.push(mappedId);
          pendingToolIds.set(rawKey, queue);
        }
        return mappedId;
      }
      const seed = mappedId || genToolId();
      let suffix = 2;
      while (true) {
        const candidate = `${seed}__dedupe_${suffix}`;
        if (!seenToolIds.has(candidate)) {
          seenToolIds.add(candidate);
          if (rawKey) {
            const queue = pendingToolIds.get(rawKey) || [];
            queue.push(candidate);
            pendingToolIds.set(rawKey, queue);
          }
          return candidate;
        }
        suffix++;
      }
    };

    const mapToolResultId = (value: unknown): string => {
      if (!value) return sanitizeToolId(String(value || ''));
      const rawId = String(value);
      const queue = pendingToolIds.get(rawId);
      if (queue && queue.length > 0) {
        const mappedId = queue.shift()!;
        if (queue.length === 0) {
          pendingToolIds.delete(rawId);
        }
        return mappedId;
      }
      return sanitizeToolId(rawId);
    };

    for (const msg of messages) {
      const role = msg.role;
      const content = msg.content;

      if (role === 'system') {
        system = typeof content === 'string' || Array.isArray(content) ? content : String(content || '');
        continue;
      }

      if (role === 'tool') {
        const block = this.toolResultBlock(msg, mapToolResultId);
        if (raw.length > 0 && raw[raw.length - 1].role === 'user') {
          const prev = raw[raw.length - 1];
          const prevContent = prev.content;
          if (Array.isArray(prevContent)) {
            prevContent.push(block as unknown as ProviderContentBlock);
          } else {
            prev.content = [
              { type: 'text', text: prevContent || '' },
              block as unknown as ProviderContentBlock,
            ];
          }
        } else {
          raw.push({ role: 'user', content: [block as unknown as ProviderContentBlock] });
        }
        continue;
      }

      if (role === 'assistant') {
        raw.push({
          role: 'assistant',
          content: this.assistantBlocks(msg, uniqueToolId),
        });
        continue;
      }

      if (role === 'user') {
        raw.push({
          role: 'user',
          content: this.convertUserContent(content) as ProviderContentBlock[] | string,
        });
        continue;
      }
    }

    return [system, this.mergeConsecutive(raw)];
  }

  private toolResultBlock(
    msg: ProviderMessage,
    mapToolResultId?: (value: unknown) => string,
  ): Record<string, unknown> {
    const content = msg.content;
    const toolCallId = msg.tool_call_id || '';
    const block: Record<string, unknown> = {
      type: 'tool_result',
      tool_use_id: mapToolResultId ? mapToolResultId(toolCallId) : sanitizeToolId(toolCallId),
    };
    if (Array.isArray(content)) {
      block.content = AnthropicProvider.convertUserContent(content);
    } else if (typeof content === 'string') {
      block.content = content;
    } else {
      block.content = content ? String(content) : '';
    }
    return block;
  }

  private assistantBlocks(
    msg: ProviderMessage,
    mapToolId?: (value: unknown) => string,
  ): ProviderContentBlock[] {
    const blocks: ProviderContentBlock[] = [];
    const content = msg.content;

    const thinkingBlocks = (msg as unknown as Record<string, unknown>).thinking_blocks as Record<string, unknown>[] | undefined;
    if (thinkingBlocks) {
      for (const tb of thinkingBlocks) {
        if (typeof tb === 'object' && tb !== null && tb.type === 'thinking') {
          blocks.push({
            type: 'thinking',
            thinking: tb.thinking as string,
            signature: tb.signature as string,
          } as unknown as ProviderContentBlock);
        }
      }
    }

    if (typeof content === 'string' && content) {
      blocks.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item === 'object' && item !== null) {
          if (!item.type) {
            blocks.push({
              type: 'text',
              text: AnthropicProvider.stringifyTypelessBlock(item),
            });
          } else {
            blocks.push(item);
          }
        } else {
          blocks.push({ type: 'text', text: String(item) });
        }
      }
    }

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        const args = tc.arguments;
        const rawId = tc.id || genToolId();
        blocks.push({
          type: 'tool_use',
          id: mapToolId ? mapToolId(rawId) : sanitizeToolId(rawId),
          name: tc.name,
          input: toolArgumentsObjectForReplay(args),
        } as unknown as ProviderContentBlock);
      }
    }

    return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }];
  }

  private static stringifyTypelessBlock(block: Record<string, unknown>): string {
    return JSON.stringify(block, Object.keys(block).sort(), 0);
  }

  private static convertUserContent(content: unknown): unknown {
    if (typeof content === 'string' || content === null || content === undefined) {
      return content || '(empty)';
    }
    if (!Array.isArray(content)) {
      return String(content);
    }

    const result: ProviderContentBlock[] = [];
    for (const item of content) {
      if (typeof item !== 'object' || item === null) {
        result.push({ type: 'text', text: String(item) });
        continue;
      }
      const itemObj = item as Record<string, unknown>;
      if (itemObj.type === 'image_url') {
        const converted = AnthropicProvider.convertImageBlock(itemObj);
        if (converted) {
          result.push(converted);
        }
        continue;
      }
      if (!itemObj.type) {
        result.push({
          type: 'text',
          text: AnthropicProvider.stringifyTypelessBlock(itemObj),
        });
        continue;
      }
      result.push(itemObj as ProviderContentBlock);
    }
    return result.length > 0 ? result : '(empty)';
  }

  private convertUserContent(content: unknown): unknown {
    return AnthropicProvider.convertUserContent(content);
  }

  private static convertImageBlock(block: Record<string, unknown>): ProviderContentBlock | null {
    const url = ((block.image_url as Record<string, unknown> | undefined) || {}).url as string || '';
    if (!url) return null;
    const match = url.match(/^data:(image\/\w+);base64,(.+)$/s);
    if (match) {
      return {
        type: 'image',
        source: { type: 'base64', media_type: match[1], data: match[2] },
      } as unknown as ProviderContentBlock;
    }
    return {
      type: 'image',
      source: { type: 'url', url },
    } as unknown as ProviderContentBlock;
  }

  private static hasToolUse(msg: ProviderMessage): boolean {
    const content = msg.content;
    if (!Array.isArray(content)) return false;
    return content.some(block =>
      typeof block === 'object' && block !== null && block.type === 'tool_use'
    );
  }

  private mergeConsecutive(msgs: ProviderMessage[]): ProviderMessage[] {
    const merged: ProviderMessage[] = [];
    for (const msg of msgs) {
      if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
        const prev = merged[merged.length - 1];
        let prevC = prev.content;
        let curC = msg.content;
        if (typeof prevC === 'string') {
          prevC = [{ type: 'text', text: prevC }];
        }
        if (typeof curC === 'string') {
          curC = [{ type: 'text', text: curC }];
        }
        if (Array.isArray(curC)) {
          (prevC as ProviderContentBlock[]).push(...curC as ProviderContentBlock[]);
        }
        prev.content = prevC;
      } else {
        merged.push({ ...msg });
      }
    }

    let lastPopped: ProviderMessage | null = null;
    while (merged.length > 0 && merged[merged.length - 1].role === 'assistant') {
      lastPopped = merged.pop()!;
    }

    if (merged.length === 0 && lastPopped !== null && !AnthropicProvider.hasToolUse(lastPopped)) {
      merged.push({ role: 'user', content: lastPopped.content });
    }

    if (merged.length > 0 && merged[0].role === 'assistant' && !AnthropicProvider.hasToolUse(merged[0])) {
      merged.unshift({ role: 'user', content: '(conversation continued)' });
    }

    return merged;
  }

  private static convertTools(tools: ProviderToolDefinition[] | null): Record<string, unknown>[] | null {
    if (!tools || tools.length === 0) return null;
    const result: Record<string, unknown>[] = [];
    for (const tool of tools) {
      const entry: Record<string, unknown> = {
        name: tool.name,
        input_schema: tool.input_schema,
      };
      if (tool.description) {
        entry.description = tool.description;
      }
      result.push(entry);
    }
    return result;
  }

  private static convertToolChoice(
    toolChoice: string | Record<string, unknown> | null | undefined,
    thinkingEnabled: boolean = false,
  ): Record<string, unknown> | null {
    if (thinkingEnabled) {
      return { type: 'auto' };
    }
    if (toolChoice === null || toolChoice === undefined || toolChoice === 'auto') {
      return { type: 'auto' };
    }
    if (toolChoice === 'required') {
      return { type: 'any' };
    }
    if (toolChoice === 'none') {
      return null;
    }
    if (typeof toolChoice === 'object') {
      const name = ((toolChoice.function as Record<string, unknown> | undefined) || {}).name as string | undefined;
      if (name) {
        return { type: 'tool', name };
      }
    }
    return { type: 'auto' };
  }

  private applyCacheControl(
    system: string | ProviderContentBlock[],
    messages: ProviderMessage[],
    tools: Record<string, unknown>[] | null,
  ): [string | ProviderContentBlock[], ProviderMessage[], Record<string, unknown>[] | null] {
    const marker = { type: 'ephemeral' } as const;

    let newSystem: string | ProviderContentBlock[] = system;
    if (typeof system === 'string' && system) {
      newSystem = [{ type: 'text', text: system, cache_control: marker } as unknown as ProviderContentBlock];
    } else if (Array.isArray(system) && system.length > 0) {
      newSystem = [...system];
      const last = { ...newSystem[newSystem.length - 1], cache_control: marker };
      newSystem[newSystem.length - 1] = last;
    }

    const newMsgs = [...messages];
    if (newMsgs.length >= 3) {
      const m = newMsgs[newMsgs.length - 2];
      const c = m.content;
      if (typeof c === 'string') {
        newMsgs[newMsgs.length - 2] = {
          ...m,
          content: [{ type: 'text', text: c, cache_control: marker } as unknown as ProviderContentBlock],
        };
      } else if (Array.isArray(c) && c.length > 0) {
        const nc = [...c];
        nc[nc.length - 1] = { ...nc[nc.length - 1], cache_control: marker };
        newMsgs[newMsgs.length - 2] = { ...m, content: nc };
      }
    }

    let newTools = tools;
    if (tools) {
      newTools = [...tools];
      const indices = this.toolCacheMarkerIndices(newTools);
      for (const idx of indices) {
        newTools[idx] = { ...newTools[idx], cache_control: marker };
      }
    }

    return [newSystem, newMsgs, newTools];
  }

  private toolCacheMarkerIndices(tools: Record<string, unknown>[]): number[] {
    if (tools.length === 0) return [];
    const tailIdx = tools.length - 1;
    let lastBuiltinIdx: number | null = null;
    for (let i = tailIdx; i >= 0; i--) {
      const name = this.toolName(tools[i]);
      if (!name.startsWith('mcp_')) {
        lastBuiltinIdx = i;
        break;
      }
    }

    const orderedUnique: number[] = [];
    for (const idx of [lastBuiltinIdx, tailIdx]) {
      if (idx !== null && !orderedUnique.includes(idx)) {
        orderedUnique.push(idx);
      }
    }
    return orderedUnique;
  }

  private toolName(tool: Record<string, unknown>): string {
    const name = tool.name;
    if (typeof name === 'string') return name;
    const fn = tool.function as Record<string, unknown> | undefined;
    if (typeof fn === 'object' && fn !== null) {
      const fname = fn.name;
      if (typeof fname === 'string') return fname;
    }
    return '';
  }

  private buildKwargs(
    messages: ProviderMessage[],
    tools: ProviderToolDefinition[],
    runtime: LLMRuntime,
    options?: {
      temperature?: number;
      max_tokens?: number;
      reasoning_effort?: string | null;
    },
    supportsCaching: boolean = true,
  ): Record<string, unknown> {
    const modelName = AnthropicProvider.stripPrefix(runtime.model || this.defaultModel);
    const [system, anthropicMsgs] = this.convertMessages(messages);
    const anthropicTools = AnthropicProvider.convertTools(tools);

    let finalSystem = system;
    let finalMsgs = anthropicMsgs;
    let finalTools = anthropicTools;

    if (supportsCaching) {
      [finalSystem, finalMsgs, finalTools] = this.applyCacheControl(
        system,
        anthropicMsgs,
        anthropicTools,
      );
    }

    const maxTokens = Math.max(1, options?.max_tokens ?? runtime.max_tokens);
    const reasoningEffort = options?.reasoning_effort ?? runtime.reasoning_effort;
    const thinkingEnabled = Boolean(reasoningEffort) && (reasoningEffort as string).toLowerCase() !== 'none';

    const modelLower = modelName.toLowerCase();
    const omitTemperature = ['opus-4-7', 'opus-4-8', 'sonnet-5', 'fable'].some(m => modelLower.includes(m));

    const kwargs: Record<string, unknown> = {
      model: modelName,
      messages: finalMsgs,
      max_tokens: maxTokens,
    };

    if (finalSystem) {
      kwargs.system = finalSystem;
    }

    if (reasoningEffort === 'adaptive') {
      kwargs.thinking = { type: 'adaptive' };
      if (!omitTemperature) {
        kwargs.temperature = 1.0;
      }
    } else if (thinkingEnabled) {
      const budgetMap: Record<string, number> = { low: 1024, medium: 4096, high: Math.max(8192, maxTokens) };
      const budget = budgetMap[(reasoningEffort as string).toLowerCase()] ?? 4096;
      kwargs.thinking = { type: 'enabled', budget_tokens: budget };
      kwargs.max_tokens = Math.max(maxTokens, budget + 4096);
      if (!omitTemperature) {
        kwargs.temperature = 1.0;
      }
    } else if (!omitTemperature) {
      kwargs.temperature = options?.temperature ?? runtime.temperature;
    }

    if (finalTools && finalTools.length > 0) {
      kwargs.tools = finalTools;
      const tc = AnthropicProvider.convertToolChoice('auto', thinkingEnabled);
      if (tc) {
        kwargs.tool_choice = tc;
      }
    }

    return kwargs;
  }

  private parseResponse(data: Record<string, unknown>): LLMResponse {
    const contentParts: string[] = [];
    const toolCalls: ToolCallRequest[] = [];
    const thinkingBlocks: Record<string, unknown>[] = [];
    const seenToolIds = new Set<string>();

    const content = (data.content as Record<string, unknown>[] | undefined) || [];
    for (const block of content) {
      if (block.type === 'text') {
        contentParts.push(block.text as string);
      } else if (block.type === 'tool_use') {
        let toolId = String(block.id || genToolId());
        if (seenToolIds.has(toolId)) {
          const originalId = toolId;
          while (seenToolIds.has(toolId)) {
            toolId = genToolId();
          }
          logger.warn({ original_id: originalId, new_id: toolId }, 'Remapping duplicate tool_use id from response');
        }
        seenToolIds.add(toolId);
        toolCalls.push({
          id: toolId,
          name: block.name as string,
          arguments: block.input,
        });
      } else if (block.type === 'thinking') {
        thinkingBlocks.push({
          type: 'thinking',
          thinking: block.thinking,
          signature: (block as Record<string, unknown>).signature ?? '',
        });
      }
    }

    const stopMap: Record<string, string> = {
      tool_use: 'tool_calls',
      end_turn: 'stop',
      max_tokens: 'length',
    };
    const stopReason = data.stop_reason as string | undefined;
    const finishReason = stopMap[stopReason || ''] || stopReason || 'stop';

    const usageRaw = data.usage as Record<string, number> | undefined;
    const inputTokens = usageRaw?.input_tokens ?? 0;
    const cacheCreation = usageRaw?.cache_creation_input_tokens ?? 0;
    const cacheRead = usageRaw?.cache_read_input_tokens ?? 0;
    const totalPromptTokens = inputTokens + cacheCreation + cacheRead;
    const outputTokens = usageRaw?.output_tokens ?? 0;

    const usage = {
      input_tokens: totalPromptTokens,
      output_tokens: outputTokens,
      total_tokens: totalPromptTokens + outputTokens,
      cache_read_tokens: cacheRead || undefined,
      cache_write_tokens: cacheCreation || undefined,
    };

    return {
      content: contentParts.length > 0 ? contentParts.join('') : null,
      tool_calls: toolCalls,
      stop_reason: finishReason,
      usage,
      model: data.model as string,
      raw: data,
      reasoning_content: thinkingBlocks.length > 0
        ? thinkingBlocks.map(b => (b as Record<string, unknown>).thinking as string).join('')
        : undefined,
    };
  }

  private static isStreamingRequiredError(e: Error): boolean {
    return e instanceof Error && e.message.toLowerCase().includes('streaming is required');
  }

  async complete(
    messages: ProviderMessage[],
    tools: ProviderToolDefinition[],
    runtime: LLMRuntime,
    options?: {
      temperature?: number;
      max_tokens?: number;
      reasoning_effort?: string | null;
    },
  ): Promise<LLMResponse> {
    const body = this.buildKwargs(messages, tools, runtime, options);
    try {
      const response = await this.client.post('/v1/messages', body);
      return this.parseResponse(response.data);
    } catch (err: unknown) {
      const error = err as Error;
      if (AnthropicProvider.isStreamingRequiredError(error)) {
        return this.stream(messages, tools, runtime, async () => {}, options);
      }
      logger.error({ err: error.message }, 'Anthropic provider request failed');
      throw error;
    }
  }

  async stream(
    messages: ProviderMessage[],
    tools: ProviderToolDefinition[],
    runtime: LLMRuntime,
    onDelta: StreamCallback,
    options?: {
      temperature?: number;
      max_tokens?: number;
      reasoning_effort?: string | null;
    },
  ): Promise<StreamResult> {
    const body = {
      ...this.buildKwargs(messages, tools, runtime, options),
      stream: true,
    };

    const timeoutMs = resolveStreamIdleTimeoutS() * 1000;
    let content = '';
    let reasoningContent = '';
    const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
    const thinkingBlocks: Record<string, unknown>[] = [];
    let usage: Record<string, number> = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    let stopReason = '';
    let model = runtime.model;

    try {
      const response = await this.client.post('/v1/messages', body, {
        responseType: 'stream',
        timeout: timeoutMs,
        headers: {
          'Accept': 'text/event-stream',
        },
      });

      const stream = response.data as NodeJS.ReadableStream;
      let buffer = '';
      const toolBlocks = new Map<number, { call_id: string; name: string }>();

      await new Promise<void>((resolve, reject) => {
        stream.on('data', async (chunk: Buffer) => {
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;

            const data = trimmed.slice(6);
            if (data === '[DONE]') {
              resolve();
              return;
            }

            try {
              const parsed = JSON.parse(data);
              const eventType = parsed.type;

              if (parsed.model) {
                model = parsed.model;
              }

              if (eventType === 'content_block_start') {
                const block = parsed.content_block;
                const index = parsed.index ?? 0;
                if (block?.type === 'tool_use') {
                  toolBlocks.set(index, {
                    call_id: String(block.id || ''),
                    name: String(block.name || ''),
                  });
                  toolCalls.set(index, {
                    id: String(block.id || ''),
                    name: String(block.name || ''),
                    arguments: '',
                  });
                  await onDelta({
                    tool_call_delta: {
                      id: String(block.id || ''),
                      name: String(block.name || ''),
                      arguments_delta: '',
                    },
                  });
                }
              } else if (eventType === 'content_block_delta') {
                const delta = parsed.delta;
                const index = parsed.index ?? 0;
                if (delta?.type === 'thinking_delta') {
                  const piece = delta.thinking || '';
                  if (piece) {
                    reasoningContent += piece;
                    await onDelta({ reasoning_delta: piece });
                  }
                } else if (delta?.type === 'text_delta') {
                  const text = delta.text || '';
                  if (text) {
                    content += text;
                    await onDelta({ text_delta: text });
                  }
                } else if (delta?.type === 'input_json_delta') {
                  const partial = delta.partial_json || '';
                  if (partial) {
                    const existing = toolCalls.get(index);
                    if (existing) {
                      existing.arguments += partial;
                    }
                    const state = toolBlocks.get(index) || { call_id: '', name: '' };
                    await onDelta({
                      tool_call_delta: {
                        id: state.call_id,
                        name: state.name,
                        arguments_delta: partial,
                      },
                    });
                  }
                }
              } else if (eventType === 'message_delta') {
                if (parsed.delta?.stop_reason) {
                  stopReason = parsed.delta.stop_reason;
                }
                if (parsed.usage) {
                  const u = parsed.usage;
                  const inputTokens = u.input_tokens || 0;
                  const cacheRead = u.cache_read_input_tokens || 0;
                  const cacheWrite = u.cache_creation_input_tokens || 0;
                  usage = {
                    input_tokens: inputTokens + cacheRead + cacheWrite,
                    output_tokens: u.output_tokens || 0,
                    total_tokens: (inputTokens + cacheRead + cacheWrite) + (u.output_tokens || 0),
                    cache_read_tokens: cacheRead || undefined,
                    cache_write_tokens: cacheWrite || undefined,
                  };
                }
              } else if (eventType === 'message_stop') {
                resolve();
              }
            } catch (parseErr) {
              logger.warn({ err: parseErr, data }, 'Failed to parse SSE data');
            }
          }
        });

        stream.on('end', () => resolve());
        stream.on('error', (err) => reject(err));
      });

      const finalToolCalls: ToolCallRequest[] = [];
      for (let i = 0; i < toolCalls.size; i++) {
        const tc = toolCalls.get(i);
        if (tc) {
          finalToolCalls.push({
            id: tc.id,
            name: tc.name,
            arguments: parseToolArguments(tc.arguments),
          });
        }
      }

      const stopMap: Record<string, string> = {
        tool_use: 'tool_calls',
        end_turn: 'stop',
        max_tokens: 'length',
      };

      return {
        content,
        reasoning_content: reasoningContent || undefined,
        tool_calls: finalToolCalls,
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          total_tokens: usage.total_tokens,
          cache_read_tokens: usage.cache_read_tokens,
          cache_write_tokens: usage.cache_write_tokens,
        },
        stop_reason: stopMap[stopReason] || stopReason || 'stop',
        model,
      };
    } catch (err) {
      logger.error({ err }, 'Anthropic provider stream failed');
      throw err;
    }
  }
}
