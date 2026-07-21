import { AgentHook, AgentHookContext } from './hook.js';
import { ToolCallRequest } from '../providers/base.js';
import { stripReasoningTags } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

export interface ProgressOptions {
  tool_hint?: boolean;
  tool_events?: unknown[];
  reasoning?: boolean;
  reasoning_end?: boolean;
  file_edit_events?: unknown[];
  [key: string]: unknown;
}

export type ProgressCallback = (
  content: string,
  options?: ProgressOptions,
) => Promise<void>;

export interface ToolEventPayload {
  id: string;
  name: string;
  status: 'start' | 'end' | 'error';
  detail?: string;
  error?: string;
}

function buildToolEventStartPayload(toolCall: ToolCallRequest): ToolEventPayload {
  return {
    id: toolCall.id,
    name: toolCall.name,
    status: 'start',
  };
}

function buildToolEventFinishPayloads(
  toolEvents: Array<{ name: string; id: string; status: string; result?: string; error?: string }>,
): ToolEventPayload[] {
  return toolEvents.map(event => ({
    id: event.id,
    name: event.name,
    status: event.status === 'failed' ? 'error' : 'end',
    detail: event.result,
    error: event.error,
  }));
}

function formatToolHints(toolCalls: ToolCallRequest[], maxLength: number): string {
  if (toolCalls.length === 0) return '';
  const names = toolCalls.map(tc => tc.name).join(', ');
  if (names.length <= maxLength) return names;
  return names.slice(0, maxLength - 3) + '...';
}

export class AgentProgressHook extends AgentHook {
  private _onProgress: ProgressCallback | null;
  private _onStream: ((delta: string) => Promise<void>) | null;
  private _onStreamEnd: ((options?: { resuming?: boolean }) => Promise<void>) | null;
  private _sessionKey: string | null;
  private _toolHintMaxLength: number;
  private _onIteration: ((iteration: number) => void) | null;
  private _streamBuf = '';
  private _reasoningOpen = false;

  constructor(options: {
    onProgress?: ProgressCallback | null;
    onStream?: ((delta: string) => Promise<void>) | null;
    onStreamEnd?: ((options?: { resuming?: boolean }) => Promise<void>) | null;
    sessionKey?: string | null;
    toolHintMaxLength?: number;
    onIteration?: ((iteration: number) => void) | null;
  } = {}) {
    super();
    this._onProgress = options.onProgress ?? null;
    this._onStream = options.onStream ?? null;
    this._onStreamEnd = options.onStreamEnd ?? null;
    this._sessionKey = options.sessionKey ?? null;
    this._toolHintMaxLength = options.toolHintMaxLength ?? 40;
    this._onIteration = options.onIteration ?? null;
  }

  wantsStreaming(): boolean {
    return this._onStream !== null;
  }

  private static _stripThink(text: string | null | undefined): string | null {
    if (!text) return null;
    const stripped = stripReasoningTags(text);
    return stripped || null;
  }

  private _toolHint(toolCalls: ToolCallRequest[]): string {
    return formatToolHints(toolCalls, this._toolHintMaxLength);
  }

  async onStreamDelta(_context: AgentHookContext, delta: string): Promise<void> {
    const prevClean = stripReasoningTags(this._streamBuf);
    this._streamBuf += delta;
    const newClean = stripReasoningTags(this._streamBuf);
    const incremental = newClean.slice(prevClean.length);

    if (incremental) {
      await this._emitReasoningEnd();
      if (this._onStream) {
        await this._onStream(incremental);
      }
    }
  }

  async onStreamEnd(_context: AgentHookContext): Promise<void> {
    await this._emitReasoningEnd();
    if (this._onStreamEnd) {
      await this._onStreamEnd();
    }
    this._streamBuf = '';
  }

  async onTurnStart(context: AgentHookContext): Promise<void> {
    if (this._onIteration) {
      this._onIteration(0);
    }
    logger.debug(
      { session_key: this._sessionKey },
      'Starting agent turn',
    );
  }

  async onToolStart(context: AgentHookContext & { tool_name: string; tool_call_id: string; arguments?: unknown }): Promise<void> {
    if (this._onProgress) {
      const toolHint = AgentProgressHook._stripThink(this._toolHint([{
        id: context.tool_call_id,
        name: context.tool_name,
        arguments: context.arguments,
      } as ToolCallRequest]));
      const toolEvents = [buildToolEventStartPayload({
        id: context.tool_call_id,
        name: context.tool_name,
        arguments: context.arguments,
      } as ToolCallRequest)];
      if (toolHint) {
        await this._onProgress(toolHint, {
          tool_hint: true,
          tool_events: toolEvents,
        });
      }
    }
    logger.info(
      { tool: context.tool_name },
      'Tool call',
    );
  }

  async onToolEnd(context: AgentHookContext & { tool_name: string; tool_call_id: string; result?: string }): Promise<void> {
    if (this._onProgress) {
      const toolEvents = buildToolEventFinishPayloads([{
        name: context.tool_name,
        id: context.tool_call_id,
        status: 'completed',
        result: context.result,
      }]);
      if (toolEvents.length > 0) {
        await this._onProgress('', {
          tool_hint: false,
          tool_events: toolEvents,
        });
      }
    }
  }

  async onToolError(context: AgentHookContext & { tool_name: string; tool_call_id: string; error?: string }): Promise<void> {
    if (this._onProgress) {
      const toolEvents = buildToolEventFinishPayloads([{
        name: context.tool_name,
        id: context.tool_call_id,
        status: 'failed',
        error: context.error,
      }]);
      if (toolEvents.length > 0) {
        await this._onProgress('', {
          tool_hint: false,
          tool_events: toolEvents,
        });
      }
    }
  }

  private async _emitReasoning(reasoningContent: string | null): Promise<void> {
    if (this._onProgress && reasoningContent) {
      this._reasoningOpen = true;
      await this._onProgress(reasoningContent, { reasoning: true });
    }
  }

  private async _emitReasoningEnd(): Promise<void> {
    if (this._reasoningOpen && this._onProgress) {
      this._reasoningOpen = false;
      await this._onProgress('', { reasoning_end: true });
    } else {
      this._reasoningOpen = false;
    }
  }

  finalizeContent(_context: AgentHookContext, content: string | null): string | null {
    return AgentProgressHook._stripThink(content);
  }
}
