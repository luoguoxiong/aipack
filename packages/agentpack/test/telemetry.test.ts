/**
 * Telemetry 可观测性测试：onRunEnd / onToolCall / onModelCall 触发与容错
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../runtime/index.ts';
import { createRequest } from '../core/index.ts';
import type {
  StreamFn,
  StreamEvent,
  Message,
  AssistantMessage,
  Tool,
} from '../core/index.ts';

// ─── mock streamFn ────────────────────────────────────────────────

function mockStreamFn(messages: Message[]): StreamFn {
  return async function* (): AsyncGenerator<StreamEvent> {
    for (const msg of messages) {
      yield { type: 'done', message: msg as AssistantMessage };
    }
  };
}

function assistant(text: string, usage?: { input: number; output: number }): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: { input: usage?.input ?? 10, output: usage?.output ?? 5, total: (usage?.input ?? 10) + (usage?.output ?? 5) },
    timestamp: Date.now(),
  };
}

const echoTool: Tool = {
  name: 'echo',
  description: '回显参数',
  inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
  execute: async (id, args) => ({ content: [{ type: 'text', text: String((args as any)?.msg ?? '') }] }),
};

// ─── onRunEnd ─────────────────────────────────────────────────────

describe('Telemetry: onRunEnd', () => {
  it('run 成功后触发，携带 request/durationMs/result', async () => {
    const onRunEnd = mock.fn(() => undefined);
    const runtime = createRuntime({
      streamFn: mockStreamFn([assistant('hello')]),
      telemetry: { onRunEnd },
    });

    const result = await runtime.run(createRequest('hi'));
    assert.equal(result.success, true);
    assert.equal(onRunEnd.mock.callCount(), 1);
    const info = onRunEnd.mock.calls[0].arguments[0];
    assert.equal(info.sessionKey, 'default');
    assert.ok(info.durationMs >= 0);
    assert.equal(info.result.success, true);
    assert.equal(info.request.message, 'hi');
  });

  it('run 失败（工具抛错被 catch）仍触发 onRunEnd', async () => {
    const onRunEnd = mock.fn(() => undefined);
    const badTool: Tool = {
      name: 'boom',
      description: '总是抛错',
      inputSchema: { type: 'object' },
      execute: async () => {
        throw new Error('boom');
      },
    };
    const streamFn = mockToolStreamFn();
    const runtime = createRuntime({
      streamFn,
      tools: [badTool],
      telemetry: { onRunEnd },
    });

    await runtime.run(createRequest('go'));
    assert.equal(onRunEnd.mock.callCount(), 1);
  });

  it('遥测回调抛错不阻断主流程', async () => {
    const runtime = createRuntime({
      streamFn: mockStreamFn([assistant('hello')]),
      telemetry: {
        onRunEnd: () => {
          throw new Error('telemetry broken');
        },
      },
    });

    const result = await runtime.run(createRequest('hi'));
    assert.equal(result.success, true, '遥测失败不应影响 run 结果');
  });
});

// ─── onToolCall ───────────────────────────────────────────────────

describe('Telemetry: onToolCall', () => {
  it('工具执行后触发，携带 toolName/args/durationMs/result', async () => {
    const onToolCall = mock.fn(() => undefined);
    const runtime = createRuntime({
      streamFn: mockToolStreamFn(),
      tools: [echoTool],
      telemetry: { onToolCall },
    });

    const result = await runtime.run(createRequest('请回显 foo'));
    assert.equal(result.success, true);
    assert.equal(onToolCall.mock.callCount(), 1);
    const info = onToolCall.mock.calls[0].arguments[0];
    assert.equal(info.toolName, 'echo');
    assert.deepEqual(info.args, { msg: 'foo' });
    assert.ok(info.durationMs >= 0);
    assert.equal(info.result.content[0].text, 'foo');
  });
});

// ─── onModelCall ──────────────────────────────────────────────────

describe('Telemetry: onModelCall', () => {
  it('模型调用后触发，携带 token 用量与耗时', async () => {
    const onModelCall = mock.fn(() => undefined);
    const runtime = createRuntime({
      streamFn: mockStreamFn([assistant('hello', { input: 33, output: 7 })]),
      telemetry: { onModelCall },
    });

    await runtime.run(createRequest('hi'));
    assert.equal(onModelCall.mock.callCount(), 1);
    const info = onModelCall.mock.calls[0].arguments[0];
    assert.equal(info.inputTokens, 33);
    assert.equal(info.outputTokens, 7);
    assert.ok(info.durationMs >= 0);
  });
});

// ─── 辅助 ─────────────────────────────────────────────────────────

/** 第一轮返回工具调用，后续返回纯文本 */
function mockToolStreamFn(): StreamFn {
  let called = 0;
  return async function* (): AsyncGenerator<StreamEvent> {
    called += 1;
    if (called === 1) {
      const toolCall: AssistantMessage = {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'echo',
            arguments: { msg: 'foo' },
          },
        ],
        stopReason: 'toolUse',
        usage: { input: 10, output: 5, total: 15 },
        timestamp: Date.now(),
      };
      yield { type: 'done', message: toolCall };
    } else {
      yield { type: 'done', message: assistant('done') };
    }
  };
}
