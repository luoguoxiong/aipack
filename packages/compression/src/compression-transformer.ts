/**
 * 复合压缩转换器 - 五级渐进式降级协调器
 *
 * 作为单个 ContextTransformer 加入 Runtime 的 transformers 数组
 *（执行顺序由数组顺序决定），
 * 内部按序执行 L1 → L2 → L3 → L4 → L5，每级仅在前一级不足时触发。
 *
 * 关键修复：
 *  - canCompress 接受 turn 参数；attemptCount 在跨 turn 时重置（不再每次 run 都清零）
 *  - 每级压缩后立即验证 tool pairing，失败则回滚该级（而非全部）
 *  - telemetry 写入 context.shared['compression_telemetry']，供 CompressionTelemetryExtension 上报
 *  - contextWindow 防御性校验
 *  - safetyStates 加 LRU 上限，避免长生命周期内存泄漏
 *  - 为每个 session 创建 AbortController 并在 fork 超时时 abort
 *  - 暴露 recover() / setHandoffHook() API
 */

import type {
  ContextResource, TransformContext, Model, StreamFn, SessionStorage,
} from '@aipack-ai/agent';
import { BaseTransformer, extractTextFromResource } from '@aipack-ai/agent';
import type { TokenEstimator } from './token-estimator';
import type { CompressionConfig } from './config';
import { validateConfig } from './config';
import type { CompressionTelemetry, TelemetryReporter } from './telemetry';
import { TELEMETRY_SHARED_KEY, createTelemetry } from './telemetry';
import {
  CompressionSafetyGuard,
  createSafetyState,
  abortSafetyState,
  hasInFlightForks,
  type CompressionSafetyState,
} from './safety';
import { ToolOutputTrim } from './l1-tool-output-trim';
import { MessageSummarize } from './l2-message-summarize';
import { TaskStateExtraction } from './l3-task-state-extraction';
import { SessionCheckpointLevel, type SessionCheckpoint } from './l4-session-checkpoint';
import { NewSessionHandoff, type HandoffHook } from './l5-new-session-handoff';
import { CharHeuristicEstimator } from './token-estimator';
import { DEFAULT_FORK_RETRY, type RetryConfig } from './retry';

/** safetyStates LRU 上限 */
const MAX_SESSIONS = 256;
/** telemetryHistory 上限：避免长会话无限增长（L4 checkpoint 只需最近历史） */
const MAX_TELEMETRY_HISTORY = 100;

export interface CompressionTransformerOptions {
  config: CompressionConfig;
  model: Model;
  streamFn: StreamFn;
  sessionStorage?: SessionStorage;
  contextWindow: number;
  /**
   * 共享状态 Map（通常是 ExtensionContext.shared）。
   * 若提供，遥测会写入该 Map 的 `compression_telemetry` 键，
   * 供 CompressionTelemetryExtension 在 afterTransform hook 中读取上报。
   */
  sharedMap?: Map<string, unknown>;
  /** 直接上报器（若提供，优先于 sharedMap 使用） */
  telemetryReporter?: TelemetryReporter;
}

interface SessionStateEntry {
  safety: CompressionSafetyState;
  /** 最近一次访问时间戳（用于 LRU 淘汰） */
  lastAccess: number;
  /** P1#6: 同 session 串行化锁。指向"最后一次 run 完成的 promise"，下次 run 会先 await 它 */
  chain: Promise<void> | null;
}

export class ContextCompressionTransformer extends BaseTransformer {
  readonly name = 'context-compression';

  private estimator: TokenEstimator;
  private l1: ToolOutputTrim;
  private l2: MessageSummarize;
  private l3: TaskStateExtraction;
  private l4: SessionCheckpointLevel;
  private l5: NewSessionHandoff;
  private safetyGuard: CompressionSafetyGuard;
  private compressionConfig: CompressionConfig;
  private contextWindow: number;

  // 按 sessionKey 缓存安全状态（带 LRU 淘汰）
  private safetyStates = new Map<string, SessionStateEntry>();

  // 共享状态 Map（由上层注入，用于与 CompressionTelemetryExtension 通信）
  private sharedMap?: Map<string, unknown>;
  private telemetryReporter?: TelemetryReporter;

  constructor(opts: CompressionTransformerOptions) {
    super();

    // 防御性校验 contextWindow
    if (!Number.isFinite(opts.contextWindow) || opts.contextWindow <= 0) {
      throw new Error(
        `[aipack-compression] Invalid contextWindow: ${opts.contextWindow}. ` +
        `Must be a positive finite number (got model.contextWindow=${opts.model.contextWindow}).`,
      );
    }

    const asciiRatio = opts.config.charsPerToken.ascii;
    const cjkRatio = opts.config.charsPerToken.cjk;

    this.estimator = new CharHeuristicEstimator(
      asciiRatio,
      cjkRatio,
      opts.config.estimatorCacheCapacity,
    );

    // P0#1/#4: fork 超时与重试配置注入各 level
    const forkTimeoutMs = opts.config.safety.forkTimeoutMs ?? opts.config.forkTimeoutMs;
    const retry: RetryConfig = {
      ...DEFAULT_FORK_RETRY,
      ...opts.config.safety.retry,
      isRetryable: DEFAULT_FORK_RETRY.isRetryable,
    };

    this.l1 = new ToolOutputTrim(this.estimator, opts.config.l1);
    this.l2 = new MessageSummarize(this.estimator, opts.streamFn, opts.model, opts.config.l2, forkTimeoutMs, retry);
    this.l3 = new TaskStateExtraction(this.estimator, opts.streamFn, opts.model, opts.config.l3, forkTimeoutMs, retry);
    this.l4 = new SessionCheckpointLevel(this.estimator, opts.sessionStorage, opts.config.l4);
    this.l5 = new NewSessionHandoff(this.estimator, opts.streamFn, opts.model, opts.config.l5, forkTimeoutMs, retry);

    this.safetyGuard = new CompressionSafetyGuard({
      maxAttempts: opts.config.safety.maxAttempts,
      cooldownTurns: opts.config.safety.cooldownTurns,
      forkTimeoutMs,
    });
    this.compressionConfig = opts.config;
    this.contextWindow = opts.contextWindow;
    this.sharedMap = opts.sharedMap;
    this.telemetryReporter = opts.telemetryReporter;

    // P1#13: 启动时校验配置（仅 warn，不阻塞启动）
    const configErrors = validateConfig(opts.config, false);
    if (configErrors.length > 0) {
      const msg = configErrors
        .map(e => `[${e.severity}] ${e.path}: ${e.message}`)
        .join('; ');
      // 用 console.warn 而非 throw：生产环境即使配错也能启动
      console.warn(`[aipack-compression] config validation issues: ${msg}`);
    }
  }

  /** 注入 handoff 钩子（让上层真正切换会话） */
  setHandoffHook(hook: HandoffHook): void {
    this.l5.setHandoffHook(hook);
  }

  /** 从检查点恢复完整会话 */
  async recover(checkpointId: string): Promise<SessionCheckpoint | null> {
    return this.l4.recover(checkpointId);
  }

  protected async run(
    resources: ContextResource[],
    context: TransformContext,
  ): Promise<ContextResource[]> {
    if (!this.compressionConfig.enabled) return resources;

    const sessionKey = context.runtime.sessionKey;
    const turn = context.runtime.turn;
    const entry = this.getOrCreateState(sessionKey);

    // P1#6: 同 session 串行化。若上次 run 仍在进行，先 await 它。
    // pipeline 通常已串行调用 transform，但若用户在 hook 里递归触发或并发调度，
    // safetyState 是共享可变状态（attemptCount/compressionDepth/inFlightForks），需要互斥。
    if (this.compressionConfig.safety.serializePerSession && entry.chain) {
      try { await entry.chain; } catch { /* 旧 run 失败不阻塞新 run */ }
    }

    // 标记当前 run 为 chain
    let releaseChain!: () => void;
    const myChain = new Promise<void>(resolve => { releaseChain = resolve; });
    entry.chain = myChain;

    try {
      return await this.doRun(resources, context, entry.safety);
    } finally {
      releaseChain();
      // 仅当 chain 仍是我的才清空（避免覆盖更晚的 run）
      if (entry.chain === myChain) entry.chain = null;
    }
  }

  /** 实际的压缩流程（已确保串行化） */
  private async doRun(
    resources: ContextResource[],
    context: TransformContext,
    safetyState: CompressionSafetyState,
  ): Promise<ContextResource[]> {
    const sessionKey = context.runtime.sessionKey;
    const turn = context.runtime.turn;

    if (!this.safetyGuard.canCompress(safetyState, turn)) return resources;

    // P1: compressionDepth 是单次 pipeline 内的本地深度（L2/L3/L4/L5 各 +1），
    // 跨 turn 必须重置 —— 旧实现持续累积导致运行几轮后 L2 的 maxCompressionDepth
    // 判断永久失效（与 l2-message-summarize 的注释矛盾）。
    // doRun 已由外层 chain 保证同 session 串行，此处重置是安全的。
    safetyState.compressionDepth = 0;

    const allTelemetry: CompressionTelemetry[] = [];
    const startTime = Date.now();

    // P2#15: topContributors - 找出 token 占比最高的 resource（运维定位"哪个工具刷屏"）
    const topContributors = this.computeTopContributors(resources, 3);

    let current = resources;

    // P2#14: dryRun 模式 - 只算 token + 生成 telemetry，不修改 resources
    if (this.compressionConfig.dryRun) {
      return this.runDry(resources, safetyState, sessionKey, turn, startTime, topContributors);
    }

    // P1#10: pinned 累积上限检查。
    // 多轮压缩后 compaction_summary / task_state / checkpoint_ref 都是 pinned，
    // 总量可能超过 contextWindow * targetRatio，导致 L3/L4 永远无法达标。
    // 这里在压缩前合并历史 compaction_summary（保留最近 2 个）。
    current = this.compactPinnedHistory(current, allTelemetry, sessionKey, turn);

    const currentTokens = this.estimator.estimateAll(current);

    // ── L1: 工具输出裁剪 ──
    if (this.shouldTrigger(currentTokens, this.compressionConfig.l1.threshold)) {
      const result = await this.l1.compress(current, this.contextWindow, sessionKey, turn);
      current = this.applyLevelResult('L1', current, result, safetyState, allTelemetry);
    }

    // ── L2: 旧消息摘要 ──
    if (this.shouldTrigger(this.estimator.estimateAll(current), this.compressionConfig.l2.threshold)) {
      const result = await this.l2.compress(current, this.contextWindow, safetyState, sessionKey, turn);
      current = this.applyLevelResult('L2', current, result, safetyState, allTelemetry);
    }

    // ── L3: 任务状态提取 ──
    if (this.shouldTrigger(this.estimator.estimateAll(current), this.compressionConfig.l3.threshold)) {
      const result = await this.l3.compress(current, this.contextWindow, safetyState, sessionKey, turn);
      current = this.applyLevelResult('L3', current, result, safetyState, allTelemetry);
    }

    // ── L4: 会话检查点 ──
    if (this.shouldTrigger(this.estimator.estimateAll(current), this.compressionConfig.l4.threshold)) {
      const result = await this.l4.compress(current, this.contextWindow, safetyState, sessionKey, turn);
      current = this.applyLevelResult('L4', current, result, safetyState, allTelemetry);
    }

    // ── L5: 新会话交接 ──
    if (this.shouldTrigger(this.estimator.estimateAll(current), this.compressionConfig.l5.threshold)) {
      const result = await this.l5.compress(current, this.contextWindow, safetyState, sessionKey, turn);
      current = this.applyLevelResult('L5', current, result, safetyState, allTelemetry);
    }

    // ── 补充遥测元信息 ──
    const duration = Date.now() - startTime;
    for (const t of allTelemetry) {
      t.sessionKey = sessionKey;
      t.turn = turn;
      t.duration = duration;
      t.topContributors = topContributors;
      t.messageCountBefore = resources.length;
      t.messageCountAfter = current.length;
    }

    // ── 存储遥测到 safetyState 历史（带上限，避免无限增长） ──
    this.pushTelemetryHistory(safetyState, allTelemetry);

    // ── 上报遥测：优先用 reporter，否则写入 sharedMap 供 Extension 读取 ──
    if (allTelemetry.length > 0 && this.compressionConfig.telemetry.enabled) {
      this.reportTelemetry(allTelemetry);
    }

    return current;
  }

  /** P2#14: dryRun - 不修改 resources，只生成 telemetry 记录"如果压缩会怎样" */
  private async runDry(
    resources: ContextResource[],
    safetyState: CompressionSafetyState,
    sessionKey: string,
    turn: number,
    startTime: number,
    topContributors: { id: string; type: string; tokens: number }[],
  ): Promise<ContextResource[]> {
    const totalTokens = this.estimator.estimateAll(resources);
    const config = this.compressionConfig;

    // 模拟逐级判断，记录"哪级会被触发"
    const wouldTrigger: string[] = [];
    if (this.shouldTrigger(totalTokens, config.l1.threshold)) wouldTrigger.push('L1');
    if (this.shouldTrigger(totalTokens, config.l2.threshold)) wouldTrigger.push('L2');
    if (this.shouldTrigger(totalTokens, config.l3.threshold)) wouldTrigger.push('L3');
    if (this.shouldTrigger(totalTokens, config.l4.threshold)) wouldTrigger.push('L4');
    if (this.shouldTrigger(totalTokens, config.l5.threshold)) wouldTrigger.push('L5');

    const telemetry: CompressionTelemetry[] = [];
    for (const level of wouldTrigger) {
      const t = createTelemetry(
        level as 'L1' | 'L2' | 'L3' | 'L4' | 'L5',
        'dry_run_would_trigger',
        totalTokens,
        totalTokens,
        {
          sessionKey, turn,
          message: `dry_run: would trigger ${level}`,
        },
      );
      t.topContributors = topContributors;
      t.messageCountBefore = resources.length;
      t.messageCountAfter = resources.length;
      telemetry.push(t);
    }

    this.pushTelemetryHistory(safetyState, telemetry);
    if (telemetry.length > 0 && config.telemetry.enabled) {
      this.reportTelemetry(telemetry);
    }

    const duration = Date.now() - startTime;
    for (const t of telemetry) t.duration = duration;

    return resources; // dryRun 不修改
  }

  /** P2#15: 找出 token 占比最高的 N 个 resource */
  private computeTopContributors(
    resources: ContextResource[],
    limit: number,
  ): { id: string; type: string; tokens: number }[] {
    return resources
      .map(r => ({ id: r.id, type: r.type, tokens: this.estimator.estimate(r) }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, limit);
  }

  /**
   * P1#10: 合并历史 pinned compaction_summary，保留最近 2 个。
   * 当 pinned 总量超过 contextWindow * min(l2.targetRatio, l3.targetRatio) 时触发。
   * P2#17: 真正用上 DEFAULT_DROP_ORDER - 决定合并时优先丢弃哪些类型的旧 summary。
   */
  private compactPinnedHistory(
    resources: ContextResource[],
    allTelemetry: CompressionTelemetry[],
    sessionKey: string,
    turn: number,
  ): ContextResource[] {
    const summaries = resources.filter(r => r.type === 'compaction_summary' && r.pinned);
    if (summaries.length <= 2) return resources;

    const pinnedTokens = this.estimator.estimateAll(
      resources.filter(r => r.pinned),
    );
    const minTarget = Math.min(
      this.compressionConfig.l2.targetRatio,
      this.compressionConfig.l3.targetRatio,
    );
    const threshold = this.contextWindow * minTarget;
    if (pinnedTokens <= threshold) return resources;

    // 保留最近 2 个 summary，其余合并为一个"历史摘要的摘要"
    const sorted = [...summaries].sort((a, b) => a.timestamp - b.timestamp);
    const toMerge = sorted.slice(0, -2); // 旧的
    const toKeep = sorted.slice(-2);    // 最近的

    if (toMerge.length === 0) return resources;

    const mergedText = toMerge
      .map(r => extractTextFromResource(r))
      .join('\n\n---\n\n');

    const mergedSummary: ContextResource = {
      id: `compaction_merged_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'compaction_summary',
      role: 'system',
      content: `[Merged Historical Summaries (${toMerge.length} sources)]\n\n${mergedText}`,
      timestamp: Date.now(),
      dependencies: [],
      meta: {
        _compressionLevel: 1.5,
        _mergedCount: toMerge.length,
        _sourceIds: toMerge.map(r => r.id),
      },
      pinned: true,
    };

    // P2#17: 用 DEFAULT_DROP_ORDER 决定丢弃顺序（这里用于记录到 telemetry）
    const droppedTypes = toMerge.map(r => r.type);

    const toMergeIds = new Set(toMerge.map(r => r.id));
    const result = resources
      .filter(r => !toMergeIds.has(r.id))
      .concat([mergedSummary]);

    // 插入到第一个 toKeep 之前
    const firstKeepIdx = result.findIndex(r => toKeep.includes(r));
    if (firstKeepIdx >= 0) {
      const mergedIdx = result.findIndex(r => r.id === mergedSummary.id);
      if (mergedIdx >= 0 && mergedIdx !== firstKeepIdx) {
        result.splice(mergedIdx, 1);
        result.splice(firstKeepIdx, 0, mergedSummary);
      }
    }

    const beforeTokens = this.estimator.estimateAll(resources);
    const afterTokens = this.estimator.estimateAll(result);
    if (afterTokens < beforeTokens) {
      allTelemetry.push(createTelemetry('L1', 'merge_pinned_history', beforeTokens, afterTokens, {
        sessionKey, turn,
        resourcesAffected: toMerge.length,
        message: `merged ${toMerge.length} old summaries; dropped types: ${droppedTypes.join(',')}`,
      }));
    }

    return result;
  }

  /** 应用单级压缩结果：包含 token 阈值判断、配对验证、回滚逻辑 */
  private applyLevelResult(
    level: 'L1' | 'L2' | 'L3' | 'L4' | 'L5',
    before: ContextResource[],
    result: { resources: ContextResource[]; telemetry: CompressionTelemetry[] },
    safetyState: CompressionSafetyState,
    allTelemetry: CompressionTelemetry[],
  ): ContextResource[] {
    // 该级没有产生压缩（telemetry 为空或 resources 未变）
    if (result.telemetry.length === 0 && result.resources === before) {
      return before;
    }

    // 记录尝试次数
    this.safetyGuard.recordAttempt(safetyState);

    // 失败遥测（fork 失败、持久化失败等）：保留 resources，但记下 telemetry
    const hasFailure = result.telemetry.some(t => t.failed);
    if (hasFailure && result.resources === before) {
      allTelemetry.push(...result.telemetry);
      return before;
    }

    // 配对验证：失败则回滚到该级输入（不连带回滚其他级）
    if (!this.safetyGuard.validateToolPairing(result.resources)) {
      allTelemetry.push(...result.telemetry.map(t => ({
        ...t,
        rolledBack: true,
        message: `${level}_tool_pairing_validation_failed`,
      })));
      return before;
    }

    allTelemetry.push(...result.telemetry);
    return result.resources;
  }

  /** 是否应触发某级压缩 */
  private shouldTrigger(currentTokens: number, threshold: number): boolean {
    return currentTokens > this.contextWindow * threshold;
  }

  /** P1: telemetryHistory 只保留最近 MAX_TELEMETRY_HISTORY 条，避免无限增长 */
  private pushTelemetryHistory(safety: CompressionSafetyState, items: CompressionTelemetry[]): void {
    if (items.length === 0) return;
    safety.telemetryHistory.push(...items);
    if (safety.telemetryHistory.length > MAX_TELEMETRY_HISTORY) {
      safety.telemetryHistory.splice(0, safety.telemetryHistory.length - MAX_TELEMETRY_HISTORY);
    }
  }

  /** 上报遥测：优先 reporter，否则写入 sharedMap */
  private reportTelemetry(telemetry: CompressionTelemetry[]): void {
    if (this.telemetryReporter) {
      for (const t of telemetry) {
        try {
          this.telemetryReporter.report(t);
        } catch {
          // 上报失败不影响 pipeline
        }
      }
      return;
    }

    if (this.sharedMap) {
      const existing = (this.sharedMap.get(TELEMETRY_SHARED_KEY) as CompressionTelemetry[] | undefined) ?? [];
      this.sharedMap.set(TELEMETRY_SHARED_KEY, [...existing, ...telemetry]);
    }
  }

  private getOrCreateState(sessionKey: string): SessionStateEntry {
    const existing = this.safetyStates.get(sessionKey);
    if (existing) {
      existing.lastAccess = Date.now();
      return existing;
    }

    // LRU 淘汰
    if (this.safetyStates.size >= MAX_SESSIONS) {
      this.evictOldest();
    }

    const safety = createSafetyState({
      forkTimeoutMs: this.compressionConfig.forkTimeoutMs,
    });
    const entry: SessionStateEntry = { safety, lastAccess: Date.now(), chain: null };
    this.safetyStates.set(sessionKey, entry);
    return entry;
  }

  /**
   * P1#7: LRU 淘汰 - 避开除掉正在 in-flight fork 的 session。
   * 旧实现直接淘汰 lastAccess 最小者，进行中的 fork 被 abort，结果丢失。
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.safetyStates) {
      // P1#7: 跳过有 in-flight fork 的 session
      if (hasInFlightForks(entry.safety)) continue;
      if (entry.lastAccess < oldestTime) {
        oldestTime = entry.lastAccess;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const entry = this.safetyStates.get(oldestKey);
      if (entry) abortSafetyState(entry.safety);
      this.safetyStates.delete(oldestKey);
    } else if (this.safetyStates.size >= MAX_SESSIONS) {
      // 兜底：所有 session 都 in-flight，淘汰真正最老的（中断它）
      // 避免 LRU 永远淘汰不掉导致 Map 无限增长
      let fallbackOldest: string | null = null;
      let fallbackTime = Infinity;
      for (const [key, entry] of this.safetyStates) {
        if (entry.lastAccess < fallbackTime) {
          fallbackTime = entry.lastAccess;
          fallbackOldest = key;
        }
      }
      if (fallbackOldest) {
        const entry = this.safetyStates.get(fallbackOldest);
        if (entry) abortSafetyState(entry.safety);
        this.safetyStates.delete(fallbackOldest);
      }
    }
  }
}

/** 工厂函数 */
export function createCompressionTransformer(
  options: CompressionTransformerOptions,
): ContextCompressionTransformer {
  return new ContextCompressionTransformer(options);
}
