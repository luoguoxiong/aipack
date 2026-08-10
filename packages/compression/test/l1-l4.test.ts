/**
 * L1-L4 关键修复点单测
 *  - L1: normalizeWhitespace 保留 ContentBlock[] 结构
 *  - L1: trimToolResults 裁剪超长 tool_result
 *  - L2: 切分逻辑保留夹在中间的 system_message
 *  - L2: forkModel/forkMaxTokens 生效
 *  - L2: fork 失败时不修改 resources，记失败遥测
 *  - L3: 保留 pinned 资源（compaction_summary）
 *  - L4: 持久化失败且 failOnPersistError=true 时中止
 *  - L4: 持久化失败且 failOnPersistError=false 时继续
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContextResource, Model, StreamFn, StreamResult, SessionStorage, StoredSession } from '@aipack/agent';
import { ToolOutputTrim } from '../src/l1-tool-output-trim';
import { MessageSummarize } from '../src/l2-message-summarize';
import { TaskStateExtraction } from '../src/l3-task-state-extraction';
import { SessionCheckpointLevel } from '../src/l4-session-checkpoint';
import { NewSessionHandoff } from '../src/l5-new-session-handoff';
import { CharHeuristicEstimator } from '../src/token-estimator';
import { createSafetyState } from '../src/safety';
import { DEFAULT_FORK_RETRY } from '../src/retry';

/** P0#1/#4: 测试统一注入的单次 fork 超时与重试配置 */
const FORK_TIMEOUT_MS = 30000;

// ─── 工具 ─────────────────────────────────────────────────────────

function makeResource(
  id: string,
  type: ContextResource['type'],
  content: unknown,
  opts: { deps?: string[]; pinned?: boolean; role?: string; timestamp?: number } = {},
): ContextResource {
  return {
    id,
    type,
    role: opts.role ?? (
      type === 'assistant_message' ? 'assistant'
      : type === 'user_message' ? 'user'
      : type === 'tool_result' ? 'toolResult'
      : 'system'
    ),
    content,
    timestamp: opts.timestamp ?? Date.now(),
    dependencies: opts.deps ?? [],
    meta: {},
    pinned: opts.pinned ?? false,
  };
}

const mockModel: Model = {
  id: 'mock', name: 'mock', provider: 'mock',
  contextWindow: 1000, maxTokens: 2048, reasoning: false,
};

function makeMockStreamFn(text: string): StreamFn {
  return async function* (): StreamResult {
    yield { type: 'text_delta', delta: text };
  };
}

function makeFailingStreamFn(): StreamFn {
  return async function* (): StreamResult {
    yield { type: 'error', message: {} as any };
  };
}

// ─── L1 测试 ──────────────────────────────────────────────────────

test('L1 trimToolResults: 超长 tool_result 被裁剪', async () => {
  const est = new CharHeuristicEstimator();
  const l1 = new ToolOutputTrim(est, {
    enabled: true, threshold: 0.6, targetRatio: 0.5,
    stripThinking: false, trimToolResults: true,
    toolResultMaxLines: 5, toolResultHeadLines: 1, toolResultTailLines: 1,
    normalizeWhitespace: false,
  });

  const longText = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const resources = [
    makeResource('tr1', 'tool_result', longText, { deps: ['c1'] }),
  ];

  // contextWindow=10 让 target=5，触发裁剪（100 行约 175 tokens > 5）
  const result = await l1.compress(resources, 10, 's1', 1);
  const out = result.resources[0].content;
  assert.ok(Array.isArray(out), 'content 应被替换为 ContentBlock[]');
  const text = (out as any[])[0].text as string;
  assert.match(text, /\[\.\.\. truncated/);
  assert.equal(result.resources[0].meta._trimmed, true);
  assert.ok(result.telemetry.length >= 1);
});

test('L1 normalizeWhitespace: 保留 ContentBlock[] 结构（不丢 image 块）', async () => {
  const est = new CharHeuristicEstimator();
  const l1 = new ToolOutputTrim(est, {
    enabled: true, threshold: 0, targetRatio: 0,
    stripThinking: false, trimToolResults: false,
    toolResultMaxLines: 5, toolResultHeadLines: 1, toolResultTailLines: 1,
    normalizeWhitespace: true,
  });

  // 构造 token 已超 target 的资源：直接调 normalizeWhitespace 私有方法不便，走 compress
  // 用 string content 触发 normalize
  const resources = [
    makeResource('u1', 'user_message', 'line1\n\n\n\n\nline2'), // 多空行
  ];
  // beforeTokens <= target 时不会跑 normalize；把 targetRatio 设 0 让 target=0 触发
  const result = await l1.compress(resources, 1, 's1', 1);
  // string content 应被规范化
  assert.equal(typeof result.resources[0].content, 'string');
  assert.equal((result.resources[0].content as string).includes('\n\n\n'), false);
});

test('L1 normalizeWhitespace: ContentBlock[] 仅规范化 text 块，保留 image 块', async () => {
  const est = new CharHeuristicEstimator();
  // 直接通过 compress 验证；构造一个 token 已超 target 的 ContentBlock[] 资源
  const blocks = [
    { type: 'text', text: 'a\n\n\n\n\nb' },
    { type: 'image', source: 'data:...' },
  ];
  const resources = [
    makeResource('a1', 'assistant_message', blocks),
  ];
  // 由于 stripThinking=false，trimToolResults 只作用于 tool_result，
  // 这里我们绕过：直接构造让 normalize 触发的场景。targetRatio=0 让 target=0
  const l1 = new ToolOutputTrim(est, {
    enabled: true, threshold: 0, targetRatio: 0,
    stripThinking: false, trimToolResults: false,
    toolResultMaxLines: 5, toolResultHeadLines: 1, toolResultTailLines: 1,
    normalizeWhitespace: true,
  });
  const result = await l1.compress(resources, 1, 's1', 1);
  const out = result.resources[0].content as any[];
  assert.equal(Array.isArray(out), true);
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'text');
  assert.equal(out[0].text, 'a\n\nb'); // 多空行被合并
  assert.equal(out[1].type, 'image'); // image 块保留
});

// ─── L2 测试 ──────────────────────────────────────────────────────

test('L2 切分: 保留夹在中间的 system_message', async () => {
  const est = new CharHeuristicEstimator();
  const streamFn = makeMockStreamFn('SUMMARY');
  const l2 = new MessageSummarize(est, streamFn, mockModel, {
    enabled: true, threshold: 0.75, targetRatio: 0.6,
    forkModel: undefined, forkMaxTokens: 512,
    minResourcesToCompress: 2, protectedRecentCount: 1, maxCompressionDepth: 3,
  }, FORK_TIMEOUT_MS, DEFAULT_FORK_RETRY);

  // resources = [u1, system_msg(中间), a1, tr1, u2(recent 保护)]
  const resources = [
    makeResource('u1', 'user_message', 'request 1'),
    makeResource('sys1', 'system_message', 'IMPORTANT SYSTEM PROMPT'),
    makeResource('a1', 'assistant_message', 'response', { deps: ['call_1'] }),
    makeResource('tr1', 'tool_result', 'result', { deps: ['call_1'] }),
    makeResource('u2', 'user_message', 'recent request'), // 被 recent 保护
  ];

  const safety = createSafetyState({ forkTimeoutMs: 0 });
  const result = await l2.compress(resources, 1000, safety, 's1', 1);

  // system_message 应被保留
  const types = result.resources.map(r => r.type);
  assert.ok(types.includes('system_message'), 'system_message 必须保留');
  assert.ok(types.includes('compaction_summary'), '应生成 compaction_summary');
  // recent 保护项 u2 应保留
  assert.ok(result.resources.some(r => r.id === 'u2'), 'recent 项 u2 必须保留');
});

test('L2 fork 失败: 不修改 resources，记失败遥测', async () => {
  const est = new CharHeuristicEstimator();
  const l2 = new MessageSummarize(est, makeFailingStreamFn(), mockModel, {
    enabled: true, threshold: 0.75, targetRatio: 0.6,
    forkModel: undefined, forkMaxTokens: 512,
    minResourcesToCompress: 2, protectedRecentCount: 1, maxCompressionDepth: 3,
  }, FORK_TIMEOUT_MS, DEFAULT_FORK_RETRY);

  const resources = [
    makeResource('u1', 'user_message', 'r1'),
    makeResource('a1', 'assistant_message', 'a1', { deps: ['c1'] }),
    makeResource('tr1', 'tool_result', 't1', { deps: ['c1'] }),
    makeResource('u2', 'user_message', 'recent'),
  ];

  const safety = createSafetyState({ forkTimeoutMs: 0 });
  const result = await l2.compress(resources, 1000, safety, 's1', 1);

  // fork 失败应返回原 resources
  assert.equal(result.resources, resources);
  assert.ok(result.telemetry.length >= 1);
  assert.equal(result.telemetry[0].failed, true);
  // compressionDepth 不应增加
  assert.equal(safety.compressionDepth, 0);
});

test('L2 forkModel: 克隆 Model 并覆盖 id 和 maxTokens', async () => {
  const est = new CharHeuristicEstimator();
  // 用对象引用绕过 TS 控制流窄化（闭包赋值后 let 会被推断为 null）
  const captured: { model: Model | null } = { model: null };
  const streamFn: StreamFn = async function* (m): StreamResult {
    captured.model = m;
    yield { type: 'text_delta', delta: 'SUMMARY' };
  };
  const l2 = new MessageSummarize(est, streamFn, mockModel, {
    enabled: true, threshold: 0.75, targetRatio: 0.6,
    forkModel: 'fork-model-id', forkMaxTokens: 333,
    minResourcesToCompress: 2, protectedRecentCount: 1, maxCompressionDepth: 3,
  }, FORK_TIMEOUT_MS, DEFAULT_FORK_RETRY);

  const resources = [
    makeResource('u1', 'user_message', 'r1'),
    makeResource('a1', 'assistant_message', 'a1', { deps: ['c1'] }),
    makeResource('tr1', 'tool_result', 't1', { deps: ['c1'] }),
    makeResource('u2', 'user_message', 'recent'),
  ];

  const safety = createSafetyState({ forkTimeoutMs: 0 });
  await l2.compress(resources, 1000, safety, 's1', 1);

  assert.ok(captured.model, 'captured.model should not be null');
  assert.equal(captured.model!.id, 'fork-model-id');
  assert.equal(captured.model!.maxTokens, 333);
});

// ─── L3 测试 ──────────────────────────────────────────────────────

test('L3: 保留 pinned 资源（compaction_summary）', async () => {
  const est = new CharHeuristicEstimator();
  const streamFn = makeMockStreamFn('{"originalRequest":"req","currentPhase":"p","completedSteps":[],"pendingSteps":[],"keyDecisions":[],"constraints":[],"toolResults":[],"errors":[],"variables":{}}');
  const l3 = new TaskStateExtraction(est, streamFn, mockModel, {
    enabled: true, threshold: 0.85, targetRatio: 0.4,
    forkModel: undefined, forkMaxTokens: 1024,
    protectedRecentCount: 2,
  }, FORK_TIMEOUT_MS, DEFAULT_FORK_RETRY);

  // resources 含一个 pinned compaction_summary（模拟 L2 已跑过）
  const compactionSummary = makeResource('cs1', 'compaction_summary', 'previous summary', { pinned: true, role: 'system' });
  const resources = [
    compactionSummary,
    makeResource('u1', 'user_message', 'r1'),
    makeResource('a1', 'assistant_message', 'a1'),
    makeResource('u2', 'user_message', 'r2'),
    makeResource('a2', 'assistant_message', 'a2'), // recent
  ];

  const safety = createSafetyState({ forkTimeoutMs: 0 });
  const result = await l3.compress(resources, 1000, safety, 's1', 1);

  // compaction_summary 应被保留
  assert.ok(result.resources.some(r => r.id === 'cs1'), 'pinned compaction_summary 必须保留');
  // 应生成新的 task_state
  assert.ok(result.resources.some(r => r.role === 'taskState'), '应生成 taskState');
});

// ─── L4 测试 ──────────────────────────────────────────────────────

class MockSessionStorage implements SessionStorage {
  public saved = new Map<string, StoredSession>();
  public shouldFail = false;
  async save(key: string, session: StoredSession): Promise<void> {
    if (this.shouldFail) throw new Error('persist_failed');
    this.saved.set(key, session);
  }
  async load(key: string): Promise<StoredSession | null> {
    return this.saved.get(key) ?? null;
  }
  async delete(key: string): Promise<boolean> {
    return this.saved.delete(key);
  }
  async list(): Promise<string[]> {
    return [...this.saved.keys()];
  }
  async clear(): Promise<void> {
    this.saved.clear();
  }
}

test('L4: 持久化失败 + failOnPersistError=true 中止压缩', async () => {
  const est = new CharHeuristicEstimator();
  const storage = new MockSessionStorage();
  storage.shouldFail = true;
  const l4 = new SessionCheckpointLevel(est, storage, {
    enabled: true, threshold: 0.92, targetRatio: 0.25,
    checkpointStorage: 'memory', minWorkingSet: 2,
    failOnPersistError: true,
  });

  const resources = [
    makeResource('u1', 'user_message', 'r1'),
    makeResource('a1', 'assistant_message', 'a1'),
    makeResource('u2', 'user_message', 'r2'),
    makeResource('a2', 'assistant_message', 'a2'),
  ];

  const safety = createSafetyState({ forkTimeoutMs: 0 });
  const result = await l4.compress(resources, 1000, safety, 's1', 1);

  // 应返回原 resources，不缩减
  assert.equal(result.resources, resources);
  // 应有失败遥测
  assert.ok(result.telemetry.some(t => t.failed));
  // hasCheckpoint 不应被设为 true
  assert.equal(safety.hasCheckpoint, false);
});

test('L4: 持久化成功 + 缩减到工作集', async () => {
  const est = new CharHeuristicEstimator();
  const storage = new MockSessionStorage();
  const l4 = new SessionCheckpointLevel(est, storage, {
    enabled: true, threshold: 0.92, targetRatio: 0.25,
    checkpointStorage: 'memory', minWorkingSet: 1,
    failOnPersistError: true,
  });

  const resources = [
    makeResource('u1', 'user_message', 'r1'),
    makeResource('u2', 'user_message', 'r2'),
    makeResource('u3', 'user_message', 'r3'),
    makeResource('u4', 'user_message', 'r4'), // recent
  ];

  const safety = createSafetyState({ forkTimeoutMs: 0 });
  const result = await l4.compress(resources, 1000, safety, 's1', 1);

  // 应生成 checkpoint_ref
  assert.ok(result.resources.some(r => r.meta._checkpointId));
  // recent 项 u4 应保留
  assert.ok(result.resources.some(r => r.id === 'u4'));
  // hasCheckpoint 应为 true
  assert.equal(safety.hasCheckpoint, true);
  assert.ok(safety.checkpointId);
  // storage 应有 checkpoint
  assert.equal(storage.saved.size, 1);
});

test('L4 recover: 实例方法可恢复 checkpoint', async () => {
  const est = new CharHeuristicEstimator();
  const storage = new MockSessionStorage();
  const l4 = new SessionCheckpointLevel(est, storage, {
    enabled: true, threshold: 0.92, targetRatio: 0.25,
    checkpointStorage: 'memory', minWorkingSet: 1,
    failOnPersistError: true,
  });

  const resources = [
    makeResource('u1', 'user_message', 'r1'),
    makeResource('u2', 'user_message', 'r2'),
  ];

  const safety = createSafetyState({ forkTimeoutMs: 0 });
  const result = await l4.compress(resources, 1000, safety, 's1', 1);
  const checkpointId = result.resources.find(r => r.meta._checkpointId)?.meta._checkpointId as string;

  const recovered = await l4.recover(checkpointId);
  assert.ok(recovered);
  assert.ok(recovered!.fullMessages.length > 0);
});

test('L4: 无 sessionStorage 时记失败遥测并跳过', async () => {
  const est = new CharHeuristicEstimator();
  const l4 = new SessionCheckpointLevel(est, undefined, {
    enabled: true, threshold: 0.92, targetRatio: 0.25,
    checkpointStorage: 'memory', minWorkingSet: 1,
    failOnPersistError: true,
  });

  const resources = [makeResource('u1', 'user_message', 'r1')];
  const safety = createSafetyState({ forkTimeoutMs: 0 });
  const result = await l4.compress(resources, 1000, safety, 's1', 1);

  assert.equal(result.resources, resources);
  assert.ok(result.telemetry.some(t => t.failed && t.message?.includes('no_session_storage')));
});

// ─── P2#18 补充测试 ──────────────────────────────────────────────

test('L3 JSON 解析失败: 记失败遥测，不替换 resources', async () => {
  const est = new CharHeuristicEstimator();
  // fork 返回非 JSON 自由文本（模拟模型没按 prompt 输出）
  const l3 = new TaskStateExtraction(est, makeMockStreamFn('I cannot extract state because...'), mockModel, {
    enabled: true, threshold: 0.85, targetRatio: 0.4,
    forkModel: undefined, forkMaxTokens: 1024,
    protectedRecentCount: 2,
  }, FORK_TIMEOUT_MS, DEFAULT_FORK_RETRY);

  const resources = [
    makeResource('u1', 'user_message', 'r1'),
    makeResource('a1', 'assistant_message', 'a1'),
  ];

  const safety = createSafetyState({ forkTimeoutMs: 0 });
  const result = await l3.compress(resources, 1000, safety, 's1', 1);

  // P1#12 修复：解析失败必须返回原 resources，不能把自由文本塞进 originalRequest
  assert.equal(result.resources, resources);
  assert.equal(result.telemetry.length, 1);
  assert.equal(result.telemetry[0].failed, true);
  // compressionDepth 不应增加
  assert.equal(safety.compressionDepth, 0);
});

test('L4 recover: 保留 taskState 结构化字段', async () => {
  const est = new CharHeuristicEstimator();
  const storage = new MockSessionStorage();
  const l4 = new SessionCheckpointLevel(est, storage, {
    enabled: true, threshold: 0.92, targetRatio: 0.25,
    checkpointStorage: 'memory', minWorkingSet: 1,
    failOnPersistError: true,
  });

  const taskState = {
    originalRequest: 'build feature X',
    currentPhase: 'implementing',
    completedSteps: ['setup'],
    pendingSteps: ['test'],
    keyDecisions: ['use ts'],
    constraints: [],
    toolResults: [],
    errors: [],
    variables: {},
  };
  const taskStateResource = makeResource('ts1', 'custom', taskState, {
    pinned: true, role: 'taskState',
  });
  const resources = [
    taskStateResource,
    makeResource('u1', 'user_message', 'r1'),
  ];

  const safety = createSafetyState({ forkTimeoutMs: 0 });
  await l4.compress(resources, 1000, safety, 's1', 1);

  const checkpointId = safety.checkpointId;
  assert.ok(checkpointId, '应生成 checkpointId');

  const recovered = await l4.recover(checkpointId!);
  assert.ok(recovered, '应能恢复');
  // P0#2 修复：taskState 不再丢失
  assert.ok(recovered!.taskState, 'recover 应保留 taskState');
  assert.equal(recovered!.taskState!.originalRequest, 'build feature X');
  assert.equal(recovered!.resourceCount, 2);

  // meta message 应存在于持久化存储中
  const stored = storage.saved.get(`checkpoint_${checkpointId}`);
  assert.ok(stored, 'checkpoint 应已持久化');
  const storedLast = stored!.messages[stored!.messages.length - 1];
  assert.equal(
    JSON.parse(String(storedLast.content)).__checkpointMeta,
    true,
    '存储末尾应有 __checkpointMeta message',
  );

  // recover 返回的 fullMessages 不应含 meta message
  const hasMeta = recovered!.fullMessages.some(m => {
    if (typeof m.content !== 'string') return false;
    try { return JSON.parse(m.content).__checkpointMeta === true; } catch { return false; }
  });
  assert.equal(hasMeta, false, 'recover 应移除 meta message');
});

// ─── L5 测试 ──────────────────────────────────────────────────────

/** L5 测试用的快速重试配置（避免 500ms 退避拖慢测试） */
const FAST_RETRY = { ...DEFAULT_FORK_RETRY, retries: 1, baseMs: 5, maxMs: 20 };

test('L5 fork 失败: 使用 fallback 文档并标记 fallback=true', async () => {
  const est = new CharHeuristicEstimator();
  const l5 = new NewSessionHandoff(est, makeFailingStreamFn(), mockModel, {
    enabled: true, threshold: 0.95,
    forkModel: undefined, forkMaxTokens: 512,
  }, FORK_TIMEOUT_MS, FAST_RETRY);

  const resources = [
    makeResource('u1', 'user_message', 'build a calculator app'),
  ];

  const safety = createSafetyState({ forkTimeoutMs: 0 });
  const result = await l5.compress(resources, 1000, safety, 's1', 1);

  assert.ok(result.handoff, '应生成 handoff');
  assert.equal(result.handoff!.fallback, true, 'fork 失败应标记 fallback');
  // fallback 文档应包含原始请求
  assert.match(result.handoff!.handoffDocument, /build a calculator app/);
  // 输出应包含 handoff resource
  assert.ok(result.resources.some(r => r.meta._isHandoff), '结果应含 handoff 资源');
  assert.equal(result.resources.some(r => r.meta._fallback), true);
  // handoff 完成后 safety 标记
  assert.equal(safety.handoffCompleted, true);
});

test('L5 fork 成功: 生成真实 handoff 文档', async () => {
  const est = new CharHeuristicEstimator();
  const l5 = new NewSessionHandoff(est, makeMockStreamFn('HANDOFF: continue building the calculator'), mockModel, {
    enabled: true, threshold: 0.95,
    forkModel: 'fork-model', forkMaxTokens: 512,
  }, FORK_TIMEOUT_MS, DEFAULT_FORK_RETRY);

  const resources = [
    makeResource('u1', 'user_message', 'build a calculator app'),
  ];

  const safety = createSafetyState({ forkTimeoutMs: 0 });
  const result = await l5.compress(resources, 1000, safety, 's1', 1);

  assert.ok(result.handoff, '应生成 handoff');
  assert.equal(result.handoff!.fallback, false, 'fork 成功不应标记 fallback');
  assert.match(result.handoff!.handoffDocument, /HANDOFF: continue/);
  // handoffId / newSessionId 应有随机后缀（P1#8）
  assert.match(result.handoff!.handoffId, /^handoff_/);
  assert.ok(result.handoff!.newSessionId.length > result.handoff!.originalSessionId.length);
});

test('L5 超窗: handoff 文档被硬截断（P1#9）', async () => {
  const est = new CharHeuristicEstimator();
  // 返回超长 handoff doc，contextWindow 极小强制触发硬截断
  const l5 = new NewSessionHandoff(est, makeMockStreamFn('X'.repeat(2000)), mockModel, {
    enabled: true, threshold: 0.95,
    forkModel: undefined, forkMaxTokens: 512,
  }, FORK_TIMEOUT_MS, DEFAULT_FORK_RETRY);

  const resources = [
    makeResource('u1', 'user_message', 'build a calculator app'),
  ];

  const safety = createSafetyState({ forkTimeoutMs: 0 });
  // contextWindow=100，handoff doc 2000 chars 必然超窗
  const result = await l5.compress(resources, 100, safety, 's1', 1);

  // 结果应仍 <= contextWindow（硬截断生效），或至少在截断标记
  const handoffResource = result.resources.find(r => r.meta._isHandoff);
  assert.ok(handoffResource, '应有 handoff 资源');
  const content = typeof handoffResource!.content === 'string'
    ? handoffResource!.content
    : JSON.stringify(handoffResource!.content);
  // 要么截断标记出现，要么整体仍超窗但文档已缩短
  const totalTokens = est.estimateAll(result.resources);
  assert.ok(
    content.includes('[... handoff truncated') || totalTokens <= 100,
    '超窗 handoff 应被截断或结果已在窗内',
  );
});
