/**
 * L5 - 新会话交接 (NewSessionHandoff)
 *
 * 最终保底：创建新会话，通过交接文档传递关键上下文。
 * 旧会话归档保留。断路器触发后冷却 N 轮。
 * 触发条件: L4 后 estimatedTokens > contextWindow × 0.95
 *
 * 关键修复：
 *  - 新增 onHandoff 回调：让上层（runtime/IDE）有机会真正创建新会话、迁移 sessionKey
 *  - forkModel / forkMaxTokens 真正生效
 *  - fork 失败时仍写 fallback 文档（原行为保留），但 telemetry 标注 _fallback
 */

import {
  randomUUID,
} from 'node:crypto';
import type {
  ContextResource, Model, Context, StreamFn,
} from 'agentpack';
import { extractTextFromResource } from 'agentpack';
import type { TokenEstimator } from './token-estimator';
import type { CompressionTelemetry } from './telemetry';
import { createTelemetry } from './telemetry';
import type { CompressionSafetyState } from './safety';
import type { TaskState } from './l3-task-state-extraction';
import { findTaskState } from './l3-task-state-extraction';
import type { CompressResult } from './l1-tool-output-trim';
import { runForkWithRetry, ForkStreamError, type RetryConfig, type ForkResult, type ForkCallbackResult } from './retry';

export interface L5Config {
  enabled: boolean;
  threshold: number;
  forkModel?: string;
  forkMaxTokens: number;
}

export interface SessionHandoff {
  handoffId: string;
  originalSessionId: string;
  newSessionId: string;
  timestamp: number;
  handoffDocument: string;
  taskState?: TaskState;
  checkpointId?: string;
  reason: string;
  /** 是否使用了 fallback 文档（fork 失败） */
  fallback: boolean;
}

export interface HandoffHookContext {
  handoff: SessionHandoff;
  /** 上层可设置该字段以覆盖默认 handoffResource */
  handoffResource?: ContextResource;
}

export type HandoffHook = (ctx: HandoffHookContext) => void | Promise<void>;

const L5_PROMPT = `You are a session handoff agent.
A previous agent session has exhausted its context window after multiple compression attempts.
Generate a concise handoff document that allows a fresh session to continue the task seamlessly.

The handoff document MUST include:
1. **Original Task**: What the user originally asked for
2. **What Was Done**: Summary of completed work and key results
3. **Current State**: Where the task currently stands
4. **What Remains**: Specific next steps to complete the task
5. **Critical Context**: Any constraints, decisions, or facts that must be preserved
6. **Errors/Issues**: Any errors encountered that the new session should be aware of

Be concise but complete. The new session will have NO other context besides this document.`;

export class NewSessionHandoff {
  /** 上层注入的 handoff 钩子（用于真正切换会话） */
  private onHandoff?: HandoffHook;

  constructor(
    private estimator: TokenEstimator,
    private streamFn: StreamFn,
    private model: Model,
    private config: L5Config,
    /** P0#1/#4: 单次 fork 超时（ms），由 transformer 注入 */
    private forkTimeoutMs: number,
    /** P0#4: 重试配置 */
    private retry: RetryConfig,
  ) {}

  /** 注入 handoff 钩子 */
  setHandoffHook(hook: HandoffHook): void {
    this.onHandoff = hook;
  }

  async compress(
    resources: ContextResource[],
    contextWindow: number,
    safety: CompressionSafetyState,
    sessionKey: string,
    turn: number,
  ): Promise<CompressResult & { handoff?: SessionHandoff }> {
    if (!this.config.enabled) return { resources, telemetry: [] };

    const allContext = this.collectContext(resources, safety);
    const forkOut = await this.forkHandoff(allContext, safety, sessionKey, turn);
    const handoffDoc = forkOut.ok && forkOut.value ? forkOut.value : null;
    const isFallback = !handoffDoc;

    const now = Date.now();
    const handoff: SessionHandoff = {
      // P1#8: 用 randomUUID 替代 Date.now()，避免同毫秒冲突
      handoffId: `handoff_${randomUUID()}`,
      originalSessionId: sessionKey,
      newSessionId: `${sessionKey}_h${now}_${randomUUID().slice(0, 8)}`,
      timestamp: now,
      handoffDocument: handoffDoc ?? this.fallbackDoc(resources, safety),
      taskState: findTaskState(resources),
      checkpointId: safety.checkpointId,
      reason: safety.circuitBreakerTripped
        ? 'circuit_breaker_triggered'
        : 'threshold_exceeded',
      fallback: isFallback,
    };

    // 默认 handoff 资源：作为新会话首条 user message
    let handoffResource: ContextResource = {
      id: `handoff_${handoff.handoffId}`,
      type: 'user_message',
      role: 'user',
      content: this.formatHandoffAsUserMessage(handoff),
      timestamp: now,
      dependencies: [],
      meta: {
        _compressionLevel: 5,
        _isHandoff: true,
        _originalSessionId: sessionKey,
        _newSessionId: handoff.newSessionId,
        _fallback: isFallback,
      },
      pinned: true,
    };

    // 触发 handoff 钩子，让上层有机会真正创建新会话、覆盖 handoffResource
    if (this.onHandoff) {
      try {
        const hookCtx: HandoffHookContext = { handoff };
        await this.onHandoff(hookCtx);
        if (hookCtx.handoffResource) {
          handoffResource = hookCtx.handoffResource;
        }
      } catch {
        // hook 失败不阻塞压缩流程，使用默认 handoffResource
      }
    }

    const systemMessages = resources.filter(r => r.type === 'system_message');
    let result: ContextResource[] = [...systemMessages, handoffResource];

    // P1#9 修复：L5 完成后必须复检，若仍超 contextWindow 则对 handoff doc 自身硬截断。
    // 旧实现不复检，systemMessages + handoffResource 本身可能超窗，handoffCompleted=true
    // 后续 canCompress 永远 false，会陷入"压缩完成但实际未达标"的死循环空间。
    result = this.hardTruncateIfOverWindow(result, contextWindow, handoff);

    const beforeTokens = this.estimator.estimateAll(resources);
    const afterTokens = this.estimator.estimateAll(result);
    const telemetry = createTelemetry('L5', 'new_session_handoff', beforeTokens, afterTokens, {
      sessionKey, turn,
      resourcesAffected: resources.length,
      triggerReason: handoff.reason,
      cachePreserved: false,
      compressionDepth: safety.compressionDepth + 1,
      message: isFallback ? 'used_fallback_doc' : undefined,
      forkDurationMs: forkOut.durationMs,
      forkRetries: forkOut.retries,
      forkModelId: this.resolveForkModel().id,
      forkUsage: forkOut.usage,
    });

    safety.compressionDepth++;
    safety.circuitBreakerTripped = true;
    safety.handoffCompleted = true;

    return { resources: result, telemetry: [telemetry], handoff };
  }

  /**
   * P1#9: 硬截断兜底。若 L5 结果仍超 contextWindow，对 handoffResource 内容做硬截断。
   * 策略：保留 systemMessages 全量；handoffResource 按剩余 token 预算截断。
   */
  private hardTruncateIfOverWindow(
    result: ContextResource[],
    contextWindow: number,
    handoff: SessionHandoff,
  ): ContextResource[] {
    const currentTokens = this.estimator.estimateAll(result);
    if (currentTokens <= contextWindow) return result;

    // 找到 handoffResource（id 以 handoff_ 开头）
    const handoffIdx = result.findIndex(r => r.id === `handoff_${handoff.handoffId}`);
    if (handoffIdx === -1) return result;

    const systemTokens = this.estimator.estimateAll(result.filter((_, i) => i !== handoffIdx));
    // 给截断后内容预留 64 token 缓冲（截断标记 + 估算误差）
    const budgetForHandoff = Math.max(64, contextWindow - systemTokens - 64);
    if (budgetForHandoff <= 0) {
      // system 本身就超窗：只能保留极少 handoff 摘要
      return result;
    }

    const handoffResource = result[handoffIdx];
    const originalText = typeof handoffResource.content === 'string'
      ? handoffResource.content
      : extractTextFromResource(handoffResource);

    // 按字符近似截断（用 estimator 校准）
    // 注意：每次迭代前必须 invalidate 该资源缓存。testResource 与 handoffResource 同 id，
    // estimator 以 id 为 cache key，否则循环内 estimate 永远命中旧值，截断永不生效。
    const charsPerTokenFallback = 4;
    let cutLen = budgetForHandoff * charsPerTokenFallback;
    while (cutLen > 0) {
      this.estimator.invalidate(handoffResource.id);
      const cutText = originalText.slice(0, cutLen);
      const testResource: ContextResource = {
        ...handoffResource,
        content: cutText + `\n\n[... handoff truncated: ${originalText.length - cutLen} chars omitted ...]`,
      };
      const testTokens = this.estimator.estimate(testResource);
      if (testTokens <= budgetForHandoff) {
        result[handoffIdx] = testResource;
        break;
      }
      cutLen = Math.floor(cutLen * 0.8);
    }
    return result;
  }

  private collectContext(resources: ContextResource[], safety: CompressionSafetyState): string {
    const parts: string[] = [];

    const taskState = findTaskState(resources);
    if (taskState) {
      parts.push(`## Task State\n${JSON.stringify(taskState, null, 2)}`);
    }

    const compactionSummaries = resources.filter(r => r.type === 'compaction_summary');
    if (compactionSummaries.length > 0) {
      parts.push(`## Previous Summaries\n${compactionSummaries.map(r => extractTextFromResource(r)).join('\n\n')}`);
    }

    const recent = resources.slice(-6);
    const recentText = recent
      .map(r => `[${r.type}] ${extractTextFromResource(r)}`)
      .join('\n\n');
    parts.push(`## Recent Context\n${recentText}`);

    if (safety.checkpointId) {
      parts.push(`## Checkpoint\nA full session checkpoint is available: ${safety.checkpointId}`);
    }

    return parts.join('\n\n---\n\n');
  }

  private async forkHandoff(
    allContext: string,
    safety: CompressionSafetyState,
    sessionKey: string,
    turn: number,
  ): Promise<ForkResult<string>> {
    const forkModel = this.resolveForkModel();
    const context: Context = {
      systemPrompt: L5_PROMPT,
      messages: [{
        role: 'user',
        content: `Generate a handoff document for:\n\n${allContext}`,
        timestamp: Date.now(),
      }],
    };

    // P2#16: 透传 sessionId
    const forkSessionId = `${sessionKey}#L5#t${turn}`;

    const out = await runForkWithRetry(
      safety,
      this.forkTimeoutMs,
      this.retry,
      async (signal) => {
        let text = '';
        let usage: ForkCallbackResult<string>['usage'];
        for await (const event of this.streamFn(forkModel, context, {
          signal,
          sessionId: forkSessionId,
        })) {
          if (event.type === 'text_delta') text += event.delta;
          if (event.type === 'done' && event.message.usage) {
            usage = {
              input: event.message.usage.input,
              output: event.message.usage.output,
              total: event.message.usage.total,
            };
          }
          if (event.type === 'error') {
            const errMsg = event.message as { errorMessage?: string; status?: number } | undefined;
            throw new ForkStreamError(
              errMsg?.errorMessage ?? 'stream_error',
              true,
              errMsg?.status,
            );
          }
        }
        return { value: text || null, usage };
      },
    );

    // 空文档视为失败（fallback）
    if (!out.ok || !out.value) {
      return { ok: false, value: null, retries: out.retries, durationMs: out.durationMs };
    }
    return { ok: true, value: out.value, usage: out.usage, retries: out.retries, durationMs: out.durationMs };
  }

  /** Fork 失败时的硬编码兜底文档 */
  private fallbackDoc(resources: ContextResource[], safety: CompressionSafetyState): string {
    const taskState = findTaskState(resources);
    const lastUserMsg = [...resources].reverse().find(r => r.type === 'user_message');
    const originalRequest = taskState?.originalRequest
      ?? (lastUserMsg ? extractTextFromResource(lastUserMsg).slice(0, 500) : 'Unknown');

    const completedSteps = taskState?.completedSteps?.map(s => `- ${s}`).join('\n') ?? '- (unknown)';
    const pendingSteps = taskState?.pendingSteps?.map(s => `- ${s}`).join('\n') ?? '- (unknown)';

    return `## Fallback Handoff

Original request: ${originalRequest}

Completed steps:
${completedSteps}

Pending steps:
${pendingSteps}

Please continue from where the previous session left off.`;
  }

  /** 格式化交接文档为新会话首条 user message */
  private formatHandoffAsUserMessage(handoff: SessionHandoff): string {
    const lines = [
      '## Session Handoff',
      '',
      `This session was continued from a previous session that exceeded context limits.`,
      '',
      `**Original Session:** ${handoff.originalSessionId}`,
      `**New Session:** ${handoff.newSessionId}`,
      `**Handoff Time:** ${new Date(handoff.timestamp).toISOString()}`,
      `**Reason:** ${handoff.reason}`,
      '',
      '---',
      '',
      handoff.handoffDocument,
      '',
      '---',
    ];

    if (handoff.checkpointId) {
      lines.push(`**Note:** Full context from the previous session is available as checkpoint \`${handoff.checkpointId}\`.`);
    }

    lines.push('Please continue the task based on the information above.');

    return lines.join('\n');
  }

  /** 解析 fork 用模型 */
  private resolveForkModel(): Model {
    const { forkModel, forkMaxTokens } = this.config;
    if (!forkModel && !forkMaxTokens) return this.model;
    return {
      ...this.model,
      ...(forkModel ? { id: forkModel, name: forkModel } : {}),
      maxTokens: forkMaxTokens || this.model.maxTokens,
    };
  }
}
