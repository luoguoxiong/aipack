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
import type { ContextResource, Model, StreamFn, StreamResult, SessionStorage, StoredSession } from 'agentpack';
import { ToolOutputTrim } from '../src/l1-tool-output-trim';
import { MessageSummarize } from '../src/l2-message-summarize';
import { TaskStateExtraction } from '../src/l3-task-state-extraction';
import { SessionCheckpointLevel } from '../src/l4-session-checkpoint';
import { CharHeuristicEstimator } from '../src/token-estimator';
import { createSafetyState } from '../src/safety';

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
  });

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
  });

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
  });

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
  });

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
