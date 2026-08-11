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
import { resolveApiKey } from './credentials';
import {
  AgentError,
  AgentErrorCategory,
  classifyError,
  formatCategoryError,
  formatHttpError,
} from './errors';
import { parseSSEEvents } from './sse-parser';
import { getSyncPartialParser } from './json-parse';

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
  const apiKey = await resolveApiKey(model, options);
  // 兼容 Anthropic OAuth token（无 API key 时的替代凭证，下方 headers 使用）
  const oauthToken =
    options.env?.ANTHROPIC_OAUTH_TOKEN
    ?? (typeof process !== 'undefined' ? process.env.ANTHROPIC_OAUTH_TOKEN : undefined);
  if (!apiKey && !oauthToken) {
    const error = createEmptyAssistantMessage();
    error.model = model.id;
    error.provider = model.provider;
    error.stopReason = 'error';
    error.errorMessage = formatCategoryError(
      AgentErrorCategory.AUTH,
      'No API key found for Anthropic (ANTHROPIC_API_KEY)',
    );
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
    'anthropic-version': '2023-06-01',
    ...(model.headers ?? {}),
    ...(options.headers ?? {}),
  };
  // API key 与 OAuth token 二选一：无 API key 但存在 OAuth token 时不写 x-api-key
  if (oauthToken) {
    headers['authorization'] = `Bearer ${oauthToken}`;
  } else if (apiKey) {
    headers['x-api-key'] = apiKey;
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
    }, { onRetryAttempt: options.onRetryAttempt });
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || options.signal?.aborted;
    const error = createEmptyAssistantMessage();
    error.model = model.id;
    error.provider = model.provider;
    error.stopReason = aborted ? 'aborted' : 'error';
    if (aborted) {
      error.errorMessage = 'Request aborted';
    } else if (e?.status && typeof e.status === 'number') {
      // 重试后仍失败的 HTTP 错误；消费 body 文本（避免连接泄漏 + 提供可读信息）
      try {
        const normalized = await normalizeResponseError(e);
        error.errorMessage = formatHttpError(e.status, normalized.message, 'Anthropic API error');
      } catch {
        error.errorMessage = formatHttpError(
          e.status,
          e.statusText || `HTTP ${e.status}`,
          'Anthropic API error',
        );
      }
    } else {
      // 网络错误 / 超时 / 其他：按 AgentError 分类或消息模式打前缀
      const category = classifyError(e);
      error.errorMessage = formatCategoryError(category, String(e?.message ?? e));
    }
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
    error.errorMessage = formatHttpError(response.status, normalized.message, 'Anthropic API error');
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

  // 工具参数 JSON 解析（四级降级：JSON.parse → repair → partial-json）
  const parser = await getSyncPartialParser();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // 空闲超时：两次数据块之间超过 idleTimeoutMs 视为断流，避免半开连接永久挂起。
  // 总超时（timeoutMs）：整个流式响应从开始到结束的硬时限，与 idle 互补，
  // 防止"持续有数据但整体超长"的挂起。取两者中更早到期者。
  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
  const totalTimeoutMs = options.timeoutMs ?? 0;
  const deadline = totalTimeoutMs > 0 ? Date.now() + totalTimeoutMs : Infinity;
  const readWithIdleTimeout = async (): Promise<{ done: boolean; value: Uint8Array | undefined }> => {
    const readPromise = reader.read();
    if (!idleTimeoutMs || idleTimeoutMs <= 0) return readPromise;
    let timer: NodeJS.Timeout | undefined;
    // 总超时优先：剩余时间耗尽则立即失败，无需再等待 idle
    const remaining = totalTimeoutMs > 0 ? deadline - Date.now() : Infinity;
    if (remaining <= 0) {
      throw new AgentError(
        `Stream total timeout after ${totalTimeoutMs}ms`,
        { category: AgentErrorCategory.TIMEOUT },
      );
    }
    const waitMs = Math.min(idleTimeoutMs, remaining);
    try {
      return await Promise.race([
        readPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              const isTotal = totalTimeoutMs > 0 && Date.now() >= deadline;
              reject(new AgentError(
                isTotal
                  ? `Stream total timeout after ${totalTimeoutMs}ms`
                  : `Stream idle timeout after ${idleTimeoutMs}ms`,
                { category: AgentErrorCategory.TIMEOUT },
              ));
            },
            waitMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  try {
    while (!streamDone) {
      const { done, value } = await readWithIdleTimeout();
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
              block.arguments = (parser(info.argsRaw) as Record<string, unknown>) ?? {};
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
              // 最终参数以完整累积值重新解析（四级降级兜底）
              block.arguments = (parser(info.argsRaw) as Record<string, unknown>) ?? {};
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
    partial.errorMessage = aborted
      ? 'Stream aborted'
      : formatCategoryError(classifyError(e), String(e?.message ?? e));
    partial.usage = buildUsage(inputTokens, outputTokens, model, cacheReadTokens);
    partial.responseId = responseId;
    yield { type: 'error', reason: aborted ? 'aborted' : 'error', error: partial };
    return;
  } finally {
    // 释放 reader：消费者中途 break 时 async generator 会进入 finally，
    // 确保底层 HTTP 连接被释放而非悬挂（配合 idle 超时兜底半开连接）。
    try {
      await reader.cancel();
    } catch {
      /* 已关闭，忽略 */
    }
    try {
      reader.releaseLock();
    } catch {
      /* 已释放，忽略 */
    }
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
