/**
 * 复合压缩转换器 - 五级渐进式降级协调器
 *
 * 作为单个 ContextTransformer (priority=40) 插入 Pipeline，
 * 内部按序执行 L1 → L2 → L3 → L4 → L5，每级仅在前一级不足时触发。
 */

import type {
  ContextResource, TransformContext, Model, StreamFn, SessionStorage,
} from 'agentpack';
import { BaseTransformer } from 'agentpack';
import type { TokenEstimator } from './token-estimator';
import type { CompressionConfig } from './config';
import type { CompressionTelemetry } from './telemetry';
import {
  CompressionSafetyGuard,
  createSafetyState,
  type CompressionSafetyState,
} from './safety';
import { ToolOutputTrim } from './l1-tool-output-trim';
import { MessageSummarize } from './l2-message-summarize';
import { TaskStateExtraction } from './l3-task-state-extraction';
import { SessionCheckpointLevel } from './l4-session-checkpoint';
import { NewSessionHandoff } from './l5-new-session-handoff';
import { CharHeuristicEstimator } from './token-estimator';

export interface CompressionTransformerOptions {
  config: CompressionConfig;
  model: Model;
  streamFn: StreamFn;
  sessionStorage?: SessionStorage;
  contextWindow: number;
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

  // 按 sessionKey 缓存安全状态
  private safetyStates = new Map<string, CompressionSafetyState>();

  constructor(opts: CompressionTransformerOptions) {
    super({ priority: 40 });

    // 如果 config 提供了自定义 estimator 参数，使用之
    const asciiRatio = opts.config.charsPerToken.ascii;
    const cjkRatio = opts.config.charsPerToken.cjk;

    this.estimator = new CharHeuristicEstimator(asciiRatio, cjkRatio);

    this.l1 = new ToolOutputTrim(this.estimator, opts.config.l1);
    this.l2 = new MessageSummarize(this.estimator, opts.streamFn, opts.model, opts.config.l2);
    this.l3 = new TaskStateExtraction(this.estimator, opts.streamFn, opts.model, opts.config.l3);
    this.l4 = new SessionCheckpointLevel(this.estimator, opts.sessionStorage, opts.config.l4);
    this.l5 = new NewSessionHandoff(this.estimator, opts.streamFn, opts.model, opts.config.l5);

    this.safetyGuard = new CompressionSafetyGuard(opts.config.safety);
    this.compressionConfig = opts.config;
    this.contextWindow = opts.contextWindow;
  }

  protected async run(
    resources: ContextResource[],
    context: TransformContext,
  ): Promise<ContextResource[]> {
    if (!this.compressionConfig.enabled) return resources;

    const sessionKey = context.runtime.sessionKey;
    const turn = context.runtime.turn;

    const safetyState = this.getOrCreateState(sessionKey);
    if (!this.safetyGuard.canCompress(safetyState)) return resources;

    // 每次 pipeline 执行重置尝试计数（防止跨轮次累积导致过早熔断）
    safetyState.attemptCount = 0;

    let current = resources;
    const allTelemetry: CompressionTelemetry[] = [];
    const startTime = Date.now();

    const currentTokens = this.estimator.estimateAll(current);

    // ── L1: 工具输出裁剪 ──
    if (currentTokens > this.contextWindow * this.compressionConfig.l1.threshold) {
      const result = await this.l1.compress(current, this.contextWindow, sessionKey, turn);
      current = result.resources;
      allTelemetry.push(...result.telemetry);
      safetyState.attemptCount++;
    }

    // ── L2: 旧消息摘要 ──
    if (this.estimator.estimateAll(current) > this.contextWindow * this.compressionConfig.l2.threshold) {
      const result = await this.l2.compress(current, this.contextWindow, safetyState, sessionKey, turn);
      current = result.resources;
      allTelemetry.push(...result.telemetry);
      safetyState.attemptCount++;
    }

    // ── L3: 任务状态提取 ──
    if (this.estimator.estimateAll(current) > this.contextWindow * this.compressionConfig.l3.threshold) {
      const result = await this.l3.compress(current, this.contextWindow, safetyState, sessionKey, turn);
      current = result.resources;
      allTelemetry.push(...result.telemetry);
      safetyState.attemptCount++;
    }

    // ── L4: 会话检查点 ──
    if (this.estimator.estimateAll(current) > this.contextWindow * this.compressionConfig.l4.threshold) {
      const result = await this.l4.compress(current, this.contextWindow, safetyState, sessionKey, turn);
      current = result.resources;
      allTelemetry.push(...result.telemetry);
      safetyState.attemptCount++;
    }

    // ── L5: 新会话交接 ──
    if (this.estimator.estimateAll(current) > this.contextWindow * this.compressionConfig.l5.threshold) {
      const result = await this.l5.compress(current, this.contextWindow, safetyState, sessionKey, turn);
      current = result.resources;
      allTelemetry.push(...result.telemetry);
      safetyState.attemptCount++;
    }

    // ── 安全验证 ──
    if (!this.safetyGuard.validateToolPairing(current)) {
      current = resources;
    }

    // ── 补充遥测元信息 ──
    const duration = Date.now() - startTime;
    for (const t of allTelemetry) {
      t.sessionKey = sessionKey;
      t.turn = turn;
      t.duration = duration;
    }

    // ── 存储遥测到 shared state ──
    safetyState.telemetryHistory.push(...allTelemetry);

    return current;
  }

  private getOrCreateState(sessionKey: string): CompressionSafetyState {
    if (!this.safetyStates.has(sessionKey)) {
      this.safetyStates.set(sessionKey, createSafetyState());
    }
    return this.safetyStates.get(sessionKey)!;
  }
}

/** 工厂函数 */
export function createCompressionTransformer(
  options: CompressionTransformerOptions,
): ContextCompressionTransformer {
  return new ContextCompressionTransformer(options);
}
