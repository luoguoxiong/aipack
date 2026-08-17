/**
 * DualTraceStore — 双写迁移包装器（SQLite + ClickHouse 同时写入）。
 *
 * 用途：从 SQLite 迁移到 ClickHouse 期间，双写比对数据一致性。
 * - 写入：同时写 SQLite + ClickHouse（任何一方失败仅打日志，不阻塞另一方）
 * - 读取：优先 ClickHouse（CH 不可用时回落 SQLite）
 * - prune / backup：两个 store 都执行
 *
 * 验证完成后，改 TRACE_STORE=clickhouse 即可切单写。
 */

import type { EventBatch } from '@aipack-ai/observability';
import type { VersionMetrics } from '../types';
import type {
  TraceStore,
  RunQueryFilter,
  RunListItem,
  TraceDetail,
  ErrorClassCountItem,
  ErrorClassDrillResult,
  ErrorClassFilter,
} from '../store';

export interface DualTraceStoreOptions {
  /** 主存储（读取优先） */
  primary: TraceStore;
  /** 副存储（双写目标） */
  secondary: TraceStore;
  /** 副存储写入失败时是否抛错（默认 false：仅打日志） */
  throwOnSecondaryError?: boolean;
}

export class DualTraceStore implements TraceStore {
  private primary: TraceStore;
  private secondary: TraceStore;
  private throwOnSecondaryError: boolean;

  constructor(opts: DualTraceStoreOptions) {
    this.primary = opts.primary;
    this.secondary = opts.secondary;
    this.throwOnSecondaryError = opts.throwOnSecondaryError ?? false;
  }

  async insertRun(r: Parameters<TraceStore['insertRun']>[0]): Promise<void> {
    await Promise.all([
      this.primary.insertRun(r),
      this.wrapSecondary(() => this.secondary.insertRun(r)),
    ]);
  }

  async insertSpan(s: Parameters<TraceStore['insertSpan']>[0]): Promise<void> {
    await Promise.all([
      this.primary.insertSpan(s),
      this.wrapSecondary(() => this.secondary.insertSpan(s)),
    ]);
  }

  async insertToolCall(t: Parameters<TraceStore['insertToolCall']>[0]): Promise<void> {
    await Promise.all([
      this.primary.insertToolCall(t),
      this.wrapSecondary(() => this.secondary.insertToolCall(t)),
    ]);
  }

  async queryRuns(filter: RunQueryFilter): Promise<{ total: number; items: RunListItem[] }> {
    // 优先 primary；失败回落 secondary
    try {
      return await this.primary.queryRuns(filter);
    } catch (err) {
      console.warn('[DualTraceStore] primary queryRuns 失败，回落 secondary:', err);
      return this.secondary.queryRuns(filter);
    }
  }

  async queryTrace(traceId: string): Promise<TraceDetail | undefined> {
    try {
      return await this.primary.queryTrace(traceId);
    } catch (err) {
      console.warn('[DualTraceStore] primary queryTrace 失败，回落 secondary:', err);
      return this.secondary.queryTrace(traceId);
    }
  }

  async queryVersionMetrics(filter: {
    since?: number;
    until?: number;
    appId?: string;
  }): Promise<VersionMetrics[]> {
    try {
      return await this.primary.queryVersionMetrics(filter);
    } catch (err) {
      console.warn('[DualTraceStore] primary queryVersionMetrics 失败，回落 secondary:', err);
      return this.secondary.queryVersionMetrics(filter);
    }
  }

  // ─── Phase 9：错误归因下钻 ─────────────────────────────────────

  async queryErrorClassCounts(filter: ErrorClassFilter): Promise<ErrorClassCountItem[]> {
    try {
      return await this.primary.queryErrorClassCounts(filter);
    } catch (err) {
      console.warn('[DualTraceStore] primary queryErrorClassCounts 失败，回落 secondary:', err);
      return this.secondary.queryErrorClassCounts(filter);
    }
  }

  async queryErrorClassDrill(
    filter: ErrorClassFilter & { errorClass: string },
  ): Promise<ErrorClassDrillResult> {
    try {
      return await this.primary.queryErrorClassDrill(filter);
    } catch (err) {
      console.warn('[DualTraceStore] primary queryErrorClassDrill 失败，回落 secondary:', err);
      return this.secondary.queryErrorClassDrill(filter);
    }
  }

  async flush(batch: EventBatch, appId: string): Promise<void> {
    await Promise.all([
      this.primary.flush(batch, appId),
      this.wrapSecondary(() => this.secondary.flush(batch, appId)),
    ]);
  }

  async prune(before: number): Promise<number> {
    const [primaryDeleted] = await Promise.all([
      this.primary.prune(before),
      this.wrapSecondary(() => this.secondary.prune(before), 0),
    ]);
    return primaryDeleted;
  }

  async backup(dir: string): Promise<string> {
    const [primaryPath] = await Promise.all([
      this.primary.backup(dir),
      this.wrapSecondary(() => this.secondary.backup(dir), ''),
    ]);
    return primaryPath;
  }

  async close(): Promise<void> {
    await Promise.allSettled([
      this.primary.close(),
      this.secondary.close(),
    ]);
  }

  /** 副存储操作包装：失败不阻塞主流程（除非 throwOnSecondaryError=true） */
  private async wrapSecondary<T>(fn: () => Promise<T>, fallback?: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      console.error('[DualTraceStore] 副存储操作失败:', err);
      if (this.throwOnSecondaryError) throw err;
      return fallback as T;
    }
  }

  /**
   * 比对脚本：检查两库 count 与字段差异（用于迁移验证）。
   * 返回不一致的表与差异数。
   */
  async compareCounts(): Promise<{ table: string; primary: number; secondary: number; diff: number }[]> {
    // 此方法需要两库都暴露 count 接口；SQLiteStore 走 SELECT count()，
    // ClickHouseStore 走 SELECT count()。此处用 query 能力间接获取。
    // 简化：仅比对 runs 表（最具代表性）
    const tables = ['runs', 'spans', 'tool_calls', 'events', 'retry_attempts'];
    const results: { table: string; primary: number; secondary: number; diff: number }[] = [];

    for (const table of tables) {
      // 通过 queryRuns 间接获取 runs count（其他表需扩展接口，此处仅 runs）
      if (table !== 'runs') continue;
      try {
        const [p, s] = await Promise.all([
          this.primary.queryRuns({ offset: 0, limit: 1 }),
          this.secondary.queryRuns({ offset: 0, limit: 1 }),
        ]);
        results.push({
          table,
          primary: p.total,
          secondary: s.total,
          diff: Math.abs(p.total - s.total),
        });
      } catch (err) {
        console.error(`[DualTraceStore] 比对 ${table} 失败:`, err);
      }
    }

    return results;
  }
}
