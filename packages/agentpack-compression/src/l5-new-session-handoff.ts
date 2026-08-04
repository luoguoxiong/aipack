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
    const handoffDoc = await this.forkHandoff(allContext, safety);
    const isFallback = !handoffDoc;

    const handoff: SessionHandoff = {
      handoffId: `handoff_${Date.now()}`,
      originalSessionId: sessionKey,
      newSessionId: `${sessionKey}_h${Date.now()}`,
      timestamp: Date.now(),
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
      timestamp: Date.now(),
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
    const result = [...systemMessages, handoffResource];

    const beforeTokens = this.estimator.estimateAll(resources);
    const afterTokens = this.estimator.estimateAll(result);
    const telemetry = createTelemetry('L5', 'new_session_handoff', beforeTokens, afterTokens, {
      sessionKey, turn,
      resourcesAffected: resources.length,
      triggerReason: handoff.reason,
      cachePreserved: false,
      compressionDepth: safety.compressionDepth + 1,
      message: isFallback ? 'used_fallback_doc' : undefined,
    });

    safety.compressionDepth++;
    safety.circuitBreakerTripped = true;
    safety.handoffCompleted = true;

    return { resources: result, telemetry: [telemetry], handoff };
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
  ): Promise<string | null> {
    const forkModel = this.resolveForkModel();
    const context: Context = {
      systemPrompt: L5_PROMPT,
      messages: [{
        role: 'user',
        content: `Generate a handoff document for:\n\n${allContext}`,
        timestamp: Date.now(),
      }],
    };

    try {
      let output = '';
      for await (const event of this.streamFn(forkModel, context, {
        signal: safety.abortController?.signal,
      })) {
        if (event.type === 'text_delta') output += event.delta;
        if (event.type === 'error') return null;
      }
      return output || null;
    } catch {
      return null;
    }
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
