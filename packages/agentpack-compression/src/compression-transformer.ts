/**
 * 复合压缩转换器 - 五级渐进式降级协调器
 *
 * 作为单个 ContextTransformer (priority=40) 插入 Pipeline，
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
} from 'agentpack';
import { BaseTransformer } from 'agentpack';
import type { TokenEstimator } from './token-estimator';
import type { CompressionConfig } from './config';
import type { CompressionTelemetry, TelemetryReporter } from './telemetry';
import { TELEMETRY_SHARED_KEY } from './telemetry';
import {
  CompressionSafetyGuard,
  createSafetyState,
  abortSafetyState,
  type CompressionSafetyState,
} from './safety';
import { ToolOutputTrim } from './l1-tool-output-trim';
import { MessageSummarize } from './l2-message-summarize';
import { TaskStateExtraction } from './l3-task-state-extraction';
import { SessionCheckpointLevel, type SessionCheckpoint } from './l4-session-checkpoint';
import { NewSessionHandoff, type HandoffHook } from './l5-new-session-handoff';
import { CharHeuristicEstimator } from './token-estimator';

/** safetyStates LRU 上限 */
const MAX_SESSIONS = 256;

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
    super({ priority: 40 });

    // 防御性校验 contextWindow
    if (!Number.isFinite(opts.contextWindow) || opts.contextWindow <= 0) {
      throw new Error(
        `[agentpack-compression] Invalid contextWindow: ${opts.contextWindow}. ` +
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

    this.l1 = new ToolOutputTrim(this.estimator, opts.config.l1);
    this.l2 = new MessageSummarize(this.estimator, opts.streamFn, opts.model, opts.config.l2);
    this.l3 = new TaskStateExtraction(this.estimator, opts.streamFn, opts.model, opts.config.l3);
    this.l4 = new SessionCheckpointLevel(this.estimator, opts.sessionStorage, opts.config.l4);
    this.l5 = new NewSessionHandoff(this.estimator, opts.streamFn, opts.model, opts.config.l5);

    this.safetyGuard = new CompressionSafetyGuard({
      maxAttempts: opts.config.safety.maxAttempts,
      cooldownTurns: opts.config.safety.cooldownTurns,
      forkTimeoutMs: opts.config.safety.forkTimeoutMs ?? opts.config.forkTimeoutMs,
    });
    this.compressionConfig = opts.config;
    this.contextWindow = opts.contextWindow;
    this.sharedMap = opts.sharedMap;
    this.telemetryReporter = opts.telemetryReporter;
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

    const safetyState = this.getOrCreateState(sessionKey);
    if (!this.safetyGuard.canCompress(safetyState, turn)) return resources;

    let current = resources;
    const allTelemetry: CompressionTelemetry[] = [];
    const startTime = Date.now();

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
    }

    // ── 存储遥测到 safetyState 历史 ──
    safetyState.telemetryHistory.push(...allTelemetry);

    // ── 上报遥测：优先用 reporter，否则写入 sharedMap 供 Extension 读取 ──
    if (allTelemetry.length > 0 && this.compressionConfig.telemetry.enabled) {
      this.reportTelemetry(allTelemetry);
    }

    return current;
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

  private getOrCreateState(sessionKey: string): CompressionSafetyState {
    const existing = this.safetyStates.get(sessionKey);
    if (existing) {
      existing.lastAccess = Date.now();
      return existing.safety;
    }

    // LRU 淘汰
    if (this.safetyStates.size >= MAX_SESSIONS) {
      this.evictOldest();
    }

    const safety = createSafetyState({
      forkTimeoutMs: this.compressionConfig.forkTimeoutMs,
    });
    this.safetyStates.set(sessionKey, { safety, lastAccess: Date.now() });
    return safety;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.safetyStates) {
      if (entry.lastAccess < oldestTime) {
        oldestTime = entry.lastAccess;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const entry = this.safetyStates.get(oldestKey);
      if (entry) abortSafetyState(entry.safety);
      this.safetyStates.delete(oldestKey);
    }
  }
}

/** 工厂函数 */
export function createCompressionTransformer(
  options: CompressionTransformerOptions,
): ContextCompressionTransformer {
  return new ContextCompressionTransformer(options);
}
