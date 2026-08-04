/**
 * L5 - 新会话交接 (NewSessionHandoff)
 *
 * 最终保底：创建新会话，通过交接文档传递关键上下文。
 * 旧会话归档保留。断路器触发后冷却 5 轮。
 * 触发条件: L4 后 estimatedTokens > contextWindow × 0.95
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
}

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
  constructor(
    private estimator: TokenEstimator,
    private streamFn: StreamFn,
    private model: Model,
    private config: L5Config,
  ) {}

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
    };

    const handoffResource: ContextResource = {
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
        _fallback: !handoffDoc,
      },
      pinned: true,
    };

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
      for await (const event of this.streamFn(this.model, context, {
        signal: safety.abortSignal,
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

    return `## Fallback Handoff

Original request: ${originalRequest}

Completed steps:
${taskState?.completedSteps.map(s => `- ${s}`).join('\n') ?? '- (unknown)'}

Pending steps:
${taskState?.pendingSteps.map(s => `- ${s}`).join('\n') ?? '- (unknown)'}

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
}
