import type {
  Model,
  Context,
  SimpleStreamOptions,
  StreamEvent,
  StreamResult,
  AssistantMessage,
  ContentBlock,
  TextContent,
  ToolCallContent,
  ThinkingContent,
  Usage,
} from './types';
import { createEmptyUsage, createEmptyAssistantMessage } from './types';
import { retry, ok, isRetryableHttpStatus } from './retry';
import { normalizeResponseError } from './error-body';
import { parseSSEEvents } from './sse-parser';

// ─── API 密钥解析 ──────────────────────────────────────────────────

function resolveApiKey(model: Model, options: SimpleStreamOptions): string | undefined {
  if (options.apiKey) return options.apiKey;
  const env = options.env ?? (typeof process !== 'undefined' ? process.env : {});
  if (!env) return undefined;
  if (env['ANTHROPIC_API_KEY']) return env['ANTHROPIC_API_KEY'];
  if (env['ANTHROPIC_OAUTH_TOKEN']) return env['ANTHROPIC_OAUTH_TOKEN'];
  return undefined;
}

// ─── Context -> Anthropic 消息 ─────────────────────────────────────

interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  source?: { type: string; media_type: string; data: string };
}

function toAnthropicMessages(context: Context): { system: string | undefined; messages: unknown[] } {
  const messages: unknown[] = [];
  for (const msg of context.messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        messages.push({ role: 'user', content: msg.content });
      } else {
        const blocks: AnthropicContentBlock[] = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            blocks.push({ type: 'text', text: block.text });
          } else if (block.type === 'image') {
            blocks.push({
              type: 'image',
              source: { type: 'base64', media_type: block.mimeType, data: block.data },
            });
          }
        }
        messages.push({ role: 'user', content: blocks });
      }
    } else if (msg.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          blocks.push({ type: 'text', text: block.text });
        } else if (block.type === 'toolCall') {
          blocks.push({ type: 'tool_use', id: block.id, name: block.name, input: block.arguments });
        } else if (block.type === 'thinking') {
          blocks.push({ type: 'thinking', thinking: block.thinking });
        }
      }
      messages.push({ role: 'assistant', content: blocks });
    } else if (msg.role === 'toolResult') {
      const content = msg.content
        .filter((b): b is TextContent => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: msg.toolCallId, content, is_error: msg.isError }],
      });
    }
  }
  return { system: context.systemPrompt, messages };
}

function toAnthropicTools(context: Context): unknown[] | undefined {
  if (!context.tools || context.tools.length === 0) return undefined;
  return context.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

// ─── 用量统计 ──────────────────────────────────────────────────────

function buildUsage(inputTokens: number, outputTokens: number, model: Model, cacheReadTokens?: number): Usage {
  const usage = createEmptyUsage();
  usage.input = inputTokens;
  usage.output = outputTokens;
  usage.total = inputTokens + outputTokens;
  if (cacheReadTokens) usage.cacheRead = cacheReadTokens;
  const perMillion = (n: number) => n / 1_000_000;
  usage.cost.input = perMillion(inputTokens) * (model.cost?.input ?? 0);
  usage.cost.output = perMillion(outputTokens) * (model.cost?.output ?? 0);
  usage.cost.total = usage.cost.input + usage.cost.output;
  if (cacheReadTokens) {
    usage.cost.cacheRead = perMillion(cacheReadTokens) * (model.cost?.cacheRead ?? 0);
  }
  return usage;
}

// ─── Anthropic 的流式运行器 ─────────────────────────────────────────

async function* runStream(
  model: Model,
  context: Context,
  options: SimpleStreamOptions,
): AsyncGenerator<StreamEvent> {
  const apiKey = resolveApiKey(model, options);
  if (!apiKey) {
    const error = createEmptyAssistantMessage();
    error.model = model.id;
    error.provider = model.provider;
    error.stopReason = 'error';
    error.errorMessage = 'No API key found for Anthropic (ANTHROPIC_API_KEY)';
    yield { type: 'error', reason: 'error', error };
    return;
  }

  const baseUrl = (model.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  const url = `${baseUrl}/v1/messages`;
  const { system, messages } = toAnthropicMessages(context);
  const tools = toAnthropicTools(context);

  const body: Record<string, unknown> = {
    model: model.id,
    messages,
    max_tokens: options.maxTokens ?? model.maxTokens,
    stream: true,
  };
  if (system) body.system = system;
  if (tools) body.tools = tools;
  if (options.temperature !== undefined) body.temperature = options.temperature;

  // 思考/推理支持
  if (model.reasoning && options.reasoning) {
    const budgetMap: Record<string, number> = {
      minimal: 1024,
      low: 2048,
      medium: 4096,
      high: 8192,
      xhigh: 16384,
      max: 32768,
    };
    const budget = budgetMap[options.reasoning] ?? 4096;
    body.thinking = { type: 'enabled', budget_tokens: budget };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    ...(model.headers ?? {}),
    ...(options.headers ?? {}),
  };

  if (options.env?.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_OAUTH_TOKEN) {
    headers['authorization'] = `Bearer ${options.env?.ANTHROPIC_OAUTH_TOKEN ?? process.env.ANTHROPIC_OAUTH_TOKEN}`;
    delete headers['x-api-key'];
  }

  options.onPayload?.(body);

  // ── 带重试的 HTTP 请求 ──────────────────────────────────────────
  let response: Response;
  try {
    response = await retry(async (attempt) => {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      });
      if (!res.ok && isRetryableHttpStatus(res.status)) {
        throw res;
      }
      return ok(res);
    });
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || options.signal?.aborted;
    const error = createEmptyAssistantMessage();
    error.model = model.id;
    error.provider = model.provider;
    error.stopReason = aborted ? 'aborted' : 'error';
    error.errorMessage = aborted ? 'Request aborted' : String(e?.message ?? e);
    yield { type: 'error', reason: aborted ? 'aborted' : 'error', error };
    return;
  }

  options.onResponse?.(response);

  if (!response.ok) {
    const normalized = await normalizeResponseError(response);
    const error = createEmptyAssistantMessage();
    error.model = model.id;
    error.provider = model.provider;
    error.stopReason = 'error';
    error.errorMessage = `Anthropic API error ${response.status}: ${normalized.message}`;
    yield { type: 'error', reason: 'error', error };
    return;
  }

  if (!response.body) {
    const error = createEmptyAssistantMessage();
    error.model = model.id;
    error.provider = model.provider;
    error.stopReason = 'error';
    error.errorMessage = 'Response has no body';
    yield { type: 'error', reason: 'error', error };
    return;
  }

  // 构建部分助手消息
  const partial: AssistantMessage = createEmptyAssistantMessage();
  partial.model = model.id;
  partial.provider = model.provider;
  const content: ContentBlock[] = partial.content;

  yield { type: 'start', partial };

  // 按索引追踪 content 块
  const blockMap = new Map<number, { type: string; contentIndex: number; argsRaw: string }>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens: number | undefined;
  let responseId: string | undefined;
  let stopReason = 'stop';
  let streamDone = false;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) {
        streamDone = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      // 解析完整的 SSE 块，将不完整的尾部保留在 buffer 中
      const { events, remaining } = parseSSEEvents(buffer);
      buffer = remaining;

      for (const evt of events) {
        let data: any;
        try { data = JSON.parse(evt.data ?? ''); } catch { continue; }
        const eventType = evt.event ?? 'message';

        switch (eventType) {
          case 'message_start': {
            responseId = data?.message?.id;
            if (data?.message?.usage) {
              inputTokens = data.message.usage.input_tokens ?? 0;
              cacheReadTokens = data.message.usage.cache_read_input_tokens;
            }
            break;
          }

          case 'content_block_start': {
            const idx = data?.index ?? 0;
            const blockType = data?.content_block?.type ?? 'text';

            if (blockType === 'text') {
              const contentIndex = content.length;
              content.push({ type: 'text', text: '' });
              blockMap.set(idx, { type: 'text', contentIndex, argsRaw: '' });
              yield { type: 'text_start', contentIndex };
            } else if (blockType === 'tool_use') {
              const contentIndex = content.length;
              const tcBlock: ToolCallContent = {
                type: 'toolCall',
                id: data.content_block.id ?? '',
                name: data.content_block.name ?? '',
                arguments: {},
              };
              content.push(tcBlock);
              blockMap.set(idx, { type: 'tool_use', contentIndex, argsRaw: '' });
              yield { type: 'toolcall_start', contentIndex };
            } else if (blockType === 'thinking') {
              const contentIndex = content.length;
              content.push({ type: 'thinking', thinking: '' });
              blockMap.set(idx, { type: 'thinking', contentIndex, argsRaw: '' });
              yield { type: 'thinking_start', contentIndex };
            }
            break;
          }

          case 'content_block_delta': {
            const idx = data?.index ?? 0;
            const info = blockMap.get(idx);
            if (!info) break;
            const delta = data?.delta;
            if (!delta) break;

            if (delta.type === 'text_delta' && info.type === 'text') {
              (content[info.contentIndex] as TextContent).text += delta.text;
              yield { type: 'text_delta', delta: delta.text, contentIndex: info.contentIndex };
            } else if (delta.type === 'input_json_delta' && info.type === 'tool_use') {
              info.argsRaw += delta.partial_json ?? '';
              const block = content[info.contentIndex] as ToolCallContent;
              try {
                block.arguments = JSON.parse(info.argsRaw);
              } catch {
                try {
                  block.arguments = JSON.parse(info.argsRaw + '}');
                } catch {
                  // keep previous
                }
              }
              yield {
                type: 'toolcall_delta',
                delta: delta.partial_json ?? '',
                partial,
                contentIndex: info.contentIndex,
              };
            } else if (delta.type === 'thinking_delta' && info.type === 'thinking') {
              (content[info.contentIndex] as ThinkingContent).thinking += delta.thinking;
              yield { type: 'thinking_delta', delta: delta.thinking, contentIndex: info.contentIndex };
            }
            break;
          }

          case 'content_block_stop': {
            const idx = data?.index ?? 0;
            const info = blockMap.get(idx);
            if (!info) break;

            if (info.type === 'text') {
              yield {
                type: 'text_end',
                content: (content[info.contentIndex] as TextContent).text,
                contentIndex: info.contentIndex,
              };
            } else if (info.type === 'tool_use') {
              const block = content[info.contentIndex] as ToolCallContent;
              try {
                block.arguments = JSON.parse(info.argsRaw);
              } catch {
                // keep partial
              }
              yield { type: 'toolcall_end', toolCall: block, contentIndex: info.contentIndex };
            } else if (info.type === 'thinking') {
              yield {
                type: 'thinking_end',
                content: (content[info.contentIndex] as ThinkingContent).thinking,
                contentIndex: info.contentIndex,
              };
            }
            break;
          }

          case 'message_delta': {
            if (data?.delta?.stop_reason) {
              stopReason = data.delta.stop_reason;
            }
            if (data?.usage) {
              outputTokens = data.usage.output_tokens ?? outputTokens;
            }
            break;
          }

          case 'message_stop': {
            streamDone = true;
            break;
          }
        }
      }
    }
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || options.signal?.aborted;
    partial.stopReason = aborted ? 'aborted' : 'error';
    partial.errorMessage = aborted ? 'Stream aborted' : String(e?.message ?? e);
    partial.usage = buildUsage(inputTokens, outputTokens, model, cacheReadTokens);
    partial.responseId = responseId;
    yield { type: 'error', reason: aborted ? 'aborted' : 'error', error: partial };
    return;
  }

  // 映射 Anthropic 的结束原因
  const mappedStopReason = stopReason === 'end_turn' ? 'stop'
    : stopReason === 'max_tokens' ? 'length'
    : stopReason === 'tool_use' ? 'toolUse'
    : stopReason;

  partial.stopReason = mappedStopReason;
  partial.usage = buildUsage(inputTokens, outputTokens, model, cacheReadTokens);
  partial.responseId = responseId;

  yield { type: 'done', reason: mappedStopReason, message: partial };
}

// ─── 公开 API ──────────────────────────────────────────────────────

export function streamAnthropic(
  model: Model,
  context: Context,
  options: SimpleStreamOptions = {},
): StreamResult {
  let finalMessage: AssistantMessage = createEmptyAssistantMessage();
  let generator: AsyncGenerator<StreamEvent> | null = null;

  const getGenerator = (): AsyncGenerator<StreamEvent> => {
    if (!generator) {
      generator = runStream(model, context, options);
    }
    return generator;
  };

  const stream: StreamResult = {
    [Symbol.asyncIterator]() {
      return getGenerator();
    },
    async result(): Promise<AssistantMessage> {
      const gen = getGenerator();
      for await (const event of gen) {
        if (event.type === 'done') {
          finalMessage = event.message;
        } else if (event.type === 'error') {
          finalMessage = event.error;
        }
      }
      return finalMessage;
    },
  };

  return stream;
}
