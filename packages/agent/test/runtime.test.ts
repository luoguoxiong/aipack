/**
 * Runtime 核心测试：并发串行、ephemeral、请求校验、多轮工具循环
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentRuntime,
  createRuntime,
} from '../runtime/index.ts';
import type {
  StreamFn,
  StreamEvent,
  Message,
  AssistantMessage,
  Tool,
  Context,
} from '../core/index.ts';
import { Type } from '../ai/index.ts';
import {
  MemorySessionStorage,
  createMemorySessionStorage,
} from '../session/index.ts';
import {
  FileSessionStorage,
  createFileSessionStorage,
} from '../session/index.ts';
import { createRequest } from '../core/index.ts';

// ─── mock streamFn 工厂 ───────────────────────────────────────────

function mockStreamFn(messages: Message[]): StreamFn {
  return async function* (): AsyncGenerator<StreamEvent> {
    for (const msg of messages) {
      yield { type: 'done', message: msg as AssistantMessage };
    }
  };
}

/** 工具调用流：第一次返回带 toolCall 的 assistant，第二次返回纯文本 */
function mockToolStreamFn(toolCalls: Array<{ id: string; name: string; args: unknown }>): StreamFn {
  return async function* (): AsyncGenerator<StreamEvent> {
    if (toolCalls.length > 0) {
      const tc = toolCalls.shift()!;
      const assistant: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'toolCall', id: tc.id, name: tc.name, arguments: tc.args as Record<string, unknown> }],
        stopReason: 'toolUse',
        usage: { input: 10, output: 5, total: 15 },
        timestamp: Date.now(),
      };
      yield { type: 'done', message: assistant };
    } else {
      const assistant: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'stop',
        usage: { input: 10, output: 5, total: 15 },
        timestamp: Date.now(),
      };
      yield { type: 'done', message: assistant };
    }
  };
}

describe('请求校验', () => {
  it('空消息返回错误结果', async () => {
    const runtime = createRuntime({ streamFn: mockStreamFn([]) });
    const result = await runtime.run(createRequest(''));
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('校验失败'));
    assert.ok(result.error?.includes('message'));
  });

  it('未指定 sessionKey 时使用默认值（sessionKey 由 Runtime 管理）', async () => {
    const runtime = createRuntime({
      streamFn: mockStreamFn([
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', usage: { input: 1, output: 1, total: 2 }, timestamp: Date.now() } as AssistantMessage,
      ]),
    });
    const result = await runtime.run(createRequest('hi'));
    assert.equal(result.success, true);
  });
});

describe('ephemeral 请求不持久化', () => {
  it('ephemeral=true 不触发存储', async () => {
    const store = createMemorySessionStorage();
    const saveCalls = mock.fn(() => Promise.resolve());
    (store as any).save = saveCalls;

    const runtime = createRuntime({
      streamFn: mockStreamFn([
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }], stopReason: 'stop', usage: { input: 1, output: 1, total: 2 }, timestamp: Date.now() } as AssistantMessage,
      ]),
      sessionStorage: store,
    });

    await runtime.run(createRequest('hi', { ephemeral: true }));
    assert.equal(saveCalls.mock.callCount(), 0, 'ephemeral 不应调用 save');
  });

  it('ephemeral=false（默认）触发存储', async () => {
    const store = createMemorySessionStorage();
    const saveCalls = mock.fn(() => Promise.resolve());
    (store as any).save = saveCalls;

    const runtime = createRuntime({
      streamFn: mockStreamFn([
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }], stopReason: 'stop', usage: { input: 1, output: 1, total: 2 }, timestamp: Date.now() } as AssistantMessage,
      ]),
      sessionStorage: store,
    });

    await runtime.run(createRequest('hi'));
    assert.ok(saveCalls.mock.callCount() > 0, '非 ephemeral 应调用 save');
  });
});

describe('实时持久化（运行中即可读到会话）', () => {
  const probeTool: Tool = {
    name: 'probe',
    description: '探测工具',
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  };

  it('流式运行中途（工具调用后）存储中已有该轮消息', async () => {
    const store = createMemorySessionStorage();
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 'tc1', name: 'probe', args: {} }]),
      tools: [probeTool],
      sessionStorage: store,
      sessionKey: 'live1',
    });

    // 只消费到第一个 tool_end 即暂停（模拟运行中查看会话；此时本轮结果已落盘）
    const gen = runtime.stream(createRequest('hi'));
    let sawToolEnd = false;
    for await (const chunk of gen) {
      if (chunk.type === 'tool_end') {
        sawToolEnd = true;
        break;
      }
    }
    assert.ok(sawToolEnd, '应推进到 tool_end');

    // 运行尚未结束，但第一轮 assistant + toolResult 应已实时落盘
    const stored = await store.load('live1');
    assert.ok(stored, '运行中即可读取到持久化会话');
    assert.ok(stored!.messages.some(m => m.role === 'assistant'));
    assert.ok(stored!.messages.some(m => m.role === 'toolResult'));
  });

  it('无工具调用的单轮结束后会话已持久化', async () => {
    const store = createMemorySessionStorage();
    const runtime = createRuntime({
      streamFn: mockStreamFn([
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }], stopReason: 'stop', usage: { input: 1, output: 1, total: 2 }, timestamp: Date.now() } as AssistantMessage,
      ]),
      sessionStorage: store,
      sessionKey: 'live2',
    });

    const gen = runtime.stream(createRequest('hi'));
    for await (const chunk of gen) {
      if (chunk.type === 'done') break;
    }

    const stored = await store.load('live2');
    assert.ok(stored, '单轮结束后会话应已持久化');
    assert.ok(stored!.messages.some(m => m.role === 'assistant'));
  });
});

describe('会话并发串行化', () => {
  it('同一 sessionKey 的并发请求串行执行', async () => {
    const order: string[] = [];
    let callCount = 0;
    const streamFn: StreamFn = async function* () {
      callCount++;
      order.push(`start-${callCount}`);
      // 模拟异步耗时
      await new Promise(r => setTimeout(r, 20));
      order.push(`end-${callCount}`);
      yield {
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          stopReason: 'stop',
          usage: { input: 1, output: 1, total: 2 },
          timestamp: Date.now(),
        } as AssistantMessage,
      };
    };

    const runtime = createRuntime({ streamFn });

    // 并发发起 3 个请求
    await Promise.all([
      runtime.run(createRequest('a')),
      runtime.run(createRequest('b')),
      runtime.run(createRequest('c')),
    ]);

    // 串行：start-1 -> end-1 -> start-2 -> end-2 -> start-3 -> end-3
    assert.deepEqual(order, [
      'start-1', 'end-1',
      'start-2', 'end-2',
      'start-3', 'end-3',
    ]);
  });

  it('不同 sessionKey 可并行执行（多 Runtime 实例）', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const streamFn: StreamFn = async function* () {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 20));
      concurrent--;
      yield {
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          stopReason: 'stop',
          usage: { input: 1, output: 1, total: 2 },
          timestamp: Date.now(),
        } as AssistantMessage,
      };
    };

    const runtime1 = createRuntime({ streamFn, sessionKey: 's1' });
    const runtime2 = createRuntime({ streamFn, sessionKey: 's2' });
    const runtime3 = createRuntime({ streamFn, sessionKey: 's3' });
    await Promise.all([
      runtime1.run(createRequest('a')),
      runtime2.run(createRequest('b')),
      runtime3.run(createRequest('c')),
    ]);

    assert.ok(maxConcurrent >= 2, `不同会话应可并行，实际最大并发 ${maxConcurrent}`);
  });
});

describe('工具循环', () => {
  it('模型输出 toolCall -> 执行工具 -> 再调用模型 -> 结束', async () => {
    const tool: Tool = {
      name: 'get_weather',
      description: '查天气',
      parameters: Type.Object({ city: Type.String() }),
      execute: async (id, args) => {
        const { city } = args as { city: string };
        return {
          content: [{ type: 'text', text: `${city}: 晴` }],
          details: {},
        };
      },
    };

    const runtime = createRuntime({
      streamFn: mockToolStreamFn([
        { id: 'tc1', name: 'get_weather', args: { city: '北京' } },
      ]),
      tools: [tool],
    });

    const result = await runtime.run(createRequest('北京天气如何'));
    assert.equal(result.success, true);
    assert.deepEqual(result.toolsUsed, ['get_weather']);
    assert.equal(result.content, 'done');
  });

  it('工具不存在时返回错误结果但不崩溃', async () => {
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([
        { id: 'tc1', name: 'nonexistent_tool', args: {} },
      ]),
    });

    const result = await runtime.run(createRequest('hi'));
    assert.equal(result.success, true);
    assert.equal(result.content, 'done');
  });

  it('工具超时返回错误结果', async () => {
    const tool: Tool = {
      name: 'slow_tool',
      description: '慢工具',
      parameters: Type.Object({}),
      execute: async () => {
        await new Promise(r => setTimeout(r, 5000));
        return { content: [], details: {} };
      },
    };

    const runtime = createRuntime({
      streamFn: mockToolStreamFn([
        { id: 'tc1', name: 'slow_tool', args: {} },
      ]),
      tools: [tool],
      toolTimeoutMs: 50,  // 50ms 超时
    });

    const result = await runtime.run(createRequest('hi'));
    assert.equal(result.success, true);
    assert.equal(result.content, 'done');
  });
});

describe('getMessages 返回拷贝', () => {
  it('修改返回值不影响内部状态', async () => {
    const runtime = createRuntime({
      streamFn: mockStreamFn([
        { role: 'assistant', content: [{ type: 'text', text: 'hi' }], stopReason: 'stop', usage: { input: 1, output: 1, total: 2 }, timestamp: Date.now() } as AssistantMessage,
      ]),
    });

    await runtime.run(createRequest('hello'));
    const msgs1 = runtime.getMessages();
    assert.ok(msgs1.length > 0);
    (msgs1 as any[]).push({ role: 'user', content: 'injected', timestamp: 0 });
    const msgs2 = runtime.getMessages();
    assert.ok(msgs2.length < (msgs1 as any[]).length, '外部修改不应影响内部');
  });
});

describe('maxTurns 限制', () => {
  it('达到上限时停止循环', async () => {
    // 每次都返回 toolCall，永不停止
    const streamFn: StreamFn = async function* () {
      yield {
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: `tc_${Date.now()}_${Math.random()}`, name: 'loop_tool', arguments: {} }],
          stopReason: 'toolUse',
          usage: { input: 1, output: 1, total: 2 },
          timestamp: Date.now(),
        } as AssistantMessage,
      };
    };

    const tool: Tool = {
      name: 'loop_tool',
      description: '循环工具',
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    };

    const runtime = createRuntime({
      streamFn,
      tools: [tool],
      maxTurns: 3,
    });

    const result = await runtime.run(createRequest('loop'));
    assert.equal(result.success, true);
    // 3 回合 = 3 个 assistant + 3 个 toolResult
    const msgs = runtime.getMessages();
    const assistantCount = msgs.filter(m => m.role === 'assistant').length;
    assert.ok(assistantCount <= 3, `不应超过 maxTurns，实际 ${assistantCount}`);
  });
});

describe('Result.resources 快照', () => {
  it('构建结果时填充 resources', async () => {
    const runtime = createRuntime({
      streamFn: mockStreamFn([
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }], stopReason: 'stop', usage: { input: 1, output: 1, total: 2 }, timestamp: Date.now() } as AssistantMessage,
      ]),
    });

    const result = await runtime.run(createRequest('hi'));
    assert.ok(result.resources, 'resources 应被填充');
    assert.ok(result.resources!.length > 0);
  });
});

describe('会话持久化恢复', () => {
  it('FileSessionStorage save -> load 循环', async () => {
    const tmpDir = `/tmp/aipack-test-${Date.now()}`;
    const store = createFileSessionStorage({ baseDir: tmpDir });

    await store.save('s1', {
      key: 's1',
      version: 1,
      messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
      model: null,
      usage: { input: 0, output: 0, total: 0 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const loaded = await store.load('s1');
    assert.ok(loaded);
    assert.equal(loaded!.messages.length, 1);
    assert.equal(loaded!.messages[0].role, 'user');

    // 清理
    await store.delete('s1');
    const afterDelete = await store.load('s1');
    assert.equal(afterDelete, null);
  });

  it('FileSessionStorage maxAge 过期清理', async () => {
    const tmpDir = `/tmp/aipack-test-${Date.now()}`;
    const store = createFileSessionStorage({ baseDir: tmpDir, maxAge: 100 });

    await store.save('s2', {
      key: 's2',
      version: 1,
      messages: [],
      model: null,
      usage: { input: 0, output: 0, total: 0 },
      createdAt: new Date(Date.now() - 1000).toISOString(),
      updatedAt: new Date(Date.now() - 1000).toISOString(),
    });

    // 等待过期
    await new Promise(r => setTimeout(r, 150));
    const loaded = await store.load('s2');
    assert.equal(loaded, null, '过期会话应返回 null');
  });

  it('MemorySessionStorage maxAge 过期清理', async () => {
    const store = createMemorySessionStorage({ maxAge: 50 });
    await store.save('s3', {
      key: 's3',
      version: 1,
      messages: [],
      model: null,
      usage: { input: 0, output: 0, total: 0 },
      createdAt: new Date(Date.now() - 100).toISOString(),
      updatedAt: new Date(Date.now() - 100).toISOString(),
    });

    await new Promise(r => setTimeout(r, 60));
    const loaded = await store.load('s3');
    assert.equal(loaded, null, '过期内存会话应返回 null');
  });

  it('FileSessionStorage list 返回未过期 key', async () => {
    const tmpDir = `/tmp/aipack-test-list-${Date.now()}`;
    const store = createFileSessionStorage({ baseDir: tmpDir, maxAge: 1000 });

    await store.save('k1', {
      key: 'k1', version: 1, messages: [], model: null,
      usage: { input: 0, output: 0, total: 0 },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const keys = await store.list();
    assert.ok(keys.includes('k1'));
  });
});

describe('media 附件', () => {
  it('data URI 媒体转为 ImageContent', async () => {
    let capturedContext: Context | null = null;
    const streamFn: StreamFn = async function* (_model, context) {
      capturedContext = context;
      yield {
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'got it' }],
          stopReason: 'stop',
          usage: { input: 1, output: 1, total: 2 },
          timestamp: Date.now(),
        } as AssistantMessage,
      };
    };

    const runtime = createRuntime({ streamFn });
    await runtime.run(createRequest('看图', {
      media: ['data:image/png;base64,iVBORw0KGgo='],
    }));

    assert.ok(capturedContext);
    const userMsg = capturedContext!.messages[0] as Message;
    assert.ok(Array.isArray(userMsg.content));
    assert.equal((userMsg.content as any[]).length, 2);
    assert.equal((userMsg.content as any[])[1].type, 'image');
  });
});
