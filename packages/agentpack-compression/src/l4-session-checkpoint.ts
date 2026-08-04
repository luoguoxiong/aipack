/**
 * L4 - 会话检查点 (SessionCheckpoint)
 *
 * 先将完整会话持久化到 SessionStorage，然后激进缩减到最小工作集。
 * 信息从未真正丢失 - 可通过 checkpointId 恢复。
 * 触发条件: L3 后 estimatedTokens > contextWindow × 0.92
 */

import type {
  ContextResource, Message, SessionStorage, StoredSession, Usage,
} from 'agentpack';
import { resourcesToMessages, createEmptyUsage } from 'agentpack';
import type { TokenEstimator } from './token-estimator';
import type { CompressionTelemetry } from './telemetry';
import { createTelemetry } from './telemetry';
import type { CompressionSafetyState } from './safety';
import type { TaskState } from './l3-task-state-extraction';
import { findTaskState } from './l3-task-state-extraction';
import type { CompressResult } from './l1-tool-output-trim';

export interface L4Config {
  enabled: boolean;
  threshold: number;
  targetRatio: number;
  checkpointStorage: 'file' | 'memory' | 'custom';
  minWorkingSet: number;
}

export interface SessionCheckpoint {
  checkpointId: string;
  sessionId: string;
  timestamp: number;
  fullMessages: Message[];
  taskState?: TaskState;
  compactionHistory: CompressionTelemetry[];
  resourceCount: number;
  estimatedTokens: number;
}

export class SessionCheckpointLevel {
  constructor(
    private estimator: TokenEstimator,
    private sessionStorage: SessionStorage | undefined,
    private config: L4Config,
  ) {}

  async compress(
    resources: ContextResource[],
    contextWindow: number,
    safety: CompressionSafetyState,
    sessionKey: string,
    turn: number,
  ): Promise<CompressResult> {
    if (!this.config.enabled) return { resources, telemetry: [] };
    if (!this.sessionStorage) return { resources, telemetry: [] };

    const beforeTokens = this.estimator.estimateAll(resources);
    const messages = resourcesToMessages(resources);

    const checkpoint: SessionCheckpoint = {
      checkpointId: `ckpt_${Date.now()}`,
      sessionId: sessionKey,
      timestamp: Date.now(),
      fullMessages: messages,
      taskState: findTaskState(resources),
      compactionHistory: [...safety.telemetryHistory],
      resourceCount: resources.length,
      estimatedTokens: beforeTokens,
    };

    // 持久化检查点
    await this.persistCheckpoint(checkpoint);

    // 构建最小工作集
    const workingSet = this.buildMinimalWorkingSet(resources);

    const checkpointRef: ContextResource = {
      id: `checkpoint_ref_${checkpoint.checkpointId}`,
      type: 'custom',
      role: 'system',
      content: `[Session Checkpoint: ${checkpoint.checkpointId}]\n`
             + `Saved at ${new Date(checkpoint.timestamp).toISOString()}.\n`
             + `Resources: ${checkpoint.resourceCount}, Tokens: ${checkpoint.estimatedTokens}.\n`
             + `Recovery: load checkpoint ${checkpoint.checkpointId}.`,
      timestamp: Date.now(),
      dependencies: [],
      meta: {
        _compressionLevel: 4,
        _checkpointId: checkpoint.checkpointId,
        _recoverable: true,
      },
      pinned: true,
    };

    const result = [checkpointRef, ...workingSet];
    const afterTokens = this.estimator.estimateAll(result);
    const telemetry = createTelemetry('L4', 'session_checkpoint', beforeTokens, afterTokens, {
      sessionKey, turn,
      resourcesAffected: resources.length - workingSet.length,
      cachePreserved: false,
      compressionDepth: safety.compressionDepth + 1,
    });

    safety.compressionDepth++;
    safety.hasCheckpoint = true;
    safety.checkpointId = checkpoint.checkpointId;

    return { resources: result, telemetry: [telemetry] };
  }

  /** 构建最小工作集：pinned + 最近 N 条非 pinned */
  private buildMinimalWorkingSet(resources: ContextResource[]): ContextResource[] {
    const pinned = resources.filter(r => r.pinned);
    const unpinned = resources.filter(r => !r.pinned);
    const recent = unpinned.slice(-this.config.minWorkingSet);

    const pinnedIds = new Set(pinned.map(r => r.id));
    const newRecent = recent.filter(r => !pinnedIds.has(r.id));

    return [...pinned, ...newRecent].sort((a, b) => a.timestamp - b.timestamp);
  }

  /** 持久化检查点到 SessionStorage */
  private async persistCheckpoint(checkpoint: SessionCheckpoint): Promise<void> {
    if (!this.sessionStorage) return;

    const usage: Usage = createEmptyUsage();
    const stored: StoredSession = {
      key: `checkpoint_${checkpoint.checkpointId}`,
      version: 1,
      messages: checkpoint.fullMessages,
      model: null,
      usage,
      createdAt: new Date(checkpoint.timestamp).toISOString(),
      updatedAt: new Date(checkpoint.timestamp).toISOString(),
    };

    try {
      await this.sessionStorage.save(stored.key, stored);
    } catch {
      // 持久化失败不阻塞压缩流程
    }
  }

  /** 从检查点恢复完整会话 */
  static async recover(
    sessionStorage: SessionStorage,
    checkpointId: string,
  ): Promise<SessionCheckpoint | null> {
    try {
      const stored = await sessionStorage.load(`checkpoint_${checkpointId}`);
      if (!stored) return null;

      return {
        checkpointId,
        sessionId: '',
        timestamp: new Date(stored.updatedAt).getTime(),
        fullMessages: stored.messages,
        resourceCount: stored.messages.length,
        estimatedTokens: 0,
        compactionHistory: [],
      };
    } catch {
      return null;
    }
  }
}
