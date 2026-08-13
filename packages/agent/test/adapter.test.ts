/**
 * 适配器测试：adaptAiModel 映射、createStreamFnFromAi 事件转换、
 * reasoning 透传、OpenAI/Anthropic 分派
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { adaptAiModel, createStreamFnFromAi } from '../adapters/ai';
import type { Model as AiModel } from '../ai/types';
import type { Model, StreamEvent } from '../core/types';

const realFetch = globalThis.fetch;

beforeEach(() => {
  delete (process.env as Record<string, string | undefined>).DEEPSEEK_API_KEY;
  delete (process.env as Record<string, string | undefined>).ANTHROPIC_API_KEY;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const openaiAiModel: AiModel = {
  id: 'deepseek-chat',
  name: 'DeepSeek Chat',
  provider: 'deepseek',
  contextWindow: 64000,
  maxTokens: 8192,
  reasoning: false,
  baseUrl: 'https://mock.example.com/v1',
};

const reasoningAiModel: AiModel = {
  ...openaiAiModel,
  id: 'deepseek-reasoner',
  name: 'DeepSeek Reasoner',
  reasoning: true,
  thinkingLevelMap: { medium: 'medium' },
};

const anthropicAiModel: AiModel = {
  id: 'claude-sonnet-4-20250514',
  name: 'Claude Sonnet 4',
  provider: 'anthropic',
  contextWindow: 200000,
  maxTokens: 8192,
  reasoning: false,
  baseUrl: 'https://api.anthropic.com',
  api: 'anthropic-messages',
};

const OPENAI_EVENTS = [
  '{"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
  '{"id":"c1","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}',
  '{"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '{"id":"c1","usage":{"prompt_tokens":10,"completion_tokens":2}}',
  '[DONE]',
];

const ANTHROPIC_EVENTS = [
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
  'event: message_stop\ndata: {"type":"message_stop"}',
];

function sseResponse(events: string[]): Response {
  const bodyStr = events.map((e) => `data: ${e}`).join('\n\n') + '\n\n';
  return new Response(new TextEncoder().encode(bodyStr), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function collect(generator: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of generator) out.push(ev);
  return out;
}

describe('adaptAiModel', () => {
  it('映射核心字段', () => {
    const m = adaptAiModel(openaiAiModel);
    assert.equal(m.id, 'deepseek-chat');
    assert.equal(m.name, 'DeepSeek Chat');
    assert.equal(m.provider, 'deepseek');
    assert.equal(m.contextWindow, 64000);
    assert.equal(m.maxTokens, 8192);
    assert.equal(m.reasoning, false);
  });

  it('透传 ai 扩展字段（baseUrl）', () => {
    const m = adaptAiModel(openaiAiModel) as Model & { baseUrl?: string };
    assert.equal(m.baseUrl, 'https://mock.example.com/v1');
  });
});

describe('createStreamFnFromAi：OpenAI 路径', () => {
  it('事件转换为框架格式并正确结束', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    installFetch(async (url, init) => {
      capturedBody = JSON.parse(String((init as RequestInit).body));
      return sseResponse(OPENAI_EVENTS);
    });

    const streamFn = createStreamFnFromAi(openaiAiModel, { apiKey: 'sk-test' });
    const events = await collect(streamFn(
      adaptAiModel(openaiAiModel),
      { systemPrompt: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      {},
    ));

    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e as { delta: string }).delta)
      .join('');
    assert.equal(text, '你好');

    const done = events.find((e) => e.type === 'done') as {
      message: { role: string; usage: { total: number; input: number; output: number }; errorMessage?: string };
    };
    assert.ok(done);
    assert.equal(done.message.role, 'assistant');
    assert.equal(done.message.usage.input, 10);
    assert.equal(done.message.usage.output, 2);
    assert.equal(done.message.usage.total, 12);

    // 请求 body 包含 system prompt 与用户消息
    assert.equal((capturedBody as { messages: Array<{ role: string }> }).messages[0].role, 'system');
  });

  it('reasoning 经 streamOptions 透传（deepseek 格式）', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    installFetch(async (_url, init) => {
      capturedBody = JSON.parse(String((init as RequestInit).body));
      return sseResponse(OPENAI_EVENTS);
    });

    const streamFn = createStreamFnFromAi(reasoningAiModel, { apiKey: 'sk-test' });
    await collect(streamFn(
      adaptAiModel(reasoningAiModel),
      { systemPrompt: '', messages: [] },
      { reasoning: 'medium' as never },
    ));

    assert.equal(capturedBody?.thinking?.type, 'enabled');
    assert.equal(capturedBody?.reasoning_effort, 'medium');
  });
});

describe('createStreamFnFromAi：Anthropic 分派', () => {
  it('api=anthropic-messages 分派到 anthropic 端点，携带 x-api-key', async () => {
    let captured: { url: string; headers: Record<string, string> } | undefined;
    installFetch(async (url, init) => {
      captured = {
        url: String(url),
        headers: (init as RequestInit).headers as Record<string, string>,
      };
      // anthropic 事件块已含 event:/data: 行，直接按块拼接
      const bodyStr = ANTHROPIC_EVENTS.join('\n\n') + '\n\n';
      return new Response(new TextEncoder().encode(bodyStr), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const streamFn = createStreamFnFromAi(anthropicAiModel, { apiKey: 'sk-ant' });
    const events = await collect(streamFn(
      adaptAiModel(anthropicAiModel),
      { systemPrompt: '', messages: [] },
      {},
    ));

    assert.ok(captured?.url.includes('/v1/messages'), captured?.url);
    assert.equal(captured?.headers['x-api-key'], 'sk-ant');
    assert.equal(captured?.headers['anthropic-version'], '2023-06-01');

    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e as { delta: string }).delta)
      .join('');
    assert.equal(text, 'hi');

    const done = events.find((e) => e.type === 'done');
    assert.ok(done, '应有 done 事件');
  });
});

// ─── 工具 ─────────────────────────────────────────────────────────

function installFetch(fn: (url: unknown, init: unknown) => Promise<Response>): void {
  (globalThis as { fetch: unknown }).fetch = (async (...args: unknown[]) => {
    return fn(args[0], args[1]);
  }) as typeof fetch;
}
