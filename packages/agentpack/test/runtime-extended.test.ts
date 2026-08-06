/**
 * Runtime 扩展测试：stream / abort / waitForIdle / clearSession /
 * listSessions / deleteSession / close / hooks / parallelToolCalls /
 * prepareArguments / terminate / registerTool / setModel 等
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../runtime/index.ts';
import type { AgentRuntime } from '../runtime/index.ts';
import type {
  StreamFn,
  StreamEvent,
  Message,
  AssistantMessage,
  Tool,
  ResultChunk,
} from '../core/index.ts';
import { Type } from '../ai/index.ts';
import { createRequest } from '../core/index.ts';
import { createMemorySessionStorage, createFileSessionStorage } from '../session/index.ts';

// ─── mock 工厂 ─────────────────────────────────────────────────────

function textStreamFn(text = 'hello'): StreamFn {
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

function multiEventStreamFn(events: StreamEvent[]): StreamFn {
  return async function* (): AsyncGenerator<StreamEvent> {
    for (const e of events) yield e;
  };
}

function toolCallStreamFn(toolCalls: Array<{ id: string; name: string; args: unknown }>): StreamFn {
  const queue = [...toolCalls];
  return async function* (): AsyncGenerator<StreamEvent> {
    if (queue.length > 0) {
      const tc = queue.shift()!;
      yield {
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: tc.id, name: tc.name, arguments: tc.args as Record<string, unknown> }],
          stopReason: 'toolUse',
          usage: { input: 10, output: 5, total: 15 },
          timestamp: Date.now(),
        } as AssistantMessage,
      };
    } else {
      yield {
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'stop',
          usage: { input: 10, output: 5, total: 15 },
          timestamp: Date.now(),
        } as AssistantMessage,
      };
    }
  };
}

// ─── stream 方法 ───────────────────────────────────────────────────

describe('stream 方法', () => {
  it('流式输出 text chunk', async () => {
    const events: StreamEvent[] = [
      { type: 'text_delta', delta: 'hel' },
      { type: 'text_delta', delta: 'lo' },
      {
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          stopReason: 'stop',
          usage: { input: 1, output: 1, total: 2 },
          timestamp: Date.now(),
        } as AssistantMessage,
      },
    ];
    const runtime = createRuntime({ streamFn: multiEventStreamFn(events) });
    const chunks: ResultChunk[] = [];
    for await (const chunk of runtime.stream(createRequest('hi', { sessionKey: 'stream1' }))) {
      chunks.push(chunk);
    }
    const textChunks = chunks.filter(c => c.type === 'text');
    assert.equal(textChunks.length, 2);
    assert.equal(textChunks[0].content, 'hel');
    assert.equal(textChunks[1].content, 'lo');
    assert.ok(chunks.some(c => c.type === 'done'));
  });

  it('流式 thinking chunk', async () => {
    const events: StreamEvent[] = [
      { type: 'thinking_delta', delta: '思考中' },
      {
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
          stopReason: 'stop',
          usage: { input: 1, output: 1, total: 2 },
          timestamp: Date.now(),
        } as AssistantMessage,
      },
    ];
    const runtime = createRuntime({ streamFn: multiEventStreamFn(events) });
    const chunks: ResultChunk[] = [];
    for await (const chunk of runtime.stream(createRequest('hi', { sessionKey: 'stream2' }))) {
      chunks.push(chunk);
    }
    const thinkingChunks = chunks.filter(c => c.type === 'thinking');
    assert.equal(thinkingChunks.length, 1);
    assert.equal(thinkingChunks[0].content, '思考中');
  });

  it('流式 error chunk', async () => {
    const events: StreamEvent[] = [
      {
        type: 'error',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'API key invalid',
          usage: { input: 0, output: 0, total: 0 },
          timestamp: Date.now(),
        } as AssistantMessage,
      },
    ];
    const runtime = createRuntime({ streamFn: multiEventStreamFn(events) });
    const chunks: ResultChunk[] = [];
    for await (const chunk of runtime.stream(createRequest('hi', { sessionKey: 'stream3' }))) {
      chunks.push(chunk);
    }
    const errorChunks = chunks.filter(c => c.type === 'error');
    assert.equal(errorChunks.length, 1);
    assert.equal(errorChunks[0].content, 'API key invalid');
    assert.ok(chunks.some(c => c.type === 'done'));
  });

  it('流式工具调用产出 tool_start / tool_end', async () => {
    const tool: Tool = {
      name: 'calc',
      description: '计算',
      parameters: Type.Object({ x: Type.Number() }),
      execute: async () => ({
        content: [{ type: 'text', text: '42' }],
        details: {},
      }),
    };
    const runtime = createRuntime({
      streamFn: toolCallStreamFn([{ id: 'tc1', name: 'calc', args: { x: 1 } }]),
      tools: [tool],
    });
    const chunks: ResultChunk[] = [];
    for await (const chunk of runtime.stream(createRequest('calc', { sessionKey: 'stream4' }))) {
      chunks.push(chunk);
    }
    const starts = chunks.filter(c => c.type === 'tool_start');
    const ends = chunks.filter(c => c.type === 'tool_end');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].toolName, 'calc');
    assert.equal(ends.length, 1);
    assert.equal(ends[0].isError, false);
  });

  it('校验失败的流式请求产出 error + done', async () => {
    const runtime = createRuntime({ streamFn: textStreamFn() });
    const chunks: ResultChunk[] = [];
    for await (const chunk of runtime.stream(createRequest(''))) {
      chunks.push(chunk);
    }
    const errorChunk = chunks.find(c => c.type === 'error');
    assert.ok(errorChunk);
    assert.ok(errorChunk!.content?.includes('校验失败'));
    assert.ok(chunks.some(c => c.type === 'done'));
  });
});

// ─── abort / isBusy / waitForIdle ──────────────────────────────────

describe('abort / isBusy / waitForIdle', () => {
  it('isBusy 反映流式状态', async () => {
    let resolveStream: () => void;
    const gate = new Promise<void>(r => { resolveStream = r; });
    const streamFn: StreamFn = async function* () {
      await gate;
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
    assert.equal(runtime.isBusy('busy1'), false);
    const runPromise = runtime.run(createRequest('hi', { sessionKey: 'busy1' }));
    // 让事件循环跑一下让 run 启动
    await new Promise(r => setTimeout(r, 5));
    assert.equal(runtime.isBusy('busy1'), true);
    resolveStream!();
    await runPromise;
    assert.equal(runtime.isBusy('busy1'), false);
  });

  it('abort 终止运行', async () => {
    const streamFn: StreamFn = async function* (_model, _ctx, options) {
      // 等待 abort
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
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
    const runPromise = runtime.run(createRequest('hi', { sessionKey: 'abort1' }));
    await new Promise(r => setTimeout(r, 10));
    runtime.abort('abort1');
    const result = await runPromise;
    // abort 后运行应结束（成功或失败都算结束）
    assert.equal(runtime.isBusy('abort1'), false);
  });

  it('waitForIdle 在运行结束后唤醒', async () => {
    const streamFn: StreamFn = async function* () {
      await new Promise(r => setTimeout(r, 30));
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
    const runPromise = runtime.run(createRequest('hi', { sessionKey: 'idle1' }));
    await new Promise(r => setTimeout(r, 5));
    assert.equal(runtime.isBusy('idle1'), true);
    await runtime.waitForIdle('idle1');
    assert.equal(runtime.isBusy('idle1'), false);
    await runPromise;
  });

  it('waitForIdle 空闲时立即返回', async () => {
    const runtime = createRuntime({ streamFn: textStreamFn() });
    await runtime.waitForIdle('never-run');
    // 不阻塞即通过
  });
});

// ─── clearSession / listSessions / deleteSession ───────────────────

describe('clearSession', () => {
  it('清除内存消息', async () => {
    const runtime = createRuntime({ streamFn: textStreamFn('reply') });
    await runtime.run(createRequest('hi', { sessionKey: 'clear1' }));
    assert.ok(runtime.getMessages('clear1').length > 0);
    runtime.clearSession('clear1');
    assert.equal(runtime.getMessages('clear1').length, 0);
  });

  it('清除后下次 run 从存储恢复', async () => {
    const store = createMemorySessionStorage();
    const runtime = createRuntime({ streamFn: textStreamFn('reply'), sessionStorage: store });
    await runtime.run(createRequest('hi', { sessionKey: 'clear2' }));
    assert.ok(runtime.getMessages('clear2').length > 0);
    runtime.clearSession('clear2');
    assert.equal(runtime.getMessages('clear2').length, 0);
    // 再次 run，应从存储恢复历史
    await runtime.run(createRequest('again', { sessionKey: 'clear2' }));
    const msgs = runtime.getMessages('clear2');
    // 应包含恢复的历史 + 新消息
    assert.ok(msgs.length >= 2);
  });
});

describe('listSessions', () => {
  it('列出内存中的会话', async () => {
    const runtime = createRuntime({ streamFn: textStreamFn() });
    await runtime.run(createRequest('a', { sessionKey: 'list1' }));
    await runtime.run(createRequest('b', { sessionKey: 'list2' }));
    const keys = await runtime.listSessions();
    assert.ok(keys.includes('list1'));
    assert.ok(keys.includes('list2'));
  });

  it('合并内存与存储的会话', async () => {
    const store = createMemorySessionStorage();
    await store.save('stored1', {
      key: 'stored1',
      version: 1,
      messages: [],
      model: null,
      usage: { input: 0, output: 0, total: 0 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const runtime = createRuntime({ streamFn: textStreamFn(), sessionStorage: store });
    await runtime.run(createRequest('hi', { sessionKey: 'mem1' }));
    const keys = await runtime.listSessions();
    assert.ok(keys.includes('mem1'));
    assert.ok(keys.includes('stored1'));
  });

  it('去重', async () => {
    const store = createMemorySessionStorage();
    const runtime = createRuntime({ streamFn: textStreamFn(), sessionStorage: store });
    await runtime.run(createRequest('hi', { sessionKey: 'dup' }));
    // 保存到存储后，内存和存储都有 'dup'
    const keys = await runtime.listSessions();
    const dupCount = keys.filter(k => k === 'dup').length;
    assert.equal(dupCount, 1);
  });
});

describe('deleteSession', () => {
  it('删除内存会话', async () => {
    const runtime = createRuntime({ streamFn: textStreamFn() });
    await runtime.run(createRequest('hi', { sessionKey: 'del1' }));
    const deleted = await runtime.deleteSession('del1');
    assert.equal(deleted, true);
    assert.equal(runtime.getMessages('del1').length, 0);
  });

  it('删除存储中的会话', async () => {
    const store = createMemorySessionStorage();
    const runtime = createRuntime({ streamFn: textStreamFn(), sessionStorage: store });
    await runtime.run(createRequest('hi', { sessionKey: 'del2' }));
    const deleted = await runtime.deleteSession('del2');
    assert.equal(deleted, true);
    const loaded = await store.load('del2');
    assert.equal(loaded, null);
  });

  it('删除不存在的会话返回 true（无存储时）', async () => {
    const runtime = createRuntime({ streamFn: textStreamFn() });
    const deleted = await runtime.deleteSession('not-exist');
    assert.equal(deleted, true);
  });
});

// ─── close ─────────────────────────────────────────────────────────

describe('close', () => {
  it('关闭后清理所有会话', async () => {
    const runtime = createRuntime({ streamFn: textStreamFn() });
    await runtime.run(createRequest('hi', { sessionKey: 'close1' }));
    await runtime.close();
    // close 后 getMessages 返回新空会话
    assert.equal(runtime.getMessages('close1').length, 0);
  });

  it('close 等待在途任务完成', async () => {
    const streamFn: StreamFn = async function* () {
      await new Promise(r => setTimeout(r, 30));
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
    const runPromise = runtime.run(createRequest('hi', { sessionKey: 'close2' }));
    await runtime.close();
    await runPromise;
    // close 应等待在途任务完成
  });
});

// ─── registerTool / registerTools / setModel / setSystemPrompt ─────

describe('registerTool / registerTools', () => {
  it('registerTool 注册工具并可调用', async () => {
    const tool: Tool = {
      name: 'ping',
      description: 'ping',
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: 'text', text: 'pong' }],
        details: {},
      }),
    };
    const runtime = createRuntime({
      streamFn: toolCallStreamFn([{ id: 'tc1', name: 'ping', args: {} }]),
    });
    runtime.registerTool(tool);
    const result = await runtime.run(createRequest('ping', { sessionKey: 'reg1' }));
    assert.equal(result.success, true);
    assert.deepEqual(result.toolsUsed, ['ping']);
  });

  it('registerTools 批量注册', async () => {
    const tools: Tool[] = [
      {
        name: 'tool_a',
        description: 'a',
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: 'text', text: 'a' }], details: {} }),
      },
      {
        name: 'tool_b',
        description: 'b',
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: 'text', text: 'b' }], details: {} }),
      },
    ];
    const runtime = createRuntime({
      streamFn: toolCallStreamFn([{ id: 'tc1', name: 'tool_b', args: {} }]),
    });
    runtime.registerTools(tools);
    const result = await runtime.run(createRequest('b', { sessionKey: 'reg2' }));
    assert.deepEqual(result.toolsUsed, ['tool_b']);
  });

  it('重复注册同名工具覆盖', async () => {
    const tool1: Tool = {
      name: 'dup',
      description: 'v1',
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text', text: 'v1' }], details: {} }),
    };
    const tool2: Tool = {
      name: 'dup',
      description: 'v2',
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text', text: 'v2' }], details: {} }),
    };
    const runtime = createRuntime({
      streamFn: toolCallStreamFn([{ id: 'tc1', name: 'dup', args: {} }]),
    });
    runtime.registerTool(tool1);
    runtime.registerTool(tool2); // 覆盖
    const result = await runtime.run(createRequest('dup', { sessionKey: 'reg3' }));
    assert.equal(result.success, true);
  });
});

describe('setModel / setSystemPrompt / setStreamFn / setThinkingLevel', () => {
  it('setModel 运行时切换模型', async () => {
    let receivedModel: any;
    const streamFn: StreamFn = async function* (model) {
      receivedModel = model;
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
    runtime.setModel({
      id: 'custom-model',
      name: 'Custom',
      provider: 'custom',
      contextWindow: 32000,
      maxTokens: 4096,
      reasoning: false,
    });
    await runtime.run(createRequest('hi', { sessionKey: 'set1' }));
    assert.equal(receivedModel.id, 'custom-model');
  });

  it('setSystemPrompt 传入上下文', async () => {
    let receivedCtx: any;
    const streamFn: StreamFn = async function* (_m, ctx) {
      receivedCtx = ctx;
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
    runtime.setSystemPrompt('你是一个助手');
    await runtime.run(createRequest('hi', { sessionKey: 'set2' }));
    assert.equal(receivedCtx.systemPrompt, '你是一个助手');
  });

  it('setStreamFn 运行时替换', async () => {
    const fn1: StreamFn = async function* () {
      yield {
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'fn1' }],
          stopReason: 'stop',
          usage: { input: 1, output: 1, total: 2 },
          timestamp: Date.now(),
        } as AssistantMessage,
      };
    };
    const fn2: StreamFn = async function* () {
      yield {
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'fn2' }],
          stopReason: 'stop',
          usage: { input: 1, output: 1, total: 2 },
          timestamp: Date.now(),
        } as AssistantMessage,
      };
    };
    const runtime = createRuntime({ streamFn: fn1 });
    let result = await runtime.run(createRequest('hi', { sessionKey: 'set3' }));
    assert.equal(result.content, 'fn1');
    runtime.setStreamFn(fn2);
    result = await runtime.run(createRequest('hi', { sessionKey: 'set3' }));
    assert.equal(result.content, 'fn2');
  });

  it('setThinkingLevel 运行时切换', () => {
    const runtime = createRuntime({}) as AgentRuntime;
    runtime.setThinkingLevel('high');
    assert.equal((runtime as any)._thinkingLevel, 'high');
  });
});

// ─── parallelToolCalls=false ───────────────────────────────────────

describe('parallelToolCalls=false 串行执行工具', () => {
  it('多个工具调用串行执行', async () => {
    const order: string[] = [];
    const tools: Tool[] = [
      {
        name: 'slow_a',
        description: 'a',
        parameters: Type.Object({}),
        execute: async () => {
          order.push('a-start');
          await new Promise(r => setTimeout(r, 30));
          order.push('a-end');
          return { content: [], details: {} };
        },
      },
      {
        name: 'slow_b',
        description: 'b',
        parameters: Type.Object({}),
        execute: async () => {
          order.push('b-start');
          await new Promise(r => setTimeout(r, 30));
          order.push('b-end');
          return { content: [], details: {} };
        },
      },
    ];

    // 第一次调用返回两个 toolCall，第二次返回纯文本
    let callCount = 0;
    const streamFn: StreamFn = async function* () {
      callCount++;
      if (callCount === 1) {
        yield {
          type: 'done',
          message: {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 'tc1', name: 'slow_a', arguments: {} },
              { type: 'toolCall', id: 'tc2', name: 'slow_b', arguments: {} },
            ],
            stopReason: 'toolUse',
            usage: { input: 1, output: 1, total: 2 },
            timestamp: Date.now(),
          } as AssistantMessage,
        };
      } else {
        yield {
          type: 'done',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            stopReason: 'stop',
            usage: { input: 1, output: 1, total: 2 },
            timestamp: Date.now(),
          } as AssistantMessage,
        };
      }
    };

    const runtime = createRuntime({
      streamFn,
      tools,
      parallelToolCalls: false,
    });
    await runtime.run(createRequest('run both', { sessionKey: 'par1' }));
    // 串行：a-start -> a-end -> b-start -> b-end
    assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
  });
});

// ─── prepareArguments ──────────────────────────────────────────────

describe('prepareArguments', () => {
  it('工具执行前调用 prepareArguments 转换参数', async () => {
    let capturedArgs: unknown;
    const tool: Tool = {
      name: 'echo',
      description: 'echo',
      parameters: Type.Object({}),
      prepareArguments: (args) => ({ ...args as object, injected: true }),
      execute: async (_id, args) => {
        capturedArgs = args;
        return { content: [{ type: 'text', text: 'ok' }], details: {} };
      },
    };
    const runtime = createRuntime({
      streamFn: toolCallStreamFn([{ id: 'tc1', name: 'echo', args: { original: 1 } }]),
      tools: [tool],
    });
    await runtime.run(createRequest('echo', { sessionKey: 'prep1' }));
    assert.deepEqual(capturedArgs, { original: 1, injected: true });
  });
});

// ─── hooks ─────────────────────────────────────────────────────────

describe('Runtime hooks', () => {
  it('beforeRun waterfall 可修改请求', async () => {
    const runtime = createRuntime({ streamFn: textStreamFn('ok') });
    let seenMessage = '';
    runtime.hooks.beforeRun.tapPromise('test', async (req) => {
      seenMessage = req.message;
      return req;
    });
    await runtime.run(createRequest('original', { sessionKey: 'hook1' }));
    assert.equal(seenMessage, 'original');
  });

  it('done 钩子接收结果', async () => {
    const runtime = createRuntime({ streamFn: textStreamFn('result text') });
    let doneResult: any;
    runtime.hooks.done.tapPromise('test', async (result) => {
      doneResult = result;
    });
    await runtime.run(createRequest('hi', { sessionKey: 'hook2' }));
    assert.ok(doneResult);
    assert.equal(doneResult.content, 'result text');
  });

  it('failed 钩子接收错误', async () => {
    const streamFn: StreamFn = async function* () {
      throw new Error('stream exploded');
    };
    const runtime = createRuntime({ streamFn });
    let failedError: Error | null = null;
    runtime.hooks.failed.tapPromise('test', async (err) => {
      failedError = err;
    });
    await runtime.run(createRequest('hi', { sessionKey: 'hook3' }));
    assert.ok(failedError);
    assert.equal(failedError!.message, 'stream exploded');
  });

  it('beforeEmit / afterEmit 钩子触发', async () => {
    const runtime = createRuntime({ streamFn: textStreamFn() });
    let beforeEmitCalled = false;
    let afterEmitCalled = false;
    runtime.hooks.beforeEmit.tapPromise('test', async () => { beforeEmitCalled = true; });
    runtime.hooks.afterEmit.tapPromise('test', async () => { afterEmitCalled = true; });
    await runtime.run(createRequest('hi', { sessionKey: 'hook4' }));
    assert.equal(beforeEmitCalled, true);
    assert.equal(afterEmitCalled, true);
  });

  it('beforeInitialize / afterInitialize 钩子触发', async () => {
    const runtime = createRuntime({ streamFn: textStreamFn() });
    let beforeInitCalled = false;
    let afterInitCalled = false;
    runtime.hooks.beforeInitialize.tapPromise('test', async () => { beforeInitCalled = true; });
    runtime.hooks.afterInitialize.tapPromise('test', async () => { afterInitCalled = true; });
    await runtime.run(createRequest('hi', { sessionKey: 'hook5' }));
    assert.equal(beforeInitCalled, true);
    assert.equal(afterInitCalled, true);
  });

  it('Extension 通过 extensions 选项注册', async () => {
    let applied = false;
    const runtime = createRuntime({
      streamFn: textStreamFn(),
      extensions: [{
        name: 'test-ext',
        apply: (hooks) => {
          hooks.done.tapPromise('test-ext', async () => { applied = true; });
        },
      }],
    });
    await runtime.run(createRequest('hi', { sessionKey: 'hook6' }));
    assert.equal(applied, true);
  });

  it('useTransformer 注册自定义转换器', async () => {
    const runtime = createRuntime({ streamFn: textStreamFn() });
    let transformCalled = false;
    runtime.useTransformer({
      name: 'custom',
      priority: 50,
      transform: async (resources) => {
        transformCalled = true;
        return resources;
      },
    });
    await runtime.run(createRequest('hi', { sessionKey: 'hook7' }));
    assert.equal(transformCalled, true);
  });
});

// ─── 默认 streamFn 报错 ────────────────────────────────────────────

describe('默认 streamFn 未设置', () => {
  it('未提供 streamFn 时 run 返回错误结果', async () => {
    const runtime = createRuntime({});
    const result = await runtime.run(createRequest('hi', { sessionKey: 'nosf1' }));
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('streamFn'));
  });
});

// ─── media URL（非 data URI）───────────────────────────────────────

describe('media URL 附件', () => {
  it('URL 媒体转为 ImageContent', async () => {
    let capturedCtx: any;
    const streamFn: StreamFn = async function* (_m, ctx) {
      capturedCtx = ctx;
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
    await runtime.run(createRequest('看图', {
      sessionKey: 'url1',
      media: ['https://example.com/img.png'],
    }));
    const userMsg = capturedCtx.messages[0];
    assert.ok(Array.isArray(userMsg.content));
    const imgBlock = (userMsg.content as any[]).find((c: any) => c.type === 'image');
    assert.ok(imgBlock);
    assert.equal(imgBlock.data, 'https://example.com/img.png');
    assert.equal(imgBlock.mimeType, 'image/url');
  });

  it('多个 media 附件全部转换', async () => {
    let capturedCtx: any;
    const streamFn: StreamFn = async function* (_m, ctx) {
      capturedCtx = ctx;
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
    await runtime.run(createRequest('多图', {
      sessionKey: 'url2',
      media: [
        'data:image/png;base64,abc',
        'https://example.com/a.jpg',
      ],
    }));
    const userMsg = capturedCtx.messages[0];
    const imgBlocks = (userMsg.content as any[]).filter((c: any) => c.type === 'image');
    assert.equal(imgBlocks.length, 2);
  });
});
