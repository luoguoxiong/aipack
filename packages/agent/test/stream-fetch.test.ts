/**
 * stream-openai mock-fetch 流式测试：
 * SSE 解析（LF/CRLF）、UTF-8 跨 chunk、usage 尾块、idle 超时、abort、
 * 401 不重试、429 重试后成功、5xx 重试耗尽
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { streamOpenAI } from '../ai/stream-openai';
import type { Model, Context, StreamEvent } from '../ai/types';

const model: Model = {
  id: 'deepseek-chat',
  name: 'deepseek-chat',
  provider: 'deepseek',
  baseUrl: 'https://mock.example.com/v1',
  contextWindow: 64000,
  maxTokens: 8192,
  reasoning: false,
};

const context: Context = {
  systemPrompt: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
};

// ─── mock fetch 工具 ───────────────────────────────────────────────

const realFetch = globalThis.fetch;
const realAbort = globalThis.AbortController;

function installFetch(fn: typeof fetch): { calls: number } {
  const calls = { count: 0 };
  (globalThis as { fetch: unknown }).fetch = (async (...args: unknown[]) => {
    calls.count += 1;
    return fn(...(args as Parameters<typeof fetch>));
  }) as typeof fetch;
  return calls;
}

function sseResponse(events: string[], status = 200, eol = '\n\n'): Response {
  const bodyStr = events.map((e) => `data: ${e}`).join(eol) + eol;
  return new Response(new TextEncoder().encode(bodyStr), {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** 构造挂起的响应体：enqueue 一段数据后不再推进（触发 idle 超时） */
function hangingResponse(): Response {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  controller.enqueue(new TextEncoder().encode('data: {"id":"x","choices":[{"delta":{"content":"a"}}]}\n\n'));
  return new Response(stream, { status: 200 });
}

/**
 * 构造慢速滴流响应：每隔 intervalMs 推送一小块数据（永不结束）。
 * 用于验证总超时 —— 有持续数据（不触发 idle），但整体超过 timeoutMs 应报 total timeout。
 */
function slowDripResponse(intervalMs: number): Response {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const timer = setInterval(() => {
    controller.enqueue(
      encoder.encode('data: {"id":"x","choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}\n\n'),
    );
  }, intervalMs);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Response(stream, { status: 200 });
}

/** 标准 OpenAI 成功流（含 usage 尾块） */
const OK_EVENTS = [
  '{"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
  '{"id":"c1","choices":[{"index":0,"delta":{"content":"你"},"finish_reason":null}]}',
  '{"id":"c1","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":null}]}',
  '{"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '{"id":"c1","usage":{"prompt_tokens":10,"completion_tokens":2}}',
  '[DONE]',
];

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

beforeEach(() => {
  // 清理可能存在的 env key，保证走 options.apiKey
  delete (process.env as Record<string, string | undefined>).DEEPSEEK_API_KEY;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.AbortController = realAbort;
});

describe('SSE 流式解析', () => {
  it('LF 终止符：累积 text、正常结束、usage 尾块生效', async () => {
    installFetch(async () => sseResponse(OK_EVENTS));
    const events = await collect(streamOpenAI(model, context, { apiKey: 'sk-test' }));

    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e as { delta: string }).delta)
      .join('');
    assert.equal(text, '你好');

    const done = events.find((e) => e.type === 'done') as { message: { usage: { total: number; input: number; output: number } } };
    assert.ok(done, '应有 done 事件');
    assert.equal(done.message.usage.input, 10);
    assert.equal(done.message.usage.output, 2);
    assert.equal(done.message.usage.total, 12);
  });

  it('CRLF 终止符同样解析', async () => {
    installFetch(async () => sseResponse(OK_EVENTS, 200, '\r\n\r\n'));
    const events = await collect(streamOpenAI(model, context, { apiKey: 'sk-test' }));
    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e as { delta: string }).delta)
      .join('');
    assert.equal(text, '你好');
  });

  it('UTF-8 字符跨 chunk：TextDecoder 流式拼接不乱码', async () => {
    // "你好" UTF-8: E4 BD A0 E5 A5 BD；拆成两半各含半个字符
    const bytes = new Uint8Array([0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd]);
    const encoder = new TextEncoder();
    const prefix = encoder.encode('data: {"id":"c1","choices":[{"delta":{"content":"');
    const suffix = encoder.encode('"},"finish_reason":null}]}\n\n');

    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    installFetch(async () => new Response(stream, { status: 200 }));
    const promise = collect(streamOpenAI(model, context, { apiKey: 'sk-test' }));

    controller.enqueue(concat(prefix, bytes.subarray(0, 2)));
    controller.enqueue(concat(bytes.subarray(2), suffix));
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    controller.close();

    const events = await promise;
    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e as { delta: string }).delta)
      .join('');
    assert.equal(text, '你好');
  });
});

describe('idle 超时', () => {
  it('数据停滞超过 idleTimeoutMs 报 [timeout]', async () => {
    installFetch(async () => hangingResponse());
    const events = await collect(
      streamOpenAI(model, context, { apiKey: 'sk-test', idleTimeoutMs: 50 }),
    );
    const err = events.find((e) => e.type === 'error') as { reason: string; error: { errorMessage: string } };
    assert.ok(err, '应有 error 事件');
    assert.equal(err.reason, 'error');
    assert.ok(err.error.errorMessage.startsWith('[timeout]'), `应带 [timeout] 前缀: ${err.error.errorMessage}`);
    assert.ok(err.error.errorMessage.includes('Stream idle timeout'), err.error.errorMessage);
  });
});

describe('总超时', () => {
  it('持续有数据但整体超过 timeoutMs 报 total timeout（idle 不触发）', async () => {
    // 每 15ms 推送一块数据（间隔小于 idleTimeoutMs=500，不会触发 idle），
    // 但总时长超过 timeoutMs=60 → 应在约 60ms 时以 total timeout 终止。
    installFetch(async () => slowDripResponse(15));
    const events = await collect(
      streamOpenAI(model, context, { apiKey: 'sk-test', idleTimeoutMs: 500, timeoutMs: 60 }),
    );
    const err = events.find((e) => e.type === 'error') as { reason: string; error: { errorMessage: string } };
    assert.ok(err, '应有 error 事件');
    assert.equal(err.reason, 'error');
    assert.ok(err.error.errorMessage.startsWith('[timeout]'), `应带 [timeout] 前缀: ${err.error.errorMessage}`);
    assert.ok(err.error.errorMessage.includes('Stream total timeout'), err.error.errorMessage);
  });

  it('timeoutMs=0 时不施加总超时（仅 idle 生效）', async () => {
    installFetch(async () => hangingResponse());
    const events = await collect(
      streamOpenAI(model, context, { apiKey: 'sk-test', idleTimeoutMs: 50, timeoutMs: 0 }),
    );
    const err = events.find((e) => e.type === 'error') as { error: { errorMessage: string } };
    assert.ok(err.error.errorMessage.includes('Stream idle timeout'), err.error.errorMessage);
  });
});

describe('abort', () => {
  it('fetch 阶段被 abort 生成 aborted 错误', async () => {
    const controller = new AbortController();
    installFetch(async (_url, init) => {
      controller.abort();
      if ((init as RequestInit)?.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      return sseResponse(OK_EVENTS);
    });
    const events = await collect(
      streamOpenAI(model, context, { apiKey: 'sk-test', signal: controller.signal }),
    );
    const err = events.find((e) => e.type === 'error') as { reason: string };
    assert.ok(err, '应有 error 事件');
    assert.equal(err.reason, 'aborted');
  });
});

describe('HTTP 错误', () => {
  it('401 不重试，标记 [auth]（fetch 只调用一次）', async () => {
    const calls = installFetch(async () => {
      return new Response('{"error":{"message":"Invalid API key"}}', { status: 401 });
    });
    const events = await collect(streamOpenAI(model, context, { apiKey: 'sk-test' }));
    const err = events.find((e) => e.type === 'error') as { error: { errorMessage: string } };
    assert.ok(err.error.errorMessage.startsWith('[auth]'), err.error.errorMessage);
    assert.equal(calls.count, 1, '401 不应重试');
  });

  it('429 重试后成功（fetch 调用 2 次）', async () => {
    let n = 0;
    const calls = installFetch(async () => {
      n += 1;
      if (n === 1) {
        return new Response('{"error":{"message":"rate limited"}}', { status: 429 });
      }
      return sseResponse(OK_EVENTS);
    });
    const events = await collect(streamOpenAI(model, context, { apiKey: 'sk-test' }));
    const done = events.find((e) => e.type === 'done');
    assert.ok(done, '重试后应成功');
    assert.equal(calls.count, 2);
  });

  it('5xx 重试耗尽后标记 [retryable]', async () => {
    installFetch(async () => {
      return new Response('{"error":{"message":"Internal server error"}}', { status: 500 });
    });
    const events = await collect(streamOpenAI(model, context, { apiKey: 'sk-test' }));
    const err = events.find((e) => e.type === 'error') as { error: { errorMessage: string } };
    assert.ok(err.error.errorMessage.startsWith('[retryable]'), err.error.errorMessage);
    assert.ok(err.error.errorMessage.includes('500'), err.error.errorMessage);
  });
});

// ─── 工具 ─────────────────────────────────────────────────────────

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
