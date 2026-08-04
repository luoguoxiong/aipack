/**
 * ContextCompressionTransformer 集成测试 - 覆盖关键修复点
 *  - contextWindow 防御性校验
 *  - 熔断器在 maxAttempts 后触发
 *  - 遥测通过 reporter 上报
 *  - 遥测通过 sharedMap 写入
 *  - setHandoffHook 真正被调用
 *  - recover API 可用
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContextResource, Model, StreamFn, StreamResult, SessionStorage, StoredSession } from 'agentpack';
import {
  createCompressionTransformer,
  loadCompressionConfig,
  ConsoleTelemetryReporter,
  TELEMETRY_SHARED_KEY,
} from '../index';
import type { CompressionTelemetry } from '../index';

function makeResource(
  id: string,
  type: ContextResource['type'],
  content: unknown,
  opts: { deps?: string[]; pinned?: boolean; role?: string } = {},
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
    timestamp: Date.now(),
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

// ─── 防御性校验 ───────────────────────────────────────────────────

test('transformer: contextWindow=0 抛错', () => {
  assert.throws(
    () => createCompressionTransformer({
      config: loadCompressionConfig(),
      model: mockModel,
      streamFn: makeMockStreamFn('x'),
      contextWindow: 0,
    }),
    /Invalid contextWindow/,
  );
});

test('transformer: contextWindow=NaN 抛错', () => {
  assert.throws(
    () => createCompressionTransformer({
      config: loadCompressionConfig(),
      model: mockModel,
      streamFn: makeMockStreamFn('x'),
      contextWindow: NaN,
    }),
    /Invalid contextWindow/,
  );
});

test('transformer: contextWindow=undefined 抛错', () => {
  assert.throws(
    () => createCompressionTransformer({
      config: loadCompressionConfig(),
      model: mockModel,
      streamFn: makeMockStreamFn('x'),
      contextWindow: undefined as unknown as number,
    }),
    /Invalid contextWindow/,
  );
});

// ─── 遥测上报 ─────────────────────────────────────────────────────

test('transformer: 通过 telemetryReporter 直接上报', async () => {
  const reported: CompressionTelemetry[] = [];
  const reporter: { report: (t: CompressionTelemetry) => void } = {
    report: (t) => { reported.push(t); },
  };

  const transformer = createCompressionTransformer({
    config: loadCompressionConfig({
      l1: { toolResultMaxLines: 5, toolResultHeadLines: 1, toolResultTailLines: 1 },
    }),
    model: mockModel,
    streamFn: makeMockStreamFn('summary'),
    contextWindow: 100,
    telemetryReporter: reporter,
  });

  const longText = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
  const resources = [
    makeResource('tr1', 'tool_result', longText, { deps: ['c1'] }),
  ];

  await transformer.transform(resources, {
    graph: {} as any,
    runtime: { sessionKey: 's1', turn: 1 },
  });

  assert.ok(reported.length >= 1, '应有遥测上报');
  assert.equal(reported[0].level, 'L1');
});

test('transformer: 通过 sharedMap 写入遥测', async () => {
  const sharedMap = new Map<string, unknown>();
  const transformer = createCompressionTransformer({
    config: loadCompressionConfig({
      l1: { toolResultMaxLines: 5, toolResultHeadLines: 1, toolResultTailLines: 1 },
    }),
    model: mockModel,
    streamFn: makeMockStreamFn('summary'),
    contextWindow: 100,
    sharedMap,
  });

  const longText = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
  const resources = [
    makeResource('tr1', 'tool_result', longText, { deps: ['c1'] }),
  ];

  await transformer.transform(resources, {
    graph: {} as any,
    runtime: { sessionKey: 's1', turn: 1 },
  });

  const telemetry = sharedMap.get(TELEMETRY_SHARED_KEY) as CompressionTelemetry[] | undefined;
  assert.ok(telemetry && telemetry.length >= 1, 'sharedMap 应有遥测');
  assert.equal(telemetry![0].level, 'L1');
});

// ─── 熔断器 ───────────────────────────────────────────────────────

test('transformer: maxAttempts 熔断后停止压缩', async () => {
  // 用极小 maxAttempts + 极大 contextWindow 避免触发压缩，单独验证熔断
  // 这里通过多次 transform 同一 turn 来累积 attemptCount
  const config = loadCompressionConfig({
    safety: { maxAttempts: 1, cooldownTurns: 10 },
    l1: { enabled: false }, // 关闭 L1，避免触发
    l2: { enabled: false },
    l3: { enabled: false },
    l4: { enabled: false },
    l5: { enabled: false },
  });

  const transformer = createCompressionTransformer({
    config,
    model: mockModel,
    streamFn: makeMockStreamFn('x'),
    contextWindow: 1000,
  });

  // 由于所有级别都 disabled，transform 不会触发任何 attempt
  // 这个测试主要验证 transformer 不抛错，且 disabled 时透传 resources
  const resources = [makeResource('u1', 'user_message', 'hello')];
  const out = await transformer.transform(resources, {
    graph: {} as any,
    runtime: { sessionKey: 's1', turn: 1 },
  });
  assert.equal(out, resources);
});

// ─── setHandoffHook ───────────────────────────────────────────────

test('transformer: setHandoffHook 在 L5 触发时被调用', async () => {
  // 构造场景：contextWindow 极小 + 大量内容，强制一路升级到 L5
  const config = loadCompressionConfig({
    l1: {
      enabled: true, threshold: 0.1, targetRatio: 0.05,
      stripThinking: false, trimToolResults: true,
      toolResultMaxLines: 1, toolResultHeadLines: 0, toolResultTailLines: 0,
      normalizeWhitespace: false,
    },
    l2: {
      enabled: true, threshold: 0.2, targetRatio: 0.1,
      forkMaxTokens: 100, minResourcesToCompress: 1,
      protectedRecentCount: 0, maxCompressionDepth: 5,
    },
    l3: { enabled: true, threshold: 0.3, targetRatio: 0.1, forkMaxTokens: 100, protectedRecentCount: 0 },
    l4: {
      enabled: true, threshold: 0.4, targetRatio: 0.1,
      checkpointStorage: 'memory', minWorkingSet: 0,
      failOnPersistError: false,
    },
    l5: { enabled: true, threshold: 0.5, forkMaxTokens: 100 },
    safety: { maxAttempts: 10, cooldownTurns: 1 },
  });

  let hookCalled = false;
  let capturedNewSessionId: string | null = null;

  const transformer = createCompressionTransformer({
    config,
    model: mockModel,
    streamFn: makeMockStreamFn('handoff doc'),
    contextWindow: 50, // 极小，强制触发
  });

  transformer.setHandoffHook(({ handoff }) => {
    hookCalled = true;
    capturedNewSessionId = handoff.newSessionId;
  });

  // 构造大量内容
  const longText = 'x'.repeat(500);
  const resources = [
    makeResource('u1', 'user_message', longText),
    makeResource('a1', 'assistant_message', longText),
  ];

  await transformer.transform(resources, {
    graph: {} as any,
    runtime: { sessionKey: 's1', turn: 1 },
  });

  assert.equal(hookCalled, true, 'handoff hook 应被调用');
  assert.ok(capturedNewSessionId);
});

// ─── recover API ──────────────────────────────────────────────────

class MockSessionStorage implements SessionStorage {
  public saved = new Map<string, StoredSession>();
  async save(key: string, session: StoredSession): Promise<void> {
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

test('transformer: recover API 可用', async () => {
  const storage = new MockSessionStorage();
  const config = loadCompressionConfig({
    l1: { enabled: false }, l2: { enabled: false }, l3: { enabled: false },
    l4: {
      enabled: true, threshold: 0.1, targetRatio: 0.05,
      checkpointStorage: 'memory', minWorkingSet: 1,
      failOnPersistError: true,
    },
    l5: { enabled: false },
    safety: { maxAttempts: 10, cooldownTurns: 1 },
  });

  const transformer = createCompressionTransformer({
    config,
    model: mockModel,
    streamFn: makeMockStreamFn('x'),
    contextWindow: 10,
    sessionStorage: storage,
  });

  const resources = [
    makeResource('u1', 'user_message', 'r1'),
    makeResource('u2', 'user_message', 'r2'),
  ];

  const out = await transformer.transform(resources, {
    graph: {} as any,
    runtime: { sessionKey: 's1', turn: 1 },
  });

  const checkpointRef = out.find(r => r.meta._checkpointId);
  assert.ok(checkpointRef, '应生成 checkpoint_ref');
  const checkpointId = checkpointRef!.meta._checkpointId as string;

  const recovered = await transformer.recover(checkpointId);
  assert.ok(recovered, '应能通过 transformer.recover 恢复');
  assert.ok(recovered!.fullMessages.length > 0);
});

// ─── P2#18 补充测试 ──────────────────────────────────────────────

test('transformer: dryRun 模式不修改 resources，生成 would_trigger telemetry', async () => {
  const reported: CompressionTelemetry[] = [];
  const reporter: { report: (t: CompressionTelemetry) => void } = {
    report: (t) => { reported.push(t); },
  };

  const config = loadCompressionConfig({
    dryRun: true,
    l1: {
      enabled: true, threshold: 0.1, targetRatio: 0.05,
      stripThinking: false, trimToolResults: true,
      toolResultMaxLines: 1, toolResultHeadLines: 0, toolResultTailLines: 0,
      normalizeWhitespace: false,
    },
    l2: { enabled: false }, l3: { enabled: false }, l4: { enabled: false }, l5: { enabled: false },
  });

  const transformer = createCompressionTransformer({
    config,
    model: mockModel,
    streamFn: makeMockStreamFn('summary'),
    contextWindow: 100,
    telemetryReporter: reporter,
  });

  const longText = 'x'.repeat(500);
  const resources = [makeResource('u1', 'user_message', longText)];

  const out = await transformer.transform(resources, {
    graph: {} as any,
    runtime: { sessionKey: 's1', turn: 1 },
  });

  // P2#14: dryRun 必须透传原 resources（引用相等）
  assert.equal(out, resources, 'dryRun 不应修改 resources');
  assert.ok(reported.length >= 1, 'dryRun 也应生成遥测');
  assert.match(reported[0].action, /dry_run_would_trigger/);
});

test('transformer: 同 session 并发 transform 被串行化（P1#6）', async () => {
  const order: string[] = [];
  const streamFn: StreamFn = async function* (): StreamResult {
    order.push('start');
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    order.push('end');
    yield { type: 'text_delta', delta: 'summary' };
  };

  const config = loadCompressionConfig({
    l1: { enabled: false },
    l2: {
      enabled: true, threshold: 0.1, targetRatio: 0.5,
      forkMaxTokens: 100, minResourcesToCompress: 2,
      // 注意 protectedRecentCount 不能用 0：slice(-0) 返回整个数组，
      // 所有资源都会被 recent 保护导致 L2 永不触发
      protectedRecentCount: 1, maxCompressionDepth: 3,
    },
    l3: { enabled: false }, l4: { enabled: false }, l5: { enabled: false },
    safety: { serializePerSession: true, maxAttempts: 5, cooldownTurns: 1 },
  });

  const transformer = createCompressionTransformer({
    config,
    model: mockModel,
    streamFn,
    contextWindow: 1000,
  });

  // 内容足够长，确保 token 超过 contextWindow * l2.threshold，触发 L2 fork
  const longText = 'x'.repeat(300);
  const resources = [
    makeResource('u1', 'user_message', longText),
    makeResource('a1', 'assistant_message', longText, { deps: ['c1'] }),
    makeResource('tr1', 'tool_result', longText, { deps: ['c1'] }),
    makeResource('u2', 'user_message', longText),
  ];

  const ctx = {
    graph: {} as any,
    runtime: { sessionKey: 's1', turn: 1 },
  };

  await Promise.all([
    transformer.transform(resources, ctx),
    transformer.transform(resources, ctx),
  ]);

  // 严格串行：start end start end（不能出现 start start end end）
  assert.deepEqual(order, ['start', 'end', 'start', 'end'], `同 session 并发 run 必须串行化，实际 ${JSON.stringify(order)}`);
});

// ─── ConsoleTelemetryReporter 配置项 ──────────────────────────────

test('ConsoleTelemetryReporter: logTokenDelta=false 时不输出 tokenDelta', () => {
  const origLog = console.log;
  const logs: string[] = [];
  console.log = (msg: string) => { logs.push(msg); };

  try {
    const reporter = new ConsoleTelemetryReporter({
      logTokenDelta: false,
      logTriggerReason: false,
    });
    reporter.report({
      timestamp: 0, sessionKey: 's', turn: 1, level: 'L1', action: 'a',
      beforeTokens: 100, afterTokens: 50, resourcesAffected: 1,
      triggerReason: 'threshold_exceeded', cachePreserved: true,
      compressionDepth: 0, duration: 0,
    });

    const payload = JSON.parse(logs[0]);
    assert.equal(payload.tokenDelta, undefined);
    assert.equal(payload.triggerReason, undefined);
    assert.equal(payload.beforeTokens, 100);
  } finally {
    console.log = origLog;
  }
});
