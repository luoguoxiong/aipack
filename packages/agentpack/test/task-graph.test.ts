/**
 * task-graph 模块测试：buildTaskGraph / graphToMessages / analyzeToolChains /
 * findOrphanedToolCalls / getGraphStats
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTaskGraph,
  graphToMessages,
  analyzeToolChains,
  findOrphanedToolCalls,
  getGraphStats,
} from '../task-graph/index.ts';
import type { Message, AssistantMessage, ToolResultMessage } from '../core/index.ts';
import { createTextContent } from '../core/index.ts';

// ─── 辅助工厂 ─────────────────────────────────────────────────────

function userMsg(text: string, ts = Date.now()): Message {
  return { role: 'user', content: text, timestamp: ts };
}

function assistantTextMsg(text: string, ts = Date.now()): Message {
  return {
    role: 'assistant',
    content: [createTextContent(text)],
    stopReason: 'stop',
    timestamp: ts,
  } as Message;
}

function assistantWithToolCall(
  id: string,
  name: string,
  ts = Date.now(),
): Message {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: {} }],
    stopReason: 'toolUse',
    timestamp: ts,
  } as Message;
}

function toolResultMsg(
  toolCallId: string,
  toolName: string,
  isError = false,
  ts = Date.now(),
): Message {
  return {
    role: 'toolResult',
    content: [createTextContent('result')],
    toolCallId,
    toolName,
    isError,
    timestamp: ts,
  } as Message;
}

// ─── buildTaskGraph ────────────────────────────────────────────────

describe('buildTaskGraph', () => {
  it('纯文本消息构建图', () => {
    const messages = [userMsg('hi'), assistantTextMsg('hello')];
    const graph = buildTaskGraph(messages);
    assert.equal(graph.size, 2);
    assert.equal(graph.getByType('user_message').length, 1);
    assert.equal(graph.getByType('assistant_message').length, 1);
  });

  it('tool_call -> tool_result 建立依赖关系', () => {
    const messages = [
      userMsg('查天气'),
      assistantWithToolCall('tc1', 'get_weather'),
      toolResultMsg('tc1', 'get_weather'),
      assistantTextMsg('北京：晴'),
    ];
    const graph = buildTaskGraph(messages);
    assert.equal(graph.size, 4);

    // tool_result 资源应依赖 assistant_message 资源（通过 msg_<index>）
    const toolResults = graph.getByType('tool_result');
    assert.equal(toolResults.length, 1);
    assert.ok(toolResults[0].dependencies.length > 0);
  });

  it('孤立 tool_call（无 result）不建立依赖', () => {
    const messages = [
      userMsg('hi'),
      assistantWithToolCall('orphan', 'tool'),
      assistantTextMsg('done'),
    ];
    const graph = buildTaskGraph(messages);
    assert.equal(graph.size, 3);
    // 不应崩溃，tool_call 存在于 assistant 资源的 content 中
  });
});

// ─── graphToMessages ───────────────────────────────────────────────

describe('graphToMessages', () => {
  it('拓扑排序后还原消息', () => {
    const messages = [
      userMsg('a', 1000),
      assistantTextMsg('b', 1001),
      userMsg('c', 1002),
    ];
    const graph = buildTaskGraph(messages);
    const restored = graphToMessages(graph);
    assert.equal(restored.length, 3);
    // 拓扑排序应保持依赖顺序
    assert.equal(restored[0].role, 'user');
  });

  it('含工具调用的消息可还原', () => {
    const messages = [
      userMsg('do task'),
      assistantWithToolCall('tc1', 'tool'),
      toolResultMsg('tc1', 'tool'),
      assistantTextMsg('done'),
    ];
    const graph = buildTaskGraph(messages);
    const restored = graphToMessages(graph);
    assert.equal(restored.length, 4);
    // tool_result 应在 assistant(toolCall) 之后
    const tcIdx = restored.findIndex(m => m.role === 'assistant' &&
      Array.isArray(m.content) && (m.content as any[]).some(c => c.type === 'toolCall'));
    const trIdx = restored.findIndex(m => m.role === 'toolResult');
    assert.ok(tcIdx < trIdx, 'tool_result 应在 toolCall 之后');
  });
});

// ─── analyzeToolChains ─────────────────────────────────────────────

describe('analyzeToolChains', () => {
  it('完整工具链：有结果、无错误', () => {
    const messages = [
      assistantWithToolCall('tc1', 'get_weather'),
      toolResultMsg('tc1', 'get_weather'),
    ];
    const graph = buildTaskGraph(messages);
    const chains = analyzeToolChains(graph);
    assert.equal(chains.length, 1);
    assert.equal(chains[0].toolCallId, 'tc1');
    assert.equal(chains[0].toolName, 'get_weather');
    assert.equal(chains[0].hasResult, true);
    assert.equal(chains[0].isError, false);
  });

  it('错误结果标记 isError', () => {
    const messages = [
      assistantWithToolCall('tc1', 'fail_tool'),
      toolResultMsg('tc1', 'fail_tool', true),
    ];
    const graph = buildTaskGraph(messages);
    const chains = analyzeToolChains(graph);
    assert.equal(chains[0].isError, true);
  });

  it('孤立 tool_call：hasResult=false', () => {
    const messages = [
      assistantWithToolCall('orphan', 'tool'),
      assistantTextMsg('done'),
    ];
    const graph = buildTaskGraph(messages);
    const chains = analyzeToolChains(graph);
    assert.equal(chains.length, 1);
    assert.equal(chains[0].hasResult, false);
  });

  it('多个工具调用全部识别', () => {
    const messages = [
      assistantWithToolCall('tc1', 'tool1'),
      toolResultMsg('tc1', 'tool1'),
      assistantWithToolCall('tc2', 'tool2'),
      toolResultMsg('tc2', 'tool2'),
    ];
    const graph = buildTaskGraph(messages);
    const chains = analyzeToolChains(graph);
    assert.equal(chains.length, 2);
    const ids = chains.map(c => c.toolCallId).sort();
    assert.deepEqual(ids, ['tc1', 'tc2']);
  });

  it('同一 assistant 消息含多个 toolCall', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc1', name: 'tool1', arguments: {} },
          { type: 'toolCall', id: 'tc2', name: 'tool2', arguments: {} },
        ],
        stopReason: 'toolUse',
        timestamp: Date.now(),
      } as AssistantMessage,
      toolResultMsg('tc1', 'tool1'),
      toolResultMsg('tc2', 'tool2'),
    ];
    const graph = buildTaskGraph(messages);
    const chains = analyzeToolChains(graph);
    assert.equal(chains.length, 2);
  });

  it('无工具调用时返回空数组', () => {
    const messages = [userMsg('hi'), assistantTextMsg('hello')];
    const graph = buildTaskGraph(messages);
    const chains = analyzeToolChains(graph);
    assert.equal(chains.length, 0);
  });
});

// ─── findOrphanedToolCalls ─────────────────────────────────────────

describe('findOrphanedToolCalls', () => {
  it('返回无结果的 toolCall id', () => {
    const messages = [
      assistantWithToolCall('tc1', 'ok_tool'),
      toolResultMsg('tc1', 'ok_tool'),
      assistantWithToolCall('orphan', 'lost_tool'),
    ];
    const graph = buildTaskGraph(messages);
    const orphans = findOrphanedToolCalls(graph);
    assert.deepEqual(orphans, ['orphan']);
  });

  it('无孤立时返回空数组', () => {
    const messages = [
      assistantWithToolCall('tc1', 'tool'),
      toolResultMsg('tc1', 'tool'),
    ];
    const graph = buildTaskGraph(messages);
    assert.deepEqual(findOrphanedToolCalls(graph), []);
  });

  it('无工具调用时返回空数组', () => {
    const graph = buildTaskGraph([userMsg('hi')]);
    assert.deepEqual(findOrphanedToolCalls(graph), []);
  });
});

// ─── getGraphStats ─────────────────────────────────────────────────

describe('getGraphStats', () => {
  it('统计各类资源数量', () => {
    const messages = [
      userMsg('hi'),
      assistantWithToolCall('tc1', 'tool'),
      toolResultMsg('tc1', 'tool'),
      assistantTextMsg('done'),
    ];
    const graph = buildTaskGraph(messages);
    const stats = getGraphStats(graph);
    assert.equal(stats.total, 4);
    assert.ok(stats.byType['user_message'] >= 1);
    assert.ok(stats.byType['assistant_message'] >= 2);
    assert.ok(stats.byType['tool_result'] >= 1);
  });

  it('检测孤立 toolCall', () => {
    const messages = [
      assistantWithToolCall('orphan', 'tool'),
      assistantTextMsg('done'),
    ];
    const graph = buildTaskGraph(messages);
    const stats = getGraphStats(graph);
    assert.equal(stats.orphanedToolCalls, 1);
  });

  it('检测错误结果', () => {
    const messages = [
      assistantWithToolCall('tc1', 'fail_tool'),
      toolResultMsg('tc1', 'fail_tool', true),
    ];
    const graph = buildTaskGraph(messages);
    const stats = getGraphStats(graph);
    assert.equal(stats.hasErrors, true);
  });

  it('无错误时 hasErrors=false', () => {
    const messages = [userMsg('hi'), assistantTextMsg('hello')];
    const graph = buildTaskGraph(messages);
    const stats = getGraphStats(graph);
    assert.equal(stats.hasErrors, false);
  });

  it('byType 包含所有资源类型', () => {
    const messages = [userMsg('hi')];
    const graph = buildTaskGraph(messages);
    const stats = getGraphStats(graph);
    assert.equal(stats.total, 1);
    assert.equal(stats.byType['user_message'], 1);
  });
});
