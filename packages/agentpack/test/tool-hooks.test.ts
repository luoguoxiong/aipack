/**
 * Tool Hooks 测试：beforeToolCall / afterToolCall
 * 覆盖 block / terminate / 改写 args / 改写 result / details 合并 / 多 tap 串联 / 流式事件
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, createToolHookExtension } from '../index.ts';
import type {
  StreamFn,
  StreamEvent,
  AssistantMessage,
  Tool,
  ToolResult,
  Message,
  ResultChunk,
} from '../core/index.ts';
import { Type } from '../ai/index.ts';
import { createRequest, createTextContent } from '../core/index.ts';

// ─── mock streamFn 工厂 ───────────────────────────────────────────

/** 工具调用流：第一次返回带 toolCall 的 assistant，之后返回纯文本 'done' */
function mockToolStreamFn(
  toolCalls: Array<{ id: string; name: string; args: unknown }>,
): StreamFn {
  return async function* (): AsyncGenerator<StreamEvent> {
    if (toolCalls.length > 0) {
      const tc = toolCalls.shift()!;
      const assistant: AssistantMessage = {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: tc.id, name: tc.name, arguments: tc.args as Record<string, unknown> },
        ],
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

/** 构造一个 mock 工具，execute 用 mock.fn 包装便于断言调用次数与参数 */
function makeTool(name: string = 'bash'): { tool: Tool; exec: ReturnType<typeof mock.fn> } {
  const exec = mock.fn(async (_id: string, args: unknown): Promise<ToolResult> => ({
    content: [createTextContent('executed')],
    details: { args },
  }));
  const tool: Tool = {
    name,
    description: `mock ${name}`,
    parameters: Type.Object({}),
    execute: exec,
  };
  return { tool, exec };
}

/** 从消息列表中提取第一个 toolResult 消息的文本 */
function toolResultText(messages: Message[]): string {
  const tr = messages.find(m => m.role === 'toolResult');
  if (!tr) return '';
  const content = tr.content;
  if (typeof content === 'string') return content;
  return content.filter(c => c.type === 'text').map(c => c.type === 'text' ? c.text : '').join('');
}

// ─── beforeToolCall ───────────────────────────────────────────────

describe('beforeToolCall', () => {
  it('block: 工具不执行，生成 [blocked] 结果，run 继续完成', async () => {
    const { tool, exec } = makeTool('bash');
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 'tc1', name: 'bash', args: { cmd: 'ls' } }]),
      tools: [tool],
      extensions: [
        createToolHookExtension({
          beforeToolCall: async ({ toolCall }) => {
            if (toolCall.name === 'bash') {
              return { block: true, reason: 'bash is disabled' };
            }
          },
        }),
      ],
    });

    const result = await runtime.run(createRequest('hi', { sessionKey: 'block-1' }));

    assert.equal(exec.mock.callCount(), 0, 'block 后工具不应执行');
    assert.ok(result.toolsUsed.includes('bash'), 'toolsUsed 仍记录该工具');
    const msgs = runtime.getMessages('block-1');
    assert.ok(toolResultText(msgs).includes('[blocked]'), '结果应含 [blocked]');
    assert.ok(toolResultText(msgs).includes('bash is disabled'), '结果应含原因');
    // block 不 terminate：run 继续到第二轮纯文本，正常完成
    assert.equal(result.success, true);
    assert.notEqual(result.stopReason, 'terminated');
  });

  it('terminate: 终止整个 run，stopReason=terminated，execute 不调用', async () => {
    const { tool, exec } = makeTool('bash');
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 'tc1', name: 'bash', args: {} }]),
      tools: [tool],
      extensions: [
        createToolHookExtension({
          beforeToolCall: async ({ toolCall }) => {
            if (toolCall.name === 'bash') {
              return { block: true, reason: 'bash is disabled', terminate: true };
            }
          },
        }),
      ],
    });

    const result = await runtime.run(createRequest('hi', { sessionKey: 'term-1' }));

    assert.equal(exec.mock.callCount(), 0, 'terminate 前工具不应执行');
    assert.equal(result.stopReason, 'terminated');
    assert.equal(result.metadata.terminateReason, 'bash is disabled');
  });

  it('改写 args：execute 收到改写后的参数', async () => {
    const { tool, exec } = makeTool('search');
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 'tc1', name: 'search', args: { q: 'old' } }]),
      tools: [tool],
      extensions: [
        createToolHookExtension({
          beforeToolCall: async ({ toolCall }) => {
            if (toolCall.name === 'search') {
              return { args: { q: 'rewritten' } };
            }
          },
        }),
      ],
    });

    await runtime.run(createRequest('hi', { sessionKey: 'args-1' }));

    assert.equal(exec.mock.callCount(), 1, '工具应执行一次');
    const passedArgs = exec.mock.calls[0].arguments[1];
    assert.deepEqual(passedArgs, { q: 'rewritten' }, 'execute 应收到改写后的 args');
  });

  it('未匹配的 hook 返回 void：工具正常执行', async () => {
    const { tool, exec } = makeTool('safe');
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 'tc1', name: 'safe', args: {} }]),
      tools: [tool],
      extensions: [
        createToolHookExtension({
          beforeToolCall: async ({ toolCall }) => {
            if (toolCall.name === 'other') {
              return { block: true, reason: 'no' };
            }
            // 对 'safe' 返回 undefined
          },
        }),
      ],
    });

    await runtime.run(createRequest('hi', { sessionKey: 'pass-1' }));
    assert.equal(exec.mock.callCount(), 1, '未匹配规则应放行');
  });
});

// ─── afterToolCall ────────────────────────────────────────────────

describe('afterToolCall', () => {
  it('替换 result：消息内容变为 override', async () => {
    const { tool } = makeTool('fetch');
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 'tc1', name: 'fetch', args: {} }]),
      tools: [tool],
      extensions: [
        createToolHookExtension({
          afterToolCall: async () => {
            return {
              result: {
                content: [{ type: 'text', text: 'overridden' }],
                details: { audited: true },
              },
            };
          },
        }),
      ],
    });

    await runtime.run(createRequest('hi', { sessionKey: 'after-1' }));
    const msgs = runtime.getMessages('after-1');
    assert.equal(toolResultText(msgs), 'overridden');
  });

  it('details 合并：后续 tap 看到合并后的 details', async () => {
    const { tool } = makeTool('audit');
    const seen = mock.fn((r: { details: unknown }) => r);

    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 'tc1', name: 'audit', args: {} }]),
      tools: [tool],
      extensions: [
        // 第一个 extension：合并 audited=true
        createToolHookExtension({
          name: 'audit-stamp',
          afterToolCall: async () => ({ details: { audited: true } }),
        }),
        // 第二个 extension：观测 decision.result.details
        createToolHookExtension({
          name: 'observer',
          afterToolCall: async ({ result }) => {
            seen(result);
            return undefined;
          },
        }),
      ],
    });

    await runtime.run(createRequest('hi', { sessionKey: 'after-2' }));
    assert.equal(seen.mock.callCount(), 1, 'observer 应被调用一次');
    const observed = seen.mock.calls[0].arguments[0];
    assert.deepEqual(
      observed.details,
      { args: {}, audited: true },
      'details 应为原值与 audited 合并',
    );
  });

  it('terminate：execute 已执行后终止 run', async () => {
    const { tool, exec } = makeTool('notify_done');
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 'tc1', name: 'notify_done', args: {} }]),
      tools: [tool],
      extensions: [
        createToolHookExtension({
          afterToolCall: async ({ toolCall, isError }) => {
            if (toolCall.name === 'notify_done' && !isError) {
              return { terminate: true };
            }
          },
        }),
      ],
    });

    const result = await runtime.run(createRequest('hi', { sessionKey: 'after-term-1' }));
    assert.equal(exec.mock.callCount(), 1, 'afterToolCall 在执行后触发，工具应已执行');
    assert.equal(result.stopReason, 'terminated');
    assert.equal(result.metadata.terminateReason, 'terminated by afterToolCall');
  });
});

// ─── 多 tap 串联 ──────────────────────────────────────────────────

describe('多 tap 串联', () => {
  it('前置改 args + 后置 block：两者都执行，block 生效', async () => {
    const { tool, exec } = makeTool('bash');
    const rewriterCalled = mock.fn(() => undefined);

    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 'tc1', name: 'bash', args: { cmd: 'ls' } }]),
      tools: [tool],
      extensions: [
        createToolHookExtension({
          name: 'rewriter',
          beforeToolCall: async ({ toolCall }) => {
            rewriterCalled();
            if (toolCall.name === 'bash') {
              return { args: { cmd: 'rewritten' } };
            }
          },
        }),
        createToolHookExtension({
          name: 'blocker',
          beforeToolCall: async ({ toolCall }) => {
            if (toolCall.name === 'bash') {
              return { block: true, reason: 'blocked by blocker' };
            }
          },
        }),
      ],
    });

    await runtime.run(createRequest('hi', { sessionKey: 'multi-1' }));
    assert.equal(rewriterCalled.mock.callCount(), 1, '前置 rewriter 应执行');
    assert.equal(exec.mock.callCount(), 0, '后置 block 生效，工具不执行');
    const msgs = runtime.getMessages('multi-1');
    assert.ok(toolResultText(msgs).includes('blocked by blocker'));
  });

  it('前置 block 后，后续 beforeToolCall 回调不再被调用', async () => {
    const { tool } = makeTool('bash');
    const laterCalled = mock.fn(() => undefined);

    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 'tc1', name: 'bash', args: {} }]),
      tools: [tool],
      extensions: [
        createToolHookExtension({
          name: 'blocker',
          beforeToolCall: async () => ({ block: true, reason: 'first' }),
        }),
        createToolHookExtension({
          name: 'later',
          beforeToolCall: async () => {
            laterCalled();
            return undefined;
          },
        }),
      ],
    });

    await runtime.run(createRequest('hi', { sessionKey: 'multi-2' }));
    assert.equal(laterCalled.mock.callCount(), 0, '前置 block 后后续回调不应执行');
  });
});

// ─── 流式：block 保留 tool_start/tool_end ─────────────────────────

describe('流式事件', () => {
  it('block 时仍 yield tool_start 与 tool_end', async () => {
    const { tool, exec } = makeTool('bash');
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 'tc1', name: 'bash', args: {} }]),
      tools: [tool],
      extensions: [
        createToolHookExtension({
          beforeToolCall: async ({ toolCall }) => {
            if (toolCall.name === 'bash') {
              return { block: true, reason: 'disabled' };
            }
          },
        }),
      ],
    });

    const chunks: ResultChunk[] = [];
    for await (const chunk of runtime.stream(createRequest('hi', { sessionKey: 'stream-1' }))) {
      chunks.push(chunk);
    }

    const hasStart = chunks.some(c => c.type === 'tool_start' && c.toolName === 'bash');
    const hasEnd = chunks.some(c => c.type === 'tool_end' && c.toolCallId === 'tc1');
    assert.ok(hasStart, '应保留 tool_start');
    assert.ok(hasEnd, '应保留 tool_end');
    assert.equal(exec.mock.callCount(), 0, '工具不应执行');
  });

  it('beforeToolCall terminate：tool_end 之后停止，无第二轮模型调用', async () => {
    const { tool } = makeTool('bash');
    let streamFnCalls = 0;
    const streamFn: StreamFn = async function* (): AsyncGenerator<StreamEvent> {
      streamFnCalls++;
      const assistant: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc1', name: 'bash', arguments: {} }],
        stopReason: 'toolUse',
        usage: { input: 10, output: 5, total: 15 },
        timestamp: Date.now(),
      };
      yield { type: 'done', message: assistant };
    };

    const runtime = createRuntime({
      streamFn,
      tools: [tool],
      extensions: [
        createToolHookExtension({
          beforeToolCall: async ({ toolCall }) => {
            if (toolCall.name === 'bash') {
              return { block: true, reason: 'term', terminate: true };
            }
          },
        }),
      ],
    });

    const chunks: ResultChunk[] = [];
    for await (const chunk of runtime.stream(createRequest('hi', { sessionKey: 'stream-2' }))) {
      chunks.push(chunk);
    }

    assert.equal(streamFnCalls, 1, 'terminate 后不应再调用模型');
    const hasEnd = chunks.some(c => c.type === 'tool_end');
    assert.ok(hasEnd, 'terminate 前应已 yield tool_end');
    const hasDone = chunks.some(c => c.type === 'done');
    assert.ok(hasDone, '流应以 done 结束');
  });
});

// ─── 串行模式 terminate 后剩余工具 skipped ────────────────────────

describe('串行模式 terminate', () => {
  it('前序工具 terminate 后，剩余工具生成 skipped 结果保持配对', async () => {
    const { tool: toolA, exec: execA } = makeTool('toolA');
    const { tool: toolB, exec: execB } = makeTool('toolB');
    const { tool: toolC, exec: execC } = makeTool('toolC');

    // 一次返回 3 个工具调用
    const streamFn: StreamFn = async function* (): AsyncGenerator<StreamEvent> {
      const assistant: AssistantMessage = {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 't1', name: 'toolA', arguments: {} },
          { type: 'toolCall', id: 't2', name: 'toolB', arguments: {} },
          { type: 'toolCall', id: 't3', name: 'toolC', arguments: {} },
        ],
        stopReason: 'toolUse',
        usage: { input: 10, output: 5, total: 15 },
        timestamp: Date.now(),
      };
      yield { type: 'done', message: assistant };
    };

    const runtime = createRuntime({
      streamFn,
      tools: [toolA, toolB, toolC],
      parallelToolCalls: false, // 串行
      extensions: [
        createToolHookExtension({
          beforeToolCall: async ({ toolCall }) => {
            if (toolCall.name === 'toolB') {
              return { block: true, reason: 'stop here', terminate: true };
            }
          },
        }),
      ],
    });

    const result = await runtime.run(createRequest('hi', { sessionKey: 'serial-1' }));

    assert.equal(execA.mock.callCount(), 1, 'toolA 应执行');
    assert.equal(execB.mock.callCount(), 0, 'toolB 被 block 不执行');
    assert.equal(execC.mock.callCount(), 0, 'toolC 因前序 terminate 被 skip');
    assert.equal(result.stopReason, 'terminated');

    // 三个 toolCall 都应有配对的 toolResult 消息
    const msgs = runtime.getMessages('serial-1');
    const toolResults = msgs.filter(m => m.role === 'toolResult');
    assert.equal(toolResults.length, 3, '每个 toolCall 都应有配对结果');
  });
});
