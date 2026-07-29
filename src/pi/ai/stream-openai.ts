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

// ─── 局部 JSON 解析（惰性加载）──────────────────────────────────────

type PartialParser = (input: string) => unknown;

let cachedParser: PartialParser | null = null;
let parserLoaded = false;

async function loadPartialParser(): Promise<PartialParser> {
  if (parserLoaded) return cachedParser!;
  parserLoaded = true;
  try {
    const mod: any = await import('partial-json');
    const parse = mod.parse || mod.parseJSON || mod.default?.parse;
    if (typeof parse === 'function') {
      cachedParser = (s: string) => {
        try {
          return parse(s);
        } catch {
          return {};
        }
      };
      return cachedParser;
    }
  } catch {
    // 回退到默认解析
  }
  cachedParser = (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return {};
    }
  };
  return cachedParser;
}

// ─── API 密钥解析 ──────────────────────────────────────────────────

function resolveApiKey(model: Model, options: SimpleStreamOptions): string | undefined {
  if (options.apiKey) return options.apiKey;
  const env = options.env ?? (typeof process !== 'undefined' ? process.env : {});
  if (!env) return undefined;
  const providerKey = `${model.provider.toUpperCase().replace(/-/g, '_')}_API_KEY`;
  if (env[providerKey]) return env[providerKey];
  if (env['OPENAI_API_KEY']) return env['OPENAI_API_KEY'];
  return undefined;
}

// ─── Context -> OpenAI 消息 ────────────────────────────────────────

interface OpenAIUserContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

function toOpenAIMessages(context: Context): unknown[] {
  const messages: unknown[] = [];
  if (context.systemPrompt) {
    messages.push({ role: 'system', content: context.systemPrompt });
  }
  for (const msg of context.messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        messages.push({ role: 'user', content: msg.content });
      } else {
        const parts: OpenAIUserContentPart[] = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text });
          } else if (block.type === 'image') {
            parts.push({
              type: 'image_url',
              image_url: { url: `data:${block.mimeType};base64,${block.data}` },
            });
          }
        }
        messages.push({ role: 'user', content: parts });
      }
    } else if (msg.role === 'assistant') {
      const textParts: string[] = [];
      const toolCallParts: ToolCallContent[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'toolCall') {
          toolCallParts.push(block);
        }
      }
      const entry: Record<string, unknown> = {
        role: 'assistant',
        content: textParts.join('') || null,
      };
      if (toolCallParts.length > 0) {
        entry.tool_calls = toolCallParts.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }
      messages.push(entry);
    } else if (msg.role === 'toolResult') {
      const text = msg.content
        .filter((b): b is TextContent => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      messages.push({ role: 'tool', tool_call_id: msg.toolCallId, content: text });
    }
  }
  return messages;
}

function toOpenAITools(context: Context): unknown[] | undefined {
  if (!context.tools || context.tools.length === 0) return undefined;
  return context.tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

// ─── 用量统计 ──────────────────────────────────────────────────────

function buildUsage(raw: any, model: Model): Usage {
  const usage = createEmptyUsage();
  const input = raw?.prompt_tokens ?? 0;
  const output = raw?.completion_tokens ?? 0;
  const total = raw?.total_tokens ?? input + output;
  usage.input = input;
  usage.output = output;
  usage.total = total;
  const cacheRead = raw?.prompt_tokens_details?.cached_tokens;
  if (typeof cacheRead === 'number') {
    usage.cacheRead = cacheRead;
  }
  // 费用（假设费率是按每百万 token 计算）
  const perMillion = (n: number) => n / 1_000_000;
  usage.cost.input = perMillion(input) * (model.cost?.input ?? 0);
  usage.cost.output = perMillion(output) * (model.cost?.output ?? 0);
  usage.cost.total = usage.cost.input + usage.cost.output;
  if (typeof cacheRead === 'number') {
    usage.cost.cacheRead = perMillion(cacheRead) * (model.cost?.cacheRead ?? 0);
  }
  return usage;
}

// ─── 结束原因映射 ───────────────────────────────────────────────────

function mapFinishReason(reason: string | undefined | null): string {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'toolUse';
    case 'content_filter':
      return 'error';
    default:
      return reason ?? 'stop';
  }
}

// ─── SSE 行解析 ───────────────────────────────────────────────────

function extractDataLines(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let rest = buffer;
  let nl: number;
  while ((nl = rest.indexOf('\n')) !== -1) {
    const line = rest.slice(0, nl).replace(/\r$/, '');
    rest = rest.slice(nl + 1);
    if (line.startsWith('data:')) {
      lines.push(line.slice(5).trimStart());
    }
    // 忽略 : 注释行和 event: 行
  }
  return { lines, rest };
}

// ─── 工具调用累加器 ─────────────────────────────────────────────────

interface ToolCallAccumulator {
  index: number;
  id: string;
  name: string;
  argsRaw: string;
  contentIndex: number;
  started: boolean;
}

// ─── 主流式运行器 ───────────────────────────────────────────────────

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
    error.errorMessage = `No API key found for provider "${model.provider}" (looked for ${model.provider.toUpperCase()}_API_KEY)`;
    yield { type: 'error', reason: 'error', error };
    return;
  }

  const baseUrl = (model.baseUrl || '').replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;
  const messages = toOpenAIMessages(context);
  const tools = toOpenAITools(context);

  const body: Record<string, unknown> = {
    model: model.id,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: options.maxTokens ?? model.maxTokens,
  };
  if (tools) body.tools = tools;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (model.reasoning && options.reasoning) {
    const effortMap = model.thinkingLevelMap;
    const effort = effortMap ? effortMap[options.reasoning] : options.reasoning;
    if (effort) body.reasoning_effort = effort;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    ...(model.headers ?? {}),
    ...(options.headers ?? {}),
  };

  options.onPayload?.(body);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
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
    let errText = '';
    try {
      errText = await response.text();
    } catch {
      // ignore
    }
    const error = createEmptyAssistantMessage();
    error.model = model.id;
    error.provider = model.provider;
    error.stopReason = 'error';
    error.errorMessage = `API error ${response.status}${response.statusText ? ` ${response.statusText}` : ''}: ${errText}`;
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

  // 正在构建中的部分助手消息。
  const partial: AssistantMessage = createEmptyAssistantMessage();
  partial.model = model.id;
  partial.provider = model.provider;
  const content: ContentBlock[] = partial.content;

  yield { type: 'start', partial };

  const parser = await loadPartialParser();

  // 流式状态
  let currentTextIndex: number | null = null;
  let currentThinkingIndex: number | null = null;
  const toolCalls = new Map<number, ToolCallAccumulator>();
  const toolCallOrder: number[] = [];
  let finishReason: string | undefined;
  let responseId: string | undefined;
  let finalUsage: Usage = createEmptyUsage();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamDone = false;

  const closeText = function* (): Generator<StreamEvent> {
    if (currentTextIndex !== null) {
      const block = content[currentTextIndex] as TextContent;
      yield {
        type: 'text_end',
        content: block.text,
        contentIndex: currentTextIndex,
      };
      currentTextIndex = null;
    }
  };

  const closeThinking = function* (): Generator<StreamEvent> {
    if (currentThinkingIndex !== null) {
      const block = content[currentThinkingIndex] as ThinkingContent;
      yield {
        type: 'thinking_end',
        content: block.thinking,
        contentIndex: currentThinkingIndex,
      };
      currentThinkingIndex = null;
    }
  };

  try {
    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) {
        streamDone = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const { lines, rest } = extractDataLines(buffer);
      buffer = rest;

      for (const dataLine of lines) {
        if (dataLine === '[DONE]') {
          streamDone = true;
          break;
        }
        if (!dataLine) continue;

        let chunk: any;
        try {
          chunk = JSON.parse(dataLine);
        } catch {
          continue;
        }

        if (chunk.id && !responseId) responseId = chunk.id;
        if (chunk.usage) {
          finalUsage = buildUsage(chunk.usage, model);
        }

        const choices = chunk.choices;
        const choice = Array.isArray(choices) && choices.length > 0 ? choices[0] : null;
        if (!choice) continue;

        const delta = choice.delta ?? {};
        const reason = choice.finish_reason;

        // reasoning_content（例如 DeepSeek）-> 思维事件
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          yield* closeText();
          if (currentThinkingIndex === null) {
            currentThinkingIndex = content.length;
            content.push({ type: 'thinking', thinking: '' });
            yield {
              type: 'thinking_start',
              contentIndex: currentThinkingIndex,
            };
          }
          (content[currentThinkingIndex] as ThinkingContent).thinking += delta.reasoning_content;
          yield {
            type: 'thinking_delta',
            delta: delta.reasoning_content,
            contentIndex: currentThinkingIndex,
          };
        }

        // tool_calls（工具调用）
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
          yield* closeText();
          yield* closeThinking();
          for (const tc of delta.tool_calls) {
            const idx: number = tc.index ?? 0;
            let acc = toolCalls.get(idx);
            if (!acc) {
              acc = {
                index: idx,
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                argsRaw: '',
                contentIndex: content.length,
                started: false,
              };
              toolCalls.set(idx, acc);
              toolCallOrder.push(idx);
              // 在 content 中预留一个槽位
              content.push({
                type: 'toolCall',
                id: acc.id,
                name: acc.name,
                arguments: {},
              } as ToolCallContent);
            }
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            const argsFragment = tc.function?.arguments ?? '';
            if (argsFragment) {
              acc.argsRaw += argsFragment;
            }
            // 更新已预留的 content 块
            const block = content[acc.contentIndex] as ToolCallContent;
            block.id = acc.id;
            block.name = acc.name;
            if (acc.argsRaw) {
              try {
                block.arguments = (parser(acc.argsRaw) as Record<string, unknown>) ?? {};
              } catch {
                // keep previous arguments
              }
            }
            if (!acc.started) {
              acc.started = true;
              yield {
                type: 'toolcall_start',
                contentIndex: acc.contentIndex,
              };
            }
            if (argsFragment) {
              yield {
                type: 'toolcall_delta',
                delta: argsFragment,
                partial,
                contentIndex: acc.contentIndex,
              };
            }
          }
        }

        // content（文本）
        if (typeof delta.content === 'string' && delta.content) {
          yield* closeThinking();
          if (currentTextIndex === null) {
            currentTextIndex = content.length;
            content.push({ type: 'text', text: '' });
            yield {
              type: 'text_start',
              contentIndex: currentTextIndex,
            };
          }
          (content[currentTextIndex] as TextContent).text += delta.content;
          yield {
            type: 'text_delta',
            delta: delta.content,
            contentIndex: currentTextIndex,
          };
        }

        if (reason) {
          finishReason = reason;
        }
      }
    }
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || options.signal?.aborted;
    yield* closeText();
    yield* closeThinking();
    // 最终确定工具调用
    for (const idx of toolCallOrder) {
      const acc = toolCalls.get(idx)!;
      const block = content[acc.contentIndex] as ToolCallContent;
      try {
        block.arguments = (parser(acc.argsRaw) as Record<string, unknown>) ?? {};
      } catch {
        // keep partial
      }
      yield {
        type: 'toolcall_end',
        toolCall: block,
        contentIndex: acc.contentIndex,
      };
    }
    partial.stopReason = aborted ? 'aborted' : 'error';
    partial.errorMessage = aborted ? 'Stream aborted' : String(e?.message ?? e);
    partial.usage = finalUsage;
    partial.responseId = responseId;
    yield {
      type: 'error',
      reason: aborted ? 'aborted' : 'error',
      error: partial,
    };
    return;
  }

  // 流式正常结束：关闭所有打开的块。
  yield* closeText();
  yield* closeThinking();

  for (const idx of toolCallOrder) {
    const acc = toolCalls.get(idx)!;
    const block = content[acc.contentIndex] as ToolCallContent;
    try {
      block.arguments = (parser(acc.argsRaw) as Record<string, unknown>) ?? {};
    } catch {
      // keep partial
    }
    yield {
      type: 'toolcall_end',
      toolCall: block,
      contentIndex: acc.contentIndex,
    };
  }

  partial.stopReason = mapFinishReason(finishReason);
  partial.usage = finalUsage;
  partial.responseId = responseId;

  yield {
    type: 'done',
    reason: partial.stopReason,
    message: partial,
  };
}

// ─── 公开 API ──────────────────────────────────────────────────────

export function streamOpenAI(
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
