/**
 * L4 - 会话检查点 (SessionCheckpoint)
 *
 * 先将完整会话持久化到 SessionStorage，然后激进缩减到最小工作集。
 * 信息从未真正丢失 - 可通过 checkpointId 恢复。
 * 触发条件: L3 后 estimatedTokens > contextWindow × 0.92
 *
 * 关键修复：
 *  - 持久化失败时根据 failOnPersistError 决定是否中止（默认中止，避免信息丢失）
 *  - recover 改为实例方法并在 transformer 上暴露
 *  - recover 不再丢失 taskState / compactionHistory
 *  - 保留所有 pinned 资源（包括 L3 的 task_state）
 */

import type {
  ContextResource, Message, SessionStorage, StoredSession, Usage,
} from '@aipack/agent';
import { resourcesToMessages, createEmptyUsage } from '@aipack/agent';
import { randomUUID } from 'node:crypto';
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
  /** 持久化失败时是否中止压缩（推荐 true，避免信息丢失） */
  failOnPersistError: boolean;
}

export interface SessionCheckpoint {
  checkpointId: string;
  sessionId: string;
  timestamp: number;
  fullMessages: Message[];
  /**
   * 原始 ContextResource 快照（含 pinned/meta/type 等完整信息）。
   * resourcesToMessages → 存储的往返会丢失 pinned/meta/type，恢复压缩
   * 保护语义失效；因此持久化时额外保存一份资源级快照。
   */
  fullResources?: ContextResource[];
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
    if (!this.sessionStorage) {
      // 没有存储后端：记录失败遥测，跳过 L4
      return {
        resources,
        telemetry: [createTelemetry('L4', 'session_checkpoint', 0, 0, {
          sessionKey, turn,
          failed: true,
          message: 'no_session_storage',
          compressionDepth: safety.compressionDepth,
        })],
      };
    }

    const beforeTokens = this.estimator.estimateAll(resources);
    const messages = resourcesToMessages(resources);

    const checkpoint: SessionCheckpoint = {
      // P1#8: 用 randomUUID 替代 Date.now()
      checkpointId: `ckpt_${randomUUID()}`,
      sessionId: sessionKey,
      timestamp: Date.now(),
      fullMessages: messages,
      // 保存完整资源快照：resourcesToMessages 往返会丢失 pinned/meta/type
      fullResources: resources,
      taskState: findTaskState(resources),
      compactionHistory: [...safety.telemetryHistory],
      resourceCount: resources.length,
      estimatedTokens: beforeTokens,
    };

    // 持久化检查点（必须成功才继续，否则会丢失信息）
    const persistResult = await this.persistCheckpoint(checkpoint);
    if (!persistResult.ok) {
      const telemetry = createTelemetry('L4', 'session_checkpoint', beforeTokens, beforeTokens, {
        sessionKey, turn,
        failed: true,
        message: `persist_failed:${persistResult.error ?? 'unknown'}`,
        compressionDepth: safety.compressionDepth,
      });
      if (this.config.failOnPersistError) {
        // 中止 L4：返回未压缩的 resources，避免信息丢失
        return { resources, telemetry: [telemetry] };
      }
      // 配置为容错：继续缩减（不推荐，但保留向后兼容选项）
    }

    // 构建最小工作集：保留所有 pinned（task_state / compaction_summary 等） + 最近 N 条非 pinned
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
        _recoverable: persistResult.ok,
      },
      pinned: true,
    };

    const result = [checkpointRef, ...workingSet].sort((a, b) => a.timestamp - b.timestamp);
    const afterTokens = this.estimator.estimateAll(result);
    const telemetry = createTelemetry('L4', 'session_checkpoint', beforeTokens, afterTokens, {
      sessionKey, turn,
      resourcesAffected: resources.length - workingSet.length,
      cachePreserved: false,
      compressionDepth: safety.compressionDepth + 1,
      message: persistResult.ok ? undefined : 'persist_failed_but_continued',
    });

    safety.compressionDepth++;
    safety.hasCheckpoint = persistResult.ok;
    safety.checkpointId = persistResult.ok ? checkpoint.checkpointId : undefined;

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

  /**
   * 持久化检查点到 SessionStorage，返回成功/失败结果。
   *
   * P0#2 修复：旧实现只存 messages，taskState / compactionHistory / estimatedTokens
   * 全部丢失，recover 出来的是残缺会话。现在用一个特殊 system message（role='system',
   * content 为 JSON）追加到 messages 末尾，recover 时识别并取出。
   */
  private async persistCheckpoint(
    checkpoint: SessionCheckpoint,
  ): Promise<{ ok: true } | { ok: false; error?: string }> {
    if (!this.sessionStorage) return { ok: false, error: 'no_session_storage' };

    const usage: Usage = createEmptyUsage();
    // 把结构化字段序列化为一个特殊 system message 追加到末尾
    const metaMessage: Message = {
      role: 'system',
      content: JSON.stringify({
        __checkpointMeta: true,
        checkpointId: checkpoint.checkpointId,
        sessionId: checkpoint.sessionId,
        timestamp: checkpoint.timestamp,
        taskState: checkpoint.taskState ?? null,
        compactionHistory: checkpoint.compactionHistory,
        resourceCount: checkpoint.resourceCount,
        estimatedTokens: checkpoint.estimatedTokens,
        // 完整资源快照（含 pinned/meta/type），避免 messages 往返丢失语义
        fullResources: checkpoint.fullResources ?? null,
      }),
      timestamp: checkpoint.timestamp,
    } as Message;

    const stored: StoredSession = {
      key: `checkpoint_${checkpoint.checkpointId}`,
      version: 1,
      messages: [...checkpoint.fullMessages, metaMessage],
      model: null,
      usage,
      createdAt: new Date(checkpoint.timestamp).toISOString(),
      updatedAt: new Date(checkpoint.timestamp).toISOString(),
    };

    try {
      await this.sessionStorage.save(stored.key, stored);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 从检查点恢复完整会话（实例方法，由 transformer 暴露）。
   *
   * P0#2 修复：从 messages 末尾取出 __checkpointMeta system message，
   * 还原 taskState / compactionHistory / estimatedTokens 等结构化字段。
   */
  async recover(checkpointId: string): Promise<SessionCheckpoint | null> {
    if (!this.sessionStorage) return null;
    try {
      const stored = await this.sessionStorage.load(`checkpoint_${checkpointId}`);
      if (!stored) return null;

      // 末尾的 system message 可能是 __checkpointMeta
      const messages = [...stored.messages];
      let taskState: TaskState | undefined;
      let compactionHistory: CompressionTelemetry[] = [];
      let resourceCount = messages.length;
      let estimatedTokens = 0;
      let timestamp = new Date(stored.updatedAt).getTime();

      const last = messages[messages.length - 1];
      let fullResources: ContextResource[] | undefined;
      if (last && last.role === 'system' && typeof last.content === 'string') {
        try {
          const parsed = JSON.parse(last.content) as {
            __checkpointMeta?: boolean;
            checkpointId?: string;
            sessionId?: string;
            timestamp?: number;
            taskState?: TaskState | null;
            compactionHistory?: CompressionTelemetry[];
            resourceCount?: number;
            estimatedTokens?: number;
            fullResources?: ContextResource[] | null;
          };
          if (parsed.__checkpointMeta) {
            messages.pop(); // 移除 meta message，只保留真实会话
            taskState = parsed.taskState ?? undefined;
            compactionHistory = parsed.compactionHistory ?? [];
            resourceCount = parsed.resourceCount ?? messages.length;
            estimatedTokens = parsed.estimatedTokens ?? 0;
            if (parsed.timestamp) timestamp = parsed.timestamp;
            // 旧格式检查点无 fullResources；有则还原完整资源快照
            if (Array.isArray(parsed.fullResources)) {
              fullResources = parsed.fullResources;
            }
          }
        } catch {
          // 非 JSON 或旧格式：保持原样，taskState/compactionHistory 为空
        }
      }

      return {
        checkpointId,
        sessionId: '',
        timestamp,
        fullMessages: messages,
        fullResources,
        taskState,
        compactionHistory,
        resourceCount,
        estimatedTokens,
      };
    } catch {
      return null;
    }
  }

  /** 静态恢复接口（保留向后兼容） */
  static async recover(
    sessionStorage: SessionStorage,
    checkpointId: string,
  ): Promise<SessionCheckpoint | null> {
    const level = new SessionCheckpointLevel(
      undefined as unknown as TokenEstimator,
      sessionStorage,
      undefined as unknown as L4Config,
    );
    return level.recover(checkpointId);
  }
}
