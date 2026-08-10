/**
 * result 模块测试：buildResultFromMessages / buildResultFromAssistantMessage /
 * buildResultWithResources / ResultAggregator
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildResultFromMessages,
  buildResultFromAssistantMessage,
  buildResultWithResources,
  ResultAggregator,
} from '../result/index.ts';
import type { Message, AssistantMessage, ToolResultMessage, ResultChunk, ContextResource } from '../core/index.ts';
import { createTextContent } from '../core/index.ts';

// ─── 辅助工厂 ─────────────────────────────────────────────────────

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

function assistantMsg(text: string, usage = { input: 10, output: 5, total: 15 }): AssistantMessage {
  return {
    role: 'assistant',
    content: [createTextContent(text)],
    stopReason: 'stop',
    usage,
    timestamp: Date.now(),
  };
}

function toolResultMsg(toolName: string, toolCallId = 'tc1'): ToolResultMessage {
  return {
    role: 'toolResult',
    content: [createTextContent('result')],
    toolCallId,
    toolName,
    isError: false,
    timestamp: Date.now(),
  };
}

// ─── buildResultFromMessages ───────────────────────────────────────

describe('buildResultFromMessages', () => {
  it('从消息列表提取最终回复', () => {
    const messages = [userMsg('hi'), assistantMsg('hello')];
    const result = buildResultFromMessages(messages);
    assert.equal(result.content, 'hello');
    assert.equal(result.stopReason, 'stop');
    assert.equal(result.success, true);
  });

  it('累加 usage', () => {
    const messages = [
      assistantMsg('a', { input: 10, output: 5, total: 15 }),
      assistantMsg('b', { input: 20, output: 10, total: 30 }),
    ];
    const result = buildResultFromMessages(messages);
    assert.equal(result.usage.input, 30);
    assert.equal(result.usage.output, 15);
    assert.equal(result.usage.total, 45);
  });

  it('提取 toolsUsed（去重）', () => {
    const messages = [
      userMsg('do'),
      toolResultMsg('tool_a', 'tc1'),
      toolResultMsg('tool_b', 'tc2'),
      toolResultMsg('tool_a', 'tc3'), // 重复
      assistantMsg('done'),
    ];
    const result = buildResultFromMessages(messages);
    assert.deepEqual(result.toolsUsed, ['tool_a', 'tool_b']);
  });

  it('错误消息标记 success=false', () => {
    const messages = [
      {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'API failed',
        timestamp: Date.now(),
      } as AssistantMessage,
    ];
    const result = buildResultFromMessages(messages);
    assert.equal(result.error, 'API failed');
    assert.equal(result.success, false);
    assert.equal(result.stopReason, 'error');
  });

  it('空消息列表返回默认结果', () => {
    const result = buildResultFromMessages([]);
    assert.equal(result.content, '');
    assert.equal(result.stopReason, 'completed');
    assert.deepEqual(result.toolsUsed, []);
  });
});

// ─── buildResultFromAssistantMessage ───────────────────────────────

describe('buildResultFromAssistantMessage', () => {
  it('从单条 assistant 消息构建结果', () => {
    const msg = assistantMsg('reply', { input: 10, output: 5, total: 15 });
    const result = buildResultFromAssistantMessage(msg, ['tool_a']);
    assert.equal(result.content, 'reply');
    assert.deepEqual(result.toolsUsed, ['tool_a']);
    assert.equal(result.usage.input, 10);
    assert.equal(result.usage.output, 5);
    assert.equal(result.usage.total, 15);
  });

  it('stopReason 缺省时用 completed', () => {
    const msg: AssistantMessage = {
      role: 'assistant',
      content: [createTextContent('hi')],
      timestamp: Date.now(),
    };
    const result = buildResultFromAssistantMessage(msg, []);
    assert.equal(result.stopReason, 'completed');
  });

  it('errorMessage 标记错误', () => {
    const msg: AssistantMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'failed',
      timestamp: Date.now(),
    };
    const result = buildResultFromAssistantMessage(msg, []);
    assert.equal(result.error, 'failed');
    assert.equal(result.success, false);
  });

  it('无 usage 时不设置 usage', () => {
    const msg: AssistantMessage = {
      role: 'assistant',
      content: [createTextContent('hi')],
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    const result = buildResultFromAssistantMessage(msg, []);
    assert.deepEqual(result.usage, {});
  });
});

// ─── buildResultWithResources ──────────────────────────────────────

describe('buildResultWithResources', () => {
  it('构建带资源快照的结果', () => {
    const resources: ContextResource[] = [
      {
        id: 'r1',
        type: 'user_message',
        role: 'user',
        content: 'hi',
        timestamp: 0,
        dependencies: [],
        meta: {},
        pinned: false,
      },
    ];
    const result = buildResultWithResources('reply', ['t1'], resources, {
      usage: { input: 1, output: 1, total: 2 },
      stopReason: 'stop',
    });
    assert.equal(result.content, 'reply');
    assert.deepEqual(result.toolsUsed, ['t1']);
    assert.ok(result.resources);
    assert.equal(result.resources!.length, 1);
    assert.equal(result.usage.input, 1);
    assert.equal(result.stopReason, 'stop');
  });

  it('无 options 时使用默认值', () => {
    const result = buildResultWithResources('hi', [], []);
    assert.equal(result.stopReason, 'completed');
    assert.equal(result.success, true);
    assert.equal(result.error, undefined);
  });

  it('error option 标记失败', () => {
    const result = buildResultWithResources('', [], [], { error: 'boom' });
    assert.equal(result.error, 'boom');
    assert.equal(result.success, false);
  });
});

// ─── ResultAggregator ──────────────────────────────────────────────

describe('ResultAggregator', () => {
  it('聚合 text chunk', () => {
    const agg = new ResultAggregator();
    agg.push({ type: 'text', content: 'hel' });
    agg.push({ type: 'text', content: 'lo' });
    const result = agg.build();
    assert.equal(result.content, 'hello');
  });

  it('聚合 tool_start 记录工具名（去重）', () => {
    const agg = new ResultAggregator();
    agg.push({ type: 'tool_start', toolName: 'tool_a', toolCallId: 'tc1' });
    agg.push({ type: 'tool_start', toolName: 'tool_b', toolCallId: 'tc2' });
    agg.push({ type: 'tool_start', toolName: 'tool_a', toolCallId: 'tc3' });
    const result = agg.build();
    assert.deepEqual(result.toolsUsed, ['tool_a', 'tool_b']);
  });

  it('error chunk 标记失败', () => {
    const agg = new ResultAggregator();
    agg.push({ type: 'text', content: 'partial' });
    agg.push({ type: 'error', content: 'exploded' });
    agg.push({ type: 'done' });
    const result = agg.build();
    assert.equal(result.error, 'exploded');
    assert.equal(result.stopReason, 'error');
    assert.equal(result.success, false);
    assert.equal(result.content, 'partial');
  });

  it('done chunk 设 stopReason=completed（无错误时）', () => {
    const agg = new ResultAggregator();
    agg.push({ type: 'text', content: 'ok' });
    agg.push({ type: 'done' });
    const result = agg.build();
    assert.equal(result.stopReason, 'completed');
    assert.equal(result.success, true);
  });

  it('totalChunks 统计', () => {
    const agg = new ResultAggregator();
    agg.push({ type: 'text', content: 'a' });
    agg.push({ type: 'text', content: 'b' });
    agg.push({ type: 'done' });
    assert.equal(agg.totalChunks, 3);
  });

  it('reset 清空状态', () => {
    const agg = new ResultAggregator();
    agg.push({ type: 'text', content: 'data' });
    agg.reset();
    assert.equal(agg.totalChunks, 0);
    const result = agg.build();
    assert.equal(result.content, '');
  });

  it('tool_end chunk 不影响结果', () => {
    const agg = new ResultAggregator();
    agg.push({ type: 'tool_start', toolName: 't', toolCallId: 'tc1' });
    agg.push({ type: 'tool_end', toolName: 't', toolCallId: 'tc1', isError: false });
    const result = agg.build();
    assert.deepEqual(result.toolsUsed, ['t']);
  });

  it('空 content 的 text chunk 被忽略', () => {
    const agg = new ResultAggregator();
    agg.push({ type: 'text', content: '' });
    agg.push({ type: 'text', content: 'hi' });
    const result = agg.build();
    assert.equal(result.content, 'hi');
  });
});
