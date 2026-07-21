import { Readable } from 'stream';
import {
  ToolCallRequest,
  parseToolArguments,
  TokenUsage,
} from '../base.js';
import { logger } from '../../utils/logger.js';

export const FINISH_REASON_MAP: Record<string, string> = {
  completed: 'stop',
  incomplete: 'length',
  failed: 'error',
  cancelled: 'error',
};

export function mapFinishReason(status: string | null | undefined): string {
  return FINISH_REASON_MAP[status || 'completed'] || 'stop';
}

function usageFromResponseObj(response: Record<string, unknown>): TokenUsage {
  const usageRaw = response.usage as Record<string, unknown> | undefined;
  if (!usageRaw) {
    return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  }
  const promptTokens = Number(usageRaw.input_tokens ?? usageRaw.prompt_tokens ?? 0);
  const completionTokens = Number(usageRaw.output_tokens ?? usageRaw.completion_tokens ?? 0);
  const totalTokens = Number(usageRaw.total_tokens ?? promptTokens + completionTokens);
  return {
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

function parseToolCallArguments(argsRaw: unknown, name: string | null | undefined): unknown {
  const parsed = parseToolArguments(argsRaw);
  if (parsed === argsRaw && typeof argsRaw === 'string' && argsRaw.trim()) {
    logger.warn({ name, args: argsRaw.slice(0, 200) }, 'Failed to parse tool call arguments');
  }
  return parsed;
}

function toolArgumentsSource(...values: unknown[]): string {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return String(value);
  }
  return '{}';
}

export async function* iterSse(stream: Readable): AsyncGenerator<Record<string, unknown>, void, undefined> {
  let buffer: string[] = [];

  function flush(): Record<string, unknown> | null {
    const dataLines = buffer
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim());
    buffer = [];
    if (dataLines.length === 0) return null;
    const data = dataLines.join('\n').trim();
    if (!data || data === '[DONE]') return null;
    try {
      return JSON.parse(data);
    } catch {
      logger.warn({ data: data.slice(0, 200) }, 'Failed to parse SSE event JSON');
      return null;
    }
  }

  for await (const chunk of stream) {
    const text = chunk.toString('utf-8');
    const lines = text.split('\n');
    for (const line of lines) {
      if (line === '') {
        if (buffer.length > 0) {
          const event = flush();
          if (event !== null) {
            yield event;
          }
        }
        continue;
      }
      buffer.push(line);
    }
  }

  if (buffer.length > 0) {
    const event = flush();
    if (event !== null) {
      yield event;
    }
  }
}

export async function consumeSse(
  stream: Readable,
  onContentDelta?: ((text: string) => Promise<void>) | null,
  onToolCallDelta?: ((delta: Record<string, unknown>) => Promise<void>) | null,
): Promise<[string, ToolCallRequest[], string, TokenUsage, string | null]> {
  return consumeSseWithReasoning(stream, onContentDelta, onToolCallDelta);
}

export async function consumeSseWithReasoning(
  stream: Readable,
  onContentDelta?: ((text: string) => Promise<void>) | null,
  onToolCallDelta?: ((delta: Record<string, unknown>) => Promise<void>) | null,
  onReasoningDelta?: ((text: string) => Promise<void>) | null,
): Promise<[string, ToolCallRequest[], string, TokenUsage, string | null]> {
  let content = '';
  const toolCalls: ToolCallRequest[] = [];
  const toolCallBuffers: Map<string, Record<string, unknown>> = new Map();
  const toolCallArgsEmitted = new Set<string>();
  let finishReason = 'stop';
  let usage: TokenUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let reasoningContent: string | null = null;
  let streamedReasoning = false;

  for await (const event of iterSse(stream)) {
    const eventType = event.type as string | undefined;

    if (eventType === 'response.output_item.added') {
      const item = (event.item as Record<string, unknown> | undefined) || {};
      if (item.type === 'function_call') {
        const callId = item.call_id as string | undefined;
        if (!callId) continue;
        const args = item.arguments;
        toolCallBuffers.set(callId, {
          id: item.id ?? 'fc_0',
          name: item.name,
          arguments: args === null || args === undefined ? '' : args,
        });
        if (onToolCallDelta) {
          await onToolCallDelta({
            call_id: String(callId),
            name: String(item.name ?? ''),
            arguments_delta: '',
          });
        }
      }
    } else if (eventType === 'response.output_text.delta') {
      const deltaText = (event.delta as string) || '';
      content += deltaText;
      if (onContentDelta && deltaText) {
        await onContentDelta(deltaText);
      }
    } else if (eventType === 'response.reasoning_summary_text.delta') {
      const deltaText = (event.delta as string) || '';
      if (deltaText) {
        reasoningContent = (reasoningContent || '') + deltaText;
        streamedReasoning = true;
        if (onReasoningDelta) {
          await onReasoningDelta(deltaText);
        }
      }
    } else if (eventType === 'response.reasoning_summary_text.done') {
      const text = (event.text as string) || '';
      if (text && !streamedReasoning && !reasoningContent) {
        reasoningContent = text;
        if (onReasoningDelta) {
          await onReasoningDelta(text);
        }
      }
    } else if (eventType === 'response.reasoning_summary_part.done') {
      const part = (event.part as Record<string, unknown> | undefined) || {};
      const text = part.type === 'summary_text' ? (part.text as string | undefined) : undefined;
      if (text && !streamedReasoning && !reasoningContent) {
        reasoningContent = text;
        if (onReasoningDelta) {
          await onReasoningDelta(text);
        }
      }
    } else if (eventType === 'response.function_call_arguments.delta') {
      const callId = event.call_id as string | undefined;
      if (callId && toolCallBuffers.has(callId)) {
        const delta = (event.delta as string) || '';
        const buf = toolCallBuffers.get(callId)!;
        const current = typeof buf.arguments === 'string' ? buf.arguments : '';
        buf.arguments = current + delta;
        if (onToolCallDelta && delta) {
          await onToolCallDelta({
            call_id: String(callId),
            name: String(buf.name ?? ''),
            arguments_delta: String(delta),
          });
        }
      }
    } else if (eventType === 'response.function_call_arguments.done') {
      const callId = event.call_id as string | undefined;
      if (callId && toolCallBuffers.has(callId)) {
        const args = event.arguments;
        const buf = toolCallBuffers.get(callId)!;
        buf.arguments = args;
        if (onToolCallDelta) {
          toolCallArgsEmitted.add(String(callId));
          await onToolCallDelta({
            call_id: String(callId),
            name: String(buf.name ?? ''),
            arguments: args === null || args === undefined ? '' : String(args),
          });
        }
      }
    } else if (eventType === 'response.output_item.done') {
      const item = (event.item as Record<string, unknown> | undefined) || {};
      if (item.type === 'function_call') {
        const callId = item.call_id as string | undefined;
        if (!callId) continue;
        const buf = toolCallBuffers.get(callId) || {};
        const argsRaw = toolArgumentsSource(buf.arguments, item.arguments);
        if (onToolCallDelta && !toolCallArgsEmitted.has(String(callId))) {
          toolCallArgsEmitted.add(String(callId));
          await onToolCallDelta({
            call_id: String(callId),
            name: String(buf.name ?? item.name ?? ''),
            arguments: String(argsRaw),
          });
        }
        const args = parseToolCallArguments(argsRaw, buf.name as string | undefined || item.name as string | undefined);
        toolCalls.push({
          id: `${callId}|${buf.id ?? item.id ?? 'fc_0'}`,
          name: (buf.name as string | undefined) || (item.name as string) || '',
          arguments: args,
        });
      } else if (item.type === 'reasoning' && !reasoningContent) {
        const summary = extractReasoningSummaryFromOutput([item]);
        if (summary) {
          reasoningContent = summary;
          if (onReasoningDelta) {
            await onReasoningDelta(summary);
          }
        }
      }
    } else if (eventType === 'response.completed') {
      const responseObj = (event.response as Record<string, unknown> | undefined) || {};
      const status = responseObj.status as string | undefined;
      finishReason = mapFinishReason(status);
      const u = usageFromResponseObj(responseObj);
      if (u.total_tokens > 0) usage = u;
      if (!reasoningContent) {
        const output = (responseObj.output as Record<string, unknown>[] | undefined) || [];
        const summary = extractReasoningSummaryFromOutput(output);
        if (summary) {
          reasoningContent = summary;
          if (onReasoningDelta) {
            await onReasoningDelta(summary);
          }
        }
      }
    } else if (eventType === 'error' || eventType === 'response.failed') {
      const detail = event.error ?? event.message ?? JSON.stringify(event);
      throw new Error(`Response failed: ${String(detail).slice(0, 500)}`);
    }
  }

  return [content, toolCalls, finishReason, usage, reasoningContent];
}

function extractReasoningSummaryFromOutput(output: unknown): string | null {
  const parts: string[] = [];
  const items = Array.isArray(output) ? output : [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const itemObj = item as Record<string, unknown>;
    if (itemObj.type !== 'reasoning') continue;
    const summary = (itemObj.summary as Record<string, unknown>[] | undefined) || [];
    for (const s of summary) {
      if (typeof s !== 'object' || s === null) continue;
      const sObj = s as Record<string, unknown>;
      if (sObj.type === 'summary_text' && sObj.text) {
        parts.push(String(sObj.text));
      }
    }
  }
  return parts.length > 0 ? parts.join('') : null;
}

export function parseResponseOutput(response: Record<string, unknown>): {
  content: string | null;
  tool_calls: ToolCallRequest[];
  finish_reason: string;
  usage: TokenUsage;
  reasoning_content?: string | null;
} {
  const output = (response.output as Record<string, unknown>[] | undefined) || [];
  const contentParts: string[] = [];
  const toolCalls: ToolCallRequest[] = [];
  let reasoningContent: string | null = null;

  for (const item of output) {
    const itemType = item.type as string | undefined;
    if (itemType === 'message') {
      const content = (item.content as Record<string, unknown>[] | undefined) || [];
      for (const block of content) {
        if (block.type === 'output_text') {
          contentParts.push((block.text as string) || '');
        }
      }
    } else if (itemType === 'reasoning') {
      const summary = (item.summary as Record<string, unknown>[] | undefined) || [];
      for (const s of summary) {
        if (s.type === 'summary_text' && s.text) {
          reasoningContent = (reasoningContent || '') + String(s.text);
        }
      }
    } else if (itemType === 'function_call') {
      const callId = (item.call_id as string) || '';
      const itemId = (item.id as string) || 'fc_0';
      const argsRaw = toolArgumentsSource(item.arguments);
      const args = parseToolCallArguments(argsRaw, item.name as string | undefined);
      toolCalls.push({
        id: `${callId}|${itemId}`,
        name: (item.name as string) || '',
        arguments: args,
      });
    }
  }

  const usage = usageFromResponseObj(response);
  const status = response.status as string | undefined;
  const finishReason = mapFinishReason(status);

  return {
    content: contentParts.length > 0 ? contentParts.join('') : null,
    tool_calls: toolCalls,
    finish_reason: finishReason,
    usage,
    reasoning_content: reasoningContent,
  };
}

export async function consumeSdkStream(
  stream: AsyncIterable<Record<string, unknown>>,
  onContentDelta?: ((text: string) => Promise<void>) | null,
  onToolCallDelta?: ((delta: Record<string, unknown>) => Promise<void>) | null,
): Promise<[string, ToolCallRequest[], string, TokenUsage, string | null]> {
  let content = '';
  const toolCalls: ToolCallRequest[] = [];
  const toolCallBuffers: Map<string, Record<string, unknown>> = new Map();
  const toolCallArgsEmitted = new Set<string>();
  let finishReason = 'stop';
  let usage: TokenUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let reasoningContent: string | null = null;

  for await (const event of stream) {
    const eventType = event.type as string | undefined;

    if (eventType === 'response.output_item.added') {
      const item = event.item as Record<string, unknown> | undefined;
      if (item && item.type === 'function_call') {
        const callId = item.call_id as string | undefined;
        if (!callId) continue;
        const args = item.arguments;
        toolCallBuffers.set(callId, {
          id: item.id ?? 'fc_0',
          name: item.name,
          arguments: args === null || args === undefined ? '' : args,
        });
        if (onToolCallDelta) {
          await onToolCallDelta({
            call_id: String(callId),
            name: String(item.name ?? ''),
            arguments_delta: '',
          });
        }
      }
    } else if (eventType === 'response.output_text.delta') {
      const deltaText = (event.delta as string) || '';
      content += deltaText;
      if (onContentDelta && deltaText) {
        await onContentDelta(deltaText);
      }
    } else if (eventType === 'response.function_call_arguments.delta') {
      const callId = event.call_id as string | undefined;
      if (callId && toolCallBuffers.has(callId)) {
        const delta = (event.delta as string) || '';
        const buf = toolCallBuffers.get(callId)!;
        const current = typeof buf.arguments === 'string' ? buf.arguments : '';
        buf.arguments = current + delta;
        if (onToolCallDelta && delta) {
          await onToolCallDelta({
            call_id: String(callId),
            name: String(buf.name ?? ''),
            arguments_delta: String(delta),
          });
        }
      }
    } else if (eventType === 'response.function_call_arguments.done') {
      const callId = event.call_id as string | undefined;
      if (callId && toolCallBuffers.has(callId)) {
        const args = event.arguments;
        const buf = toolCallBuffers.get(callId)!;
        buf.arguments = args;
        if (onToolCallDelta) {
          toolCallArgsEmitted.add(String(callId));
          await onToolCallDelta({
            call_id: String(callId),
            name: String(buf.name ?? ''),
            arguments: args === null || args === undefined ? '' : String(args),
          });
        }
      }
    } else if (eventType === 'response.output_item.done') {
      const item = event.item as Record<string, unknown> | undefined;
      if (item && item.type === 'function_call') {
        const callId = item.call_id as string | undefined;
        if (!callId) continue;
        const buf = toolCallBuffers.get(callId) || {};
        const argsRaw = toolArgumentsSource(buf.arguments, item.arguments);
        if (onToolCallDelta && !toolCallArgsEmitted.has(String(callId))) {
          toolCallArgsEmitted.add(String(callId));
          await onToolCallDelta({
            call_id: String(callId),
            name: String(buf.name ?? item.name ?? ''),
            arguments: String(argsRaw),
          });
        }
        const args = parseToolCallArguments(argsRaw, (buf.name as string | undefined) || (item.name as string | undefined));
        toolCalls.push({
          id: `${callId}|${buf.id ?? item.id ?? 'fc_0'}`,
          name: (buf.name as string | undefined) || (item.name as string) || '',
          arguments: args,
        });
      }
    } else if (eventType === 'response.completed') {
      const resp = event.response as Record<string, unknown> | undefined;
      const status = resp?.status as string | undefined;
      finishReason = mapFinishReason(status);
      if (resp) {
        const usageObj = resp.usage as Record<string, unknown> | undefined;
        if (usageObj) {
          usage = {
            input_tokens: Number(usageObj.input_tokens ?? 0),
            output_tokens: Number(usageObj.output_tokens ?? 0),
            total_tokens: Number(usageObj.total_tokens ?? 0),
          };
        }
        const output = (resp.output as Record<string, unknown>[] | undefined) || [];
        for (const outItem of output) {
          if (outItem.type === 'reasoning') {
            const summary = (outItem.summary as Record<string, unknown>[] | undefined) || [];
            for (const s of summary) {
              if (s.type === 'summary_text' && s.text) {
                reasoningContent = (reasoningContent || '') + String(s.text);
              }
            }
          }
        }
      }
    } else if (eventType === 'error' || eventType === 'response.failed') {
      const detail = event.error ?? event.message ?? JSON.stringify(event);
      throw new Error(`Response failed: ${String(detail).slice(0, 500)}`);
    }
  }

  return [content, toolCalls, finishReason, usage, reasoningContent];
}
