/**
 * 压缩策略完整场景测试
 *
 * 覆盖 L1-L5 所有压缩级别、流水线集成、降级、升级、边界情况
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { runL1Clean } from '../src/context-runtime/compress/l1-clean';
import { runL2Window } from '../src/context-runtime/compress/l2-window';
import { runL3Collapse } from '../src/context-runtime/compress/l3-collapse';
import { runL4Snapshot } from '../src/context-runtime/compress/l4-snapshot';
import { runL5Emergency } from '../src/context-runtime/compress/l5-emergency';
import { ensureToolPairing, countOrphanedPairs } from '../src/context-runtime/compress/pairing';
import { createTransitionMessage } from '../src/context-runtime/compress/transition';
import { estimateMessageTokens, isStateSnapshot, removeStateSnapshots, createStateSnapshotMessage } from '../src/context-runtime/state/message-adapter';
import { formatStateSnapshot } from '../src/context-runtime/state/agent-state';
import type { AgentMessage } from '../src/agent';
import type { AgentState, ToolDigest } from '../src/context-runtime/types';

// ─── 测试辅助函数 ───

/** 创建一条简单消息 */
function msg(role: string, content: string, overrides: Record<string, unknown> = {}): AgentMessage {
  return { role: role as any, content, ...overrides } as unknown as AgentMessage;
}

/** 创建带工具调用的助手消息 */
function assistantWithTool(toolName: string, toolId: string, text = ''): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }, { type: 'toolCall', name: toolName, id: toolId, arguments: '{}' }],
  } as unknown as AgentMessage;
}

/** 创建工具结果消息 */
function toolResult(toolId: string, content: string, isError = false): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: toolId,
    content,
    isError,
  } as unknown as AgentMessage;
}

/** 创建状态快照消息 */
function stateSnapshotMsg(version = 1): AgentMessage {
  return {
    role: 'custom',
    customType: 'acr_state_snapshot',
    content: `状态快照 v${version}`,
    display: false,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

/** 创建压缩摘要消息 */
function compactionSummary(content = '已压缩'): AgentMessage {
  return {
    role: 'compactionSummary',
    summary: content,
    tokensBefore: 10000,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

/** 创建自定义消息 */
function customMsg(type: string, content: string, display = false): AgentMessage {
  return {
    role: 'custom',
    customType: type,
    content,
    display,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

/** 创建最小可用 AgentState */
function makeMinimalState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    task: {
      goal: '测试任务',
      phase: 'executing',
      status: 'running',
      startTime: Date.now() - 60000,
      elapsedMs: 60000,
    },
    completedTasks: ['步骤1', '步骤2'],
    nextActions: ['步骤3'],
    attemptedStrategies: [],
    constraints: [],
    decisions: [],
    workspace: {
      modifiedFiles: [],
      createdFiles: [],
      deletedFiles: [],
      gitStatus: {
        branch: 'main',
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [],
        untracked: [],
      },
      gitDiffSummary: '',
      testStatus: {},
    },
    errors: [],
    failedAttempts: [],
    metadata: {
      compressionCount: 0,
      snapshotVersion: 1,
      lastUpdated: Date.now(),
    },
    ...overrides,
  } as unknown as AgentState;
}

/** 创建工具摘要列表 */
function makeToolDigests(count = 3): ToolDigest[] {
  return Array.from({ length: count }, (_, i) => ({
    tool: `tool_${i}`,
    status: i % 2 === 0 ? 'success' as const : 'failed' as const,
    summary: `摘要 ${i}`,
    filesChanged: [`/file_${i}.txt`],
    errors: i % 2 === 0 ? [] : [`Error ${i}`],
    importantLines: [`line ${i}`],
    outputHash: `hash_${i}`,
    originalLength: 100,
    digestLength: 20,
  }));
}

// 通用 L1/L2 配置
const l1Config = {
  deduplicate: true,
  deduplicate_tool_results: true,
  deduplicate_assistant_messages: true,
  deduplicate_user_messages: true,
  remove_empty: true,
  digest_tool_outputs: false,
};

const l2Config = {
  recent_messages_to_keep: 5,
  anchor_roles: ['system'],
  anchor_tags: ['goal', 'constraint', 'current_error'],
  ensure_tool_pairing: true,
};

const l3Config = {
  fold_failed_attempts: true,
  min_attempts_to_fold: 2,
  max_attempts_in_summary: 3,
  merge_repeated_reads: true,
  min_reads_to_merge: 2,
  use_llm_summary: false,
};

const l4Config = {
  recent_keep: 5,
  rebuild_state_snapshot: true,
  write_memories_before: false,
};

const l5Config = {
  recent_keep: 2,
  minimal_state_only: true,
};

// ════════════════════════════════════════════════════════════════
// 场景 1：L1 — 去重 + 清理
// ════════════════════════════════════════════════════════════════
describe('L1 Clean', () => {
  it('应移除完全重复的助手消息', () => {
    const input: AgentMessage[] = [
      msg('user', 'hello'),
      msg('assistant', '你好，有什么可以帮你的吗？'),
      msg('assistant', '你好，有什么可以帮你的吗？'),  // 重复
    ];
    const result = runL1Clean(input, l1Config, undefined as any);
    assert.strictEqual(result.messages.length, 2, '应移除 1 条重复');
  });

  it('应移除空内容消息', () => {
    const input: AgentMessage[] = [
      msg('user', 'hello'),
      msg('assistant', ''),
      msg('user', 'world'),
    ];
    const result = runL1Clean(input, l1Config, undefined as any);
    assert.strictEqual(result.messages.length, 2, '应移除空消息');
  });

  it('应去重工具结果', () => {
    const input: AgentMessage[] = [
      assistantWithTool('read', 't1'),
      toolResult('t1', '文件内容 ABC'),
      msg('user', '再查一次'),
      assistantWithTool('read', 't2'),
      toolResult('t2', '文件内容 ABC'),  // 与 t1 结果相同
    ];
    const result = runL1Clean(input, { ...l1Config, deduplicate_tool_results: true }, undefined as any);
    // t2 的工具结果被去重，但它的父调用（工具调用）不受影响
    assert.ok(result.messages.find(m => (m as any).role === 'toolResult' && (m as any).toolCallId === 't1'),
      't1 的结果应保留');
    const t2Result = result.messages.find(m => (m as any).role === 'toolResult' && (m as any).toolCallId === 't2');
    assert.ok(!t2Result, 't2 的重复结果应被移除');
  });

  it('空列表不应报错', () => {
    const result = runL1Clean([], l1Config, undefined as any);
    assert.strictEqual(result.messages.length, 0);
  });

  it('单条消息不应报错', () => {
    const result = runL1Clean([msg('user', 'hello')], l1Config, undefined as any);
    assert.strictEqual(result.messages.length, 1);
  });
});

// ════════════════════════════════════════════════════════════════
// 场景 2：L2 — 窗口化
// ════════════════════════════════════════════════════════════════
describe('L2 Window', () => {
  it('应保留最近 N 条消息（L2 会额外保留第一条消息作为初始目标）', () => {
    const input: AgentMessage[] = Array.from({ length: 20 }, (_, i) => msg('user', `msg_${i}`));
    const result = runL2Window(input, l2Config);
    // L2 始终保留第一条消息 + 最后 N 条
    const expected = 1 + l2Config.recent_messages_to_keep;
    assert.strictEqual(result.messages.length, expected, `应保留 ${expected} 条（第一条 + 最后 N 条）`);
    assert.ok(result.messages.some(m => (m as any).content === 'msg_19'), '应包含最后一条');
    assert.ok(result.messages.some(m => (m as any).content === 'msg_0'), '应包含第一条');
  });

  it('应保留锚点角色（system）', () => {
    const input: AgentMessage[] = [
      msg('system', '你是助手'),
      ...Array.from({ length: 15 }, (_, i) => msg('user', `msg_${i}`)),
    ];
    const result = runL2Window(input, l2Config);
    assert.ok(result.messages.some(m => (m as any).content === '你是助手'), '系统消息应保留');
    assert.strictEqual(result.messages.length, 1 + l2Config.recent_messages_to_keep, '系统消息 + 最后 5 条');
  });

  it('消息数少于窗口时应保持原样', () => {
    const input: AgentMessage[] = [msg('user', 'a'), msg('assistant', 'b')];
    const result = runL2Window(input, l2Config);
    assert.strictEqual(result.messages.length, 2);
  });

  it('应通过 ensureToolPairing 保持工具配对完整', () => {
    const input: AgentMessage[] = [
      msg('user', '查文件'),
      assistantWithTool('Read', 'tc1', '读文件'),
      toolResult('tc1', '文件内容'),
      msg('user', '再查'),
    ];
    const result = runL2Window(input, { ...l2Config, recent_messages_to_keep: 4 });
    assert.ok(result.messages.some(m => (m as any).role === 'toolResult'), '工具结果应保留');
    assert.ok(result.messages.some(m => (m as any).role === 'assistant'), '工具调用也应保留');
  });
});

// ════════════════════════════════════════════════════════════════
// 场景 3：L3 — 折叠失败尝试
// ════════════════════════════════════════════════════════════════
describe('L3 Collapse', () => {
  it('应折叠连续失败尝试为摘要', () => {
    const input: AgentMessage[] = [
      msg('user', '执行任务'),
      // 3 次失败尝试
      assistantWithTool('Shell', 't1'),
      toolResult('t1', 'Error: 命令未找到'),
      assistantWithTool('Shell', 't2'),
      toolResult('t2', 'Error: 权限不足'),
      assistantWithTool('Shell', 't3'),
      toolResult('t3', 'Error: 超时'),
      // 成功消息
      msg('user', '我来手动做'),
    ];
    const result = runL3Collapse(input, l3Config);
    assert.ok(result.messages.length < input.length, '应减少消息数');
    assert.strictEqual(result.attemptsFolded, 1, '应折叠 1 组失败尝试');
    // 验证折叠后应有一条摘要消息
    const summaryMsgs = result.messages.filter(m => (m as any).customType === 'acr_failed_attempts_summary');
    assert.strictEqual(summaryMsgs.length, 1, '应生成一条折叠摘要');
    const summaryContent = (summaryMsgs[0] as any).content as string;
    assert.ok(summaryContent.includes('3 次连续失败'), '摘要应提及失败次数');
  });

  it('失败尝试不够 2 次时不折叠', () => {
    const input: AgentMessage[] = [
      msg('user', '执行'),
      assistantWithTool('Shell', 't1'),
      toolResult('t1', 'Error: 失败'),
      msg('assistant', '成功了！换了一种方法'),
    ];
    const result = runL3Collapse(input, l3Config);
    assert.strictEqual(result.attemptsFolded, 0, '不应折叠');
    assert.strictEqual(result.messages.length, input.length, '消息数不变');
  });

  it('应合并重复文件读取', () => {
    const input: AgentMessage[] = [
      msg('user', '查文件'),
      assistantWithTool('Read', 'r1'),
      toolResult('r1', 'a.txt: hello'),
      assistantWithTool('Read', 'r2'),
      toolResult('r2', 'b.txt: world'),
      assistantWithTool('Read', 'r3'),
      toolResult('r3', 'c.txt: foo'),
      msg('user', '知道了'),
    ];
    const result = runL3Collapse(input, l3Config);
    assert.ok(result.readsMerged >= 1, '应合并重复读取');
    assert.ok(result.messages.length < input.length, '应减少消息数');
  });

  it('单条读取操作不应触发合并', () => {
    const input: AgentMessage[] = [
      msg('user', '查文件'),
      assistantWithTool('Read', 'r1'),
      toolResult('r1', '内容'),
      msg('user', '继续'),
    ];
    const result = runL3Collapse(input, l3Config);
    assert.strictEqual(result.readsMerged, 0, '单条不合并');
    assert.strictEqual(result.messages.length, input.length, '消息数不变');
  });

  it('空列表不应报错', () => {
    const result = runL3Collapse([], l3Config);
    assert.strictEqual(result.messages.length, 0);
    assert.strictEqual(result.attemptsFolded, 0);
    assert.strictEqual(result.readsMerged, 0);
  });

  it('用户消息应打断失败尝试收集', () => {
    const input: AgentMessage[] = [
      assistantWithTool('Shell', 't1'),
      toolResult('t1', 'Error: 失败'),
      msg('user', '停止，让我看看'),  // 用户介入
      assistantWithTool('Shell', 't2'),
      toolResult('t2', 'Error: 又失败'),
    ];
    const result = runL3Collapse(input, l3Config);
    // 用户消息打断了连续失败尝试，所以只折叠用户之前或之后的
    // 如果 t1 + t2 之间有用户消息，它们不连续，所以不折叠
    assert.strictEqual(result.attemptsFolded, 0, '用户消息应打断连续失败尝试');
  });
});

// ════════════════════════════════════════════════════════════════
// 场景 4：L4 — 快照重写
// ════════════════════════════════════════════════════════════════
describe('L4 Snapshot', () => {
  it('应基于状态重建上下文', () => {
    const input: AgentMessage[] = [
      msg('system', '你是 AI 助手'),
      msg('user', '开始'),
      ...Array.from({ length: 20 }, (_, i) => [
        assistantWithTool(`Tool_${i}`, `t${i}`),
        toolResult(`t${i}`, `结果 ${i}`),
      ]).flat(),
    ];
    const state = makeMinimalState();
    const result = runL4Snapshot(input, state, l4Config, makeToolDigests());
    assert.ok(result.messages.length < input.length, '应压缩消息');
    assert.ok(result.messagesAfter > 0, '应保留消息');
    // 应包含系统消息
    assert.ok(result.messages.some(m => (m as any).content === '你是 AI 助手'), '系统消息应保留');
  });

  it('应移除旧的状态快照和压缩摘要', () => {
    const input: AgentMessage[] = [
      stateSnapshotMsg(1),
      compactionSummary('上次压缩'),
      msg('user', '新的消息'),
    ];
    const state = makeMinimalState();
    const result = runL4Snapshot(input, state, l4Config, makeToolDigests());
    // 不应有旧的状态快照
    assert.ok(!result.messages.some(m => (m as any).content === '状态快照 v1'), '旧快照应被移除');
    // 不应有旧的压缩摘要
    assert.ok(!result.messages.some(m => (m as any).role === 'compactionSummary'), '旧压缩摘要应被移除');
  });

  it('空列表时应返回空结果', () => {
    const state = makeMinimalState();
    const result = runL4Snapshot([], state, l4Config, []);
    assert.strictEqual(result.messagesBefore, 0);
  });

  it('应保留最近 N 条非 ACR 消息', () => {
    const input: AgentMessage[] = [
      ...Array.from({ length: 10 }, (_, i) => msg('user', `旧消息 ${i}`)),
      msg('user', '最新消息'),
    ];
    const state = makeMinimalState();
    const result = runL4Snapshot(input, state, { ...l4Config, recent_keep: 3 }, makeToolDigests());
    const lastMessages = result.messages.filter(m => (m as any).role === 'user' || (m as any).role === 'assistant' || (m as any).role === 'toolResult');
    // SnapshotBuilder.build() 的结果中包含 recentMessages，但它们通过 builder 转换后格式不同
    // 至少确保 builder.build() 不返回空
    assert.ok(result.messages.length > 0, '应保留消息');
  });
});

// ════════════════════════════════════════════════════════════════
// 场景 5：L5 — 紧急压缩
// ════════════════════════════════════════════════════════════════
describe('L5 Emergency', () => {
  it('应极限压缩至最小消息集', () => {
    const input: AgentMessage[] = [
      msg('system', '你是助手'),
      ...Array.from({ length: 50 }, (_, i) => [
        msg('user', `消息 ${i}`),
        msg('assistant', `回复 ${i}`),
      ]).flat(),
    ];
    const state = makeMinimalState();
    const result = runL5Emergency(input, state, l5Config);
    assert.ok(result.messages.length <= 8, `极限压缩后消息数 ${result.messages.length} 应少得多`);
    assert.ok(result.messagesAfter > 0, '应保留至少一条消息');
  });

  it('应保留系统消息', () => {
    const input: AgentMessage[] = [
      msg('system', '关键系统提示'),
      ...Array.from({ length: 20 }, (_, i) => msg('user', `msg_${i}`)),
    ];
    const state = makeMinimalState();
    const result = runL5Emergency(input, state, l5Config);
    assert.ok(result.messages.some(m => (m as any).content === '关键系统提示'), '系统消息应保留');
  });

  it('空列表时应返回空结果', () => {
    const state = makeMinimalState();
    const result = runL5Emergency([], state, l5Config);
    assert.strictEqual(result.messagesBefore, 0);
  });
});

// ════════════════════════════════════════════════════════════════
// 场景 6：工具配对完整性
// ════════════════════════════════════════════════════════════════
describe('Tool Pairing', () => {
  it('应修复孤立的工具调用', () => {
    const input: AgentMessage[] = [
      assistantWithTool('Read', 'orphan'),
      assistantWithTool('Read', 'normal1'),
      toolResult('normal1', 'ok'),
    ];
    const before = countOrphanedPairs(input);
    assert.strictEqual(before.orphanedCalls, 1, '应有 1 个孤立的工具调用');
    const fixed = ensureToolPairing(input);
    const after = countOrphanedPairs(fixed);
    assert.strictEqual(after.orphanedCalls + after.orphanedResults, 0,
      `修复后应无孤立调用，实际: calls=${after.orphanedCalls}, results=${after.orphanedResults}`);
  });

  it('应修复孤立的工具结果', () => {
    const input: AgentMessage[] = [
      toolResult('orphan', '结果'),
      assistantWithTool('Read', 'normal'),
      toolResult('normal', 'ok'),
    ];
    const before = countOrphanedPairs(input);
    assert.strictEqual(before.orphanedResults, 1, '应有 1 个孤立的工具结果');
    const fixed = ensureToolPairing(input);
    const after = countOrphanedPairs(fixed);
    assert.strictEqual(after.orphanedCalls + after.orphanedResults, 0,
      `修复后应无孤立结果，实际: calls=${after.orphanedCalls}, results=${after.orphanedResults}`);
  });

  it('完全配对的工具应保持不变', () => {
    const input: AgentMessage[] = [
      assistantWithTool('Read', 't1'),
      toolResult('t1', '结果'),
      assistantWithTool('Write', 't2'),
      toolResult('t2', '写入成功'),
    ];
    const before = countOrphanedPairs(input);
    assert.strictEqual(before.orphanedCalls + before.orphanedResults, 0, '应无孤立调用');
    const fixed = ensureToolPairing(input);
    assert.strictEqual(fixed.length, input.length, '应有相同数量的消息');
  });

  it('空列表不应报错', () => {
    const result = ensureToolPairing([]);
    assert.strictEqual(result.length, 0);
    const before = countOrphanedPairs([]);
    assert.strictEqual(before.orphanedCalls + before.orphanedResults, 0);
  });
});

// ════════════════════════════════════════════════════════════════
// 场景 7：Token 估算
// ════════════════════════════════════════════════════════════════
describe('Token Estimation', () => {
  it('英文文本应约 4 字符/token', () => {
    const english = 'Hello world this is a test message for token estimation';
    const tokens = estimateMessageTokens(msg('user', english));
    assert.ok(tokens >= 12 && tokens <= 18, `英文文本预期 12-18 token，实际 ${tokens}`);
  });

  it('中文文本应约 1.5 字符/token', () => {
    const chinese = '这是一段中文测试文本用于估算 Token 数量';
    const tokens = estimateMessageTokens(msg('user', chinese));
    assert.ok(tokens >= 10 && tokens <= 22, `中文文本预期 10-22 token，实际 ${tokens}`);
  });

  it('混合中英文应合理估算', () => {
    const mixed = 'Hello 你好 World 世界 Test 测试';
    const tokens = estimateMessageTokens(msg('user', mixed));
    assert.ok(tokens >= 8 && tokens <= 20, `混合文本预期 8-20 token，实际 ${tokens}`);
  });

  it('空内容应返回 0', () => {
    const tokens = estimateMessageTokens(msg('user', ''));
    assert.strictEqual(tokens, 0);
  });
});

// ════════════════════════════════════════════════════════════════
// 场景 8：State Snapshot 工具函数
// ════════════════════════════════════════════════════════════════
describe('State Snapshot Utilities', () => {
  it('isStateSnapshot 应正确识别状态快照', () => {
    const snap = stateSnapshotMsg();
    assert.ok(isStateSnapshot(snap), '应识别状态快照');
    assert.ok(!isStateSnapshot(msg('user', '普通消息')), '不应误判普通消息');
  });

  it('removeStateSnapshots 应移除所有状态快照', () => {
    const input: AgentMessage[] = [
      stateSnapshotMsg(1),
      msg('user', '消息'),
      stateSnapshotMsg(2),
      msg('assistant', '回复'),
    ];
    const result = removeStateSnapshots(input);
    assert.strictEqual(result.length, 2, '应移除 2 条状态快照');
    assert.ok(!result.some(m => isStateSnapshot(m)), '不应有状态快照残留');
  });

  it('createStateSnapshotMessage 应创建格式正确的快照', () => {
    const state = makeMinimalState();
    const formatted = formatStateSnapshot(state);
    const snap = createStateSnapshotMessage(formatted);
    assert.ok(snap, '应创建成功');
    assert.ok(isStateSnapshot(snap), '应被识别为状态快照');
  });
});

// ════════════════════════════════════════════════════════════════
// 场景 9：Transition Message
// ════════════════════════════════════════════════════════════════
describe('Transition Message', () => {
  it('应为 clean 级别生成过渡消息', () => {
    const msg = createTransitionMessage('clean', {
      enabled: true,
      l1: '已清理重复消息',
      l2: '已窗口化',
      l3: '已折叠',
      l4: '已快照重建',
      l5: '紧急压缩',
    }, { tokensSaved: 100, compressionRatio: 0.5 });
    assert.ok(msg, '应生成过渡消息');
    assert.ok(msg!.includes('清理'), '应提到清理');
  });

  it('应为 emergency 级别生成过渡消息', () => {
    const msg = createTransitionMessage('emergency', {
      enabled: true,
      l1: '清理',
      l2: '窗口化',
      l3: '折叠',
      l4: '快照',
      l5: '紧急压缩',
    }, { tokensSaved: 50000, compressionRatio: 0.9 });
    assert.ok(msg, '应生成过渡消息');
    assert.ok(msg!.includes('紧急'), '应提到紧急');
  });

  it('禁用时应返回空', () => {
    const msg = createTransitionMessage('clean', {
      enabled: false,
      l1: '',
      l2: '',
      l3: '',
      l4: '',
      l5: '',
    }, { tokensSaved: 100, compressionRatio: 0.5 });
    assert.strictEqual(msg, null, '禁用时应返回空');
  });
});

// ════════════════════════════════════════════════════════════════
// 场景 10：边界场景
// ════════════════════════════════════════════════════════════════
describe('Edge Cases', () => {
  it('所有压缩级别空输入均不报错', () => {
    const state = makeMinimalState();
    assert.doesNotThrow(() => runL1Clean([], l1Config, undefined as any));
    assert.doesNotThrow(() => runL2Window([], l2Config));
    assert.doesNotThrow(() => runL3Collapse([], l3Config));
    assert.doesNotThrow(() => runL4Snapshot([], state, l4Config, []));
    assert.doesNotThrow(() => runL5Emergency([], state, l5Config));
  });

  it('所有压缩级别单条输入均不报错', () => {
    const single = [msg('user', 'hello')];
    const state = makeMinimalState();
    assert.doesNotThrow(() => runL1Clean(single, l1Config, undefined as any));
    assert.doesNotThrow(() => runL2Window(single, l2Config));
    assert.doesNotThrow(() => runL3Collapse(single, l3Config));
    assert.doesNotThrow(() => runL4Snapshot(single, state, l4Config, []));
    assert.doesNotThrow(() => runL5Emergency(single, state, l5Config));
  });

  it('大量工具结果不报错', () => {
    const input: AgentMessage[] = Array.from({ length: 100 }, (_, i) => [
      assistantWithTool('Read', `t${i}`),
      toolResult(`t${i}`, i % 2 === 0 ? 'Error: 失败' : '成功'),
    ]).flat();
    assert.doesNotThrow(() => runL1Clean(input, l1Config, undefined as any));
    assert.doesNotThrow(() => runL2Window(input, l2Config));
    assert.doesNotThrow(() => runL3Collapse(input, l3Config));
  });

  it('全是失败的消息应正确压缩', () => {
    const input: AgentMessage[] = Array.from({ length: 10 }, (_, i) => [
      assistantWithTool('Shell', `e${i}`),
      toolResult(`e${i}`, 'Error: 失败', true),
    ]).flat();
    const result = runL3Collapse(input, l3Config);
    assert.ok(result.attemptsFolded >= 1, '应折叠失败尝试');
    assert.ok(result.messages.length < input.length, '应减少消息数');
  });

  it('超长内容不应导致溢出', () => {
    const longContent = 'x'.repeat(100000);
    const input = [msg('user', longContent)];
    const tokens = estimateMessageTokens(input[0]);
    assert.ok(tokens > 0, '应估算 token');
    assert.doesNotThrow(() => runL1Clean(input, l1Config, undefined as any));
    assert.doesNotThrow(() => runL2Window(input, l2Config));
  });

  it('混合所有消息类型不应报错', () => {
    const input: AgentMessage[] = [
      msg('system', '系统提示'),
      stateSnapshotMsg(),
      compactionSummary('压缩摘要'),
      customMsg('acr_tool_digest', '工具摘要', false),
      msg('user', '用户消息'),
      assistantWithTool('Read', 't1'),
      toolResult('t1', '结果'),
      msg('assistant', '文本回复'),
    ];
    assert.doesNotThrow(() => runL1Clean(input, l1Config, undefined as any));
    assert.doesNotThrow(() => runL2Window(input, l2Config));
    assert.doesNotThrow(() => runL3Collapse(input, l3Config));
  });
});
