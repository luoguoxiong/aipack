/**
 * 多会话（SessionManager）测试：
 * - 会话隔离：不同 sessionKey 消息历史/状态互不干扰
 * - 串行执行：同会话并发请求依次执行，不同会话可并行
 * - LRU 淘汰：maxSessions 超限淘汰最久未用的非活动会话
 * - 持久化：按 sessionKey 分离存储 / 恢复 / 删除
 * - SessionManager API：run/stream/abort/isBusy/waitForIdle/clearSession/deleteSession
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentRuntime,
  SessionManager,
  createSessionManager,
  createRequest,
} from '../index.ts';
import type {
  StreamFn,
  StreamEvent,
  AssistantMessage,
  Message,
} from '../core/index.ts';
import {
  createMemorySessionStorage,
} from '../session/index.ts';

// ─── mock streamFn 工厂 ───────────────────────────────────────────

function simpleStreamFn(text = 'reply'): StreamFn {
  return async function* (): AsyncGenerator<StreamEvent> {
    yield {
      type: 'done',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        stopReason: 'stop',
        usage: { input: 1, output: 1, total: 2 },
        timestamp: Date.now(),
      } as AssistantMessage,
    };
  };
}

/** 延迟回复的 streamFn：用于串行/并发的时序验证 */
function delayedStreamFn(delayMs: number, text = 'reply'): StreamFn {
  return async function* (): AsyncGenerator<StreamEvent> {
    await new Promise(r => setTimeout(r, delayMs));
    yield {
      type: 'done',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        stopReason: 'stop',
        usage: { input: 1, output: 1, total: 2 },
        timestamp: Date.now(),
      } as AssistantMessage,
    };
  };
}

function assistantReply(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: { input: 1, output: 1, total: 2 },
    timestamp: Date.now(),
  };
}

/** 断言消息列表中的 user 文本序列 */
function userTexts(messages: Message[]): string[] {
  return messages
    .filter(m => m.role === 'user')
    .map(m => (typeof m.content === 'string' ? m.content : ''));
}

// ─── 会话隔离 ─────────────────────────────────────────────────────

describe('多会话隔离', () => {
  it('不同 sessionKey 的消息历史互不干扰', async () => {
    const sm = createSessionManager({
      runtimeOptions: { streamFn: simpleStreamFn() },
    });

    await sm.run('u1-first', 'sess-a');
    await sm.run('u2-first', 'sess-b');

    assert.deepEqual(userTexts(sm.getMessages('sess-a')), ['u1-first']);
    assert.deepEqual(userTexts(sm.getMessages('sess-b')), ['u2-first']);

    await sm.run('u1-second', 'sess-a');
    assert.deepEqual(userTexts(sm.getMessages('sess-a')), ['u1-first', 'u1-second']);
    assert.deepEqual(userTexts(sm.getMessages('sess-b')), ['u2-first']);

    await sm.close();
  });

  it('未指定 sessionKey 时路由到默认会话（与具名会话隔离）', async () => {
    const sm = createSessionManager({
      runtimeOptions: { streamFn: simpleStreamFn() },
    });

    await sm.run('default-msg');
    await sm.run('named-msg', 'named');

    assert.deepEqual(userTexts(sm.getMessages()), ['default-msg']);
    assert.deepEqual(userTexts(sm.getMessages('named')), ['named-msg']);
    assert.deepEqual(userTexts(sm.getMessages('default')), ['default-msg']);

    await sm.close();
  });

  it('Request 对象可携带 sessionKey，显式参数优先', async () => {
    const sm = createSessionManager({
      runtimeOptions: { streamFn: simpleStreamFn() },
    });

    await sm.run(createRequest('via-request', { sessionKey: 'k1' }));
    await sm.run(createRequest('via-request', { sessionKey: 'k1' }), 'k2');

    assert.deepEqual(userTexts(sm.getMessages('k1')), ['via-request']);
    assert.deepEqual(userTexts(sm.getMessages('k2')), ['via-request']);

    await sm.close();
  });

  it('abort / isBusy / waitForIdle 按会话隔离', async () => {
    const sm = createSessionManager({
      runtimeOptions: { streamFn: delayedStreamFn(60) },
    });

    const p = sm.run('slow', 'sess-a');
    // 等 run 真正进入流式阶段（acquire 微任务 + runLoop 启动）
    await new Promise(r => setTimeout(r, 30));
    assert.equal(sm.isBusy('sess-a'), true, '运行中的会话应为 busy');
    assert.equal(sm.isBusy('sess-b'), false, '其他会话不应 busy');
    assert.equal(sm.isBusy(), false, '默认会话不应 busy');

    await sm.waitForIdle('sess-a');
    const result = await p;
    assert.equal(result.success, true);
    assert.equal(sm.isBusy('sess-a'), false);

    await sm.close();
  });

  it('abort 中止指定会话的运行（abortable streamFn）', async () => {
    const sm = createSessionManager({
      runtimeOptions: {
        streamFn: async function* (
          _model: unknown,
          _ctx: unknown,
          options?: { signal?: AbortSignal },
        ): AsyncGenerator<StreamEvent> {
          const signal = options?.signal;
          await new Promise<void>((resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(signal?.reason ?? new Error('aborted')),
              { once: true },
            );
            setTimeout(resolve, 5000);
          });
          yield { type: 'done', message: assistantReply('late') };
        },
      },
    });

    const p = sm.run('hi', 'sess-a');
    // 等 run 真正进入流式阶段
    await new Promise(r => setTimeout(r, 30));
    sm.abort('sess-a');
    const result = await p;
    assert.equal(result.success, false, '被中止的运行应返回错误结果');
    await sm.close();
  });
});

// ─── 串行 / 并发 ──────────────────────────────────────────────────

describe('串行与并发', () => {
  it('同一会话并发请求依次执行（消息不交错）', async () => {
    const sm = createSessionManager({
      runtimeOptions: { streamFn: delayedStreamFn(30) },
    });

    const p1 = sm.run('first', 'sess');
    const p2 = sm.run('second', 'sess');

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.success, true);
    assert.equal(r2.success, true);
    // 串行队列保证消息按提交顺序追加
    assert.deepEqual(userTexts(sm.getMessages('sess')), ['first', 'second']);

    await sm.close();
  });

  it('不同会话并发执行且互不影响', async () => {
    const sm = createSessionManager({
      runtimeOptions: { streamFn: delayedStreamFn(40) },
    });

    const started = Date.now();
    const [ra, rb] = await Promise.all([
      sm.run('a', 'sess-a'),
      sm.run('b', 'sess-b'),
    ]);
    const elapsed = Date.now() - started;
    assert.equal(ra.success, true);
    assert.equal(rb.success, true);
    // 并行：总耗时 < 两次串行（60ms 左右即可完成）
    assert.ok(elapsed < 70, `应并行执行，实际 ${elapsed}ms`);
    assert.deepEqual(userTexts(sm.getMessages('sess-a')), ['a']);
    assert.deepEqual(userTexts(sm.getMessages('sess-b')), ['b']);

    await sm.close();
  });
});

// ─── LRU 淘汰 ─────────────────────────────────────────────────────

describe('LRU 会话淘汰', () => {
  it('超过 maxSessions 淘汰最久未用的非活动会话', async () => {
    const runtime = AgentRuntime.create({
      streamFn: simpleStreamFn(),
      maxSessions: 2, // 默认会话 + 1 个具名会话
    });

    await runtime.run(createRequest('a', { sessionKey: 'sess-a' })); // [default, a]
    await runtime.run(createRequest('b', { sessionKey: 'sess-b' })); // 超限 → 淘汰 default

    assert.equal(runtime.hasSession('sess-a'), true);
    assert.equal(runtime.hasSession('sess-b'), true);
    assert.equal(runtime.hasSession('default'), false, '最久未用的默认会话应先被淘汰');

    await runtime.run(createRequest('c', { sessionKey: 'sess-c' })); // 超限 → 淘汰 sess-a
    assert.equal(runtime.hasSession('sess-a'), false);
    assert.equal(runtime.hasSession('sess-b'), true);
    assert.equal(runtime.hasSession('sess-c'), true);

    // 被淘汰后重新访问会重建会话（历史为空，而非报错）
    await runtime.run(createRequest('a2', { sessionKey: 'sess-a' }));
    assert.deepEqual(userTexts(runtime.getMessages('sess-a')), ['a2']);

    await runtime.close();
  });

  it('getSessionKeys 返回当前活跃会话', async () => {
    const sm = createSessionManager({
      runtimeOptions: { streamFn: simpleStreamFn() },
    });
    await sm.run('x', 'k1');
    await sm.run('y', 'k2');

    const keys = sm.listSessions();
    assert.ok(keys.includes('k1') && keys.includes('k2'));
    assert.equal(sm.hasSession('k1'), true);
    assert.equal(sm.hasSession('nope'), false);

    await sm.close();
  });
});

// ─── 持久化 ───────────────────────────────────────────────────────

describe('多会话持久化', () => {
  it('不同会话按 key 分离存储与恢复', async () => {
    const store = createMemorySessionStorage();
    const sm = createSessionManager({
      runtimeOptions: { streamFn: simpleStreamFn(), sessionStorage: store },
    });

    await sm.run('persist-a', 'sess-a');
    await sm.run('persist-b', 'sess-b');

    const savedA = await store.load('sess-a');
    const savedB = await store.load('sess-b');
    assert.ok(savedA && savedB, '两个会话都应已持久化');
    assert.deepEqual(userTexts(savedA.messages), ['persist-a']);
    assert.deepEqual(userTexts(savedB.messages), ['persist-b']);

    // 新 Runtime + 同一存储：run 时按 key 懒恢复各自历史（hydrate）
    const sm2 = createSessionManager({
      runtimeOptions: { streamFn: simpleStreamFn(), sessionStorage: store },
    });
    // getMessages 不触发 hydrate，未运行过的会话返回空数组
    assert.deepEqual(sm2.getMessages('sess-a'), []);
    await sm2.run('followup-a', 'sess-a');
    await sm2.run('followup-b', 'sess-b');
    assert.deepEqual(userTexts(sm2.getMessages('sess-a')), ['persist-a', 'followup-a']);
    assert.deepEqual(userTexts(sm2.getMessages('sess-b')), ['persist-b', 'followup-b']);

    await sm.close();
    await sm2.close();
  });

  it('deleteSession 删除内存 + 存储；clearSession 仅清内存', async () => {
    const store = createMemorySessionStorage();
    const sm = createSessionManager({
      runtimeOptions: { streamFn: simpleStreamFn(), sessionStorage: store },
    });

    await sm.run('one', 'sess-a');
    await sm.run('two', 'sess-b');

    assert.equal(await sm.deleteSession('sess-a'), true);
    assert.equal(sm.hasSession('sess-a'), false);
    assert.equal(await store.load('sess-a'), null, '存储中应已删除');
    // 其他会话不受影响
    assert.equal(sm.hasSession('sess-b'), true);
    assert.ok((await store.load('sess-b')) !== null, 'sess-b 的存储应保留');

    // clearSession：内存清空但存储仍在（下次 run 从存储恢复）
    sm.clearSession('sess-b');
    assert.deepEqual(sm.getMessages('sess-b'), []);
    assert.ok((await store.load('sess-b')) !== null, 'clearSession 不应删存储');

    await sm.close();
  });
});

// ─── SessionManager API ───────────────────────────────────────────

describe('SessionManager API', () => {
  it('stream() 按会话路由并产出 done', async () => {
    const sm = createSessionManager({
      runtimeOptions: { streamFn: simpleStreamFn() },
    });

    const chunks: string[] = [];
    for await (const chunk of sm.stream('msg', 'sess-stream')) {
      chunks.push(chunk.type);
    }
    assert.ok(chunks.includes('done'));
    assert.deepEqual(userTexts(sm.getMessages('sess-stream')), ['msg']);

    await sm.close();
  });

  it('复用已有 Runtime 实例', async () => {
    const runtime = AgentRuntime.create({ streamFn: simpleStreamFn() });
    const sm = SessionManager.create({ runtime });

    await sm.run('shared', 'k1');
    assert.equal(sm.runtime, runtime, '应复用同一个 Runtime 实例');
    assert.deepEqual(userTexts(runtime.getMessages('k1')), ['shared']);

    await sm.close();
  });

  it('telemetry 上报携带正确的 sessionKey', async () => {
    const seen: string[] = [];
    const sm = createSessionManager({
      runtimeOptions: {
        streamFn: simpleStreamFn(),
        telemetry: {
          onModelCall(info) {
            seen.push(info.sessionKey);
          },
        },
      },
    });

    await sm.run('m', 'tele-a');
    await sm.run('m2', 'tele-b');
    assert.deepEqual(seen, ['tele-a', 'tele-b']);

    await sm.close();
  });
});
