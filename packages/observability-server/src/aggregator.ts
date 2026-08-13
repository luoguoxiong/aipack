/**
 * 内存聚合器：滑动窗口 + 对数直方图，事件同步更新、不阻塞。
 *
 * 收集端收到 ingest 上报后以 record 为单位喂入（ingestRun / ingestModelCall /
 * ingestToolCall / ingestPermission），时间按 bucketMs（默认 1min）切片，
 * 窗口 windowMs（默认 60min），事件到达时惰性清理过期桶。
 * 同时维护全局窗口与 model / tool / session 三个维度窗口。
 */

import { Histogram } from './histogram';
import type { RunRecord, SpanRecord, ToolCallRecord, PermissionRecord, RetryRecord } from '@aipack/observability';
import type {
  AggregatedMetrics,
  GroupBy,
  SummaryFilter,
  TimeseriesMetric,
  TimeseriesPoint,
  ToolStat,
} from './types';

interface ToolAgg {
  calls: number;
  ok: number;
  error: number;
  totalMs: number;
}

interface DimensionStats {
  requests: number;
  success: number;
  totalTokens: number;
  duration: Histogram;
  turnsSum: number;
  turnsCount: number;
  modelCalls: number;
  retries: number;
  permissionDenied: number;
  tools: Map<string, ToolAgg>;
  errorClass: Map<string, number>;
  /** P2-2 重试分布：status（'429'/'502'/'unknown'）-> 次数 */
  retriesByStatus: Map<string, number>;
  /** P2-2 重试退避时长直方图（ms） */
  retryBackoff: Histogram;
}

function newStats(): DimensionStats {
  return {
    requests: 0,
    success: 0,
    totalTokens: 0,
    duration: new Histogram(),
    turnsSum: 0,
    turnsCount: 0,
    modelCalls: 0,
    retries: 0,
    permissionDenied: 0,
    tools: new Map(),
    errorClass: new Map(),
    retriesByStatus: new Map(),
    retryBackoff: new Histogram(),
  };
}

export interface AggregatorOptions {
  /** 滑动窗口（ms），默认 60min */
  windowMs?: number;
  /** 时间桶粒度（ms），默认 1min */
  bucketMs?: number;
}

type DimName = 'model' | 'tool' | 'session' | 'version';

export class Aggregator {
  private windowBuckets: number;
  private bucketMs: number;
  private global = new Map<number, DimensionStats>();
  private dims: Record<DimName, Map<string, Map<number, DimensionStats>>> = {
    model: new Map(),
    tool: new Map(),
    session: new Map(),
    version: new Map(),
  };
  /** traceId -> 版本（run 上报时记录，spans/toolCalls 无版本字段，靠它归入 version 维度；sweep 清理过期） */
  private traceVersion = new Map<string, { version: string; idx: number }>();

  constructor(opts: AggregatorOptions = {}) {
    this.bucketMs = opts.bucketMs ?? 60 * 1000;
    this.windowBuckets = Math.max(
      1,
      Math.ceil((opts.windowMs ?? 60 * 60 * 1000) / this.bucketMs),
    );
  }

  // ─── record 入口（收集端 ingest 后喂入）────────────────────────

  ingestRun(r: RunRecord): void {
    this.sweep();
    const idx = this.nowBucket();
    const model = r.model ?? 'unknown';
    const version = r.appVersion ?? 'unknown';
    // 记录 trace 归属版本，供后续 spans/toolCalls 归入对应 version 维度
    this.traceVersion.set(r.traceId, { version, idx });
    const buckets = [
      getOrCreate(this.global, idx),
      this.dimBucket('model', model, idx),
      this.dimBucket('session', r.sessionKey, idx),
      this.dimBucket('version', version, idx),
    ];
    for (const st of buckets) {
      recordRun(st, r);
    }
  }

  ingestModelCall(s: SpanRecord): void {
    if (s.kind !== 'model') return;
    this.sweep();
    const idx = this.nowBucket();
    const modelId = s.name.replace(/^model:/, '');
    const retries = Math.max(0, (s.attempts ?? 1) - 1);
    // token 消耗只在模型 span 累计（模型调用 token 之和 = run 级 token），避免重复
    const tokens = (s.inputTokens ?? 0) + (s.outputTokens ?? 0) + (s.cacheRead ?? 0) + (s.cacheWrite ?? 0);
    const version = this.traceVersion.get(s.traceId)?.version ?? 'unknown';
    for (const st of [
      getOrCreate(this.global, idx),
      this.dimBucket('model', modelId, idx),
      this.dimBucket('session', s.sessionKey ?? 'unknown', idx),
      this.dimBucket('version', version, idx),
    ]) {
      st.modelCalls += 1;
      st.retries += retries;
      st.totalTokens += tokens;
      st.duration.insert(s.durationMs);
      if (s.errorClass) bump(st.errorClass, s.errorClass);
    }
  }

  ingestToolCall(t: ToolCallRecord): void {
    this.sweep();
    const idx = this.nowBucket();
    const isOk = t.status === 'ok';
    const isErr = t.status === 'error';
    const version = this.traceVersion.get(t.traceId)?.version ?? 'unknown';
    for (const st of [
      getOrCreate(this.global, idx),
      this.dimBucket('tool', t.toolName, idx),
      this.dimBucket('version', version, idx),
    ]) {
      // 工具维度桶的 requests 即调用次数（供 groupBy=tool）；version 维度桶与全局桶口径一致
      if (isOk || isErr) {
        st.requests += 1;
        st.duration.insert(t.durationMs);
      }
      const agg = st.tools.get(t.toolName) ?? { calls: 0, ok: 0, error: 0, totalMs: 0 };
      if (isOk || isErr) {
        agg.calls += 1;
        agg.totalMs += t.durationMs;
      }
      if (isOk) agg.ok += 1;
      if (isErr) agg.error += 1;
      st.tools.set(t.toolName, agg);
    }
  }

  ingestPermission(p: PermissionRecord): void {
    this.sweep();
    const st = getOrCreate(this.global, this.nowBucket());
    st.permissionDenied += 1;
    // 仅计入全局计数；工具统计不把被拒调用计入分母（§3 关键坑）
  }

  ingestRetry(r: RetryRecord): void {
    this.sweep();
    const idx = this.nowBucket();
    const status = r.status !== undefined ? String(r.status) : 'unknown';
    const modelId = r.modelId || 'unknown';
    // 重试次数已由 onModelCall.attempts 聚合（retryRate），此处只补分布/退避维度
    for (const st of [
      getOrCreate(this.global, idx),
      this.dimBucket('model', modelId, idx),
    ]) {
      bump(st.retriesByStatus, status);
      st.retryBackoff.insert(r.delayMs);
    }
  }

  // ─── 查询入口 ──────────────────────────────────────────────────

  summary(
    filter: SummaryFilter,
    groupBy?: GroupBy,
  ): AggregatedMetrics | Record<string, AggregatedMetrics> {
    this.sweep();
    if (groupBy) {
      // version 过滤仅作用于未分组聚合：model/tool/session 维度桶不按版本细分，
      // 面板模型排行等场景需在 UI 标注"含全部版本"口径
      const dim = this.dims[groupBy];
      const out: Record<string, AggregatedMetrics> = {};
      for (const [key, buckets] of dim) {
        out[key] = this.aggregate(buckets, filter);
      }
      return out;
    }
    const source = filter.version
      ? (this.dims.version.get(filter.version) ?? new Map<number, DimensionStats>())
      : this.global;
    return this.aggregate(source, filter);
  }

  timeseries(
    filter: SummaryFilter,
    stepMs: number,
    metric: TimeseriesMetric,
  ): TimeseriesPoint[] {
    this.sweep();
    const stepIdx = Math.max(1, Math.round(stepMs / this.bucketMs));
    const groups = new Map<number, DimensionStats>();
    const source = filter.version
      ? (this.dims.version.get(filter.version) ?? new Map<number, DimensionStats>())
      : this.global;
    for (const [idx, st] of source) {
      if (!inRange(idx, filter, this.bucketMs)) continue;
      const g = Math.floor(idx / stepIdx);
      const gs = groups.get(g) ?? newStats();
      mergeStats(gs, st);
      groups.set(g, gs);
    }
    const out: TimeseriesPoint[] = [];
    for (const [g, gs] of groups) {
      const v =
        metric === 'requests'
          ? gs.requests
          : metric === 'tokensTotal'
            ? gs.totalTokens
            : gs.requests > 0
              ? gs.success / gs.requests
              : 0;
      out.push({ t: g * stepIdx * this.bucketMs, v: round(v, 8) });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  /** 工具统计（按成功率升序，blocked/skipped 不计入分母）；filter.version 时仅统计该版本 */
  tools(filter: SummaryFilter): ToolStat[] {
    this.sweep();
    const merged = newStats();
    const source = filter.version
      ? (this.dims.version.get(filter.version) ?? new Map<number, DimensionStats>())
      : this.global;
    for (const [idx, st] of source) {
      if (!inRange(idx, filter, this.bucketMs)) continue;
      mergeStats(merged, st);
    }
    const out: ToolStat[] = [];
    for (const [name, t] of merged.tools) {
      const denom = t.ok + t.error;
      out.push({
        tool: name,
        calls: t.calls,
        successRate: denom > 0 ? t.ok / denom : 0,
        avgMs: t.calls > 0 ? round(t.totalMs / t.calls, 2) : 0,
        errors: t.error,
      });
    }
    out.sort((a, b) => a.successRate - b.successRate);
    return out;
  }

  // ─── 内部 ──────────────────────────────────────────────────────

  private nowBucket(now = Date.now()): number {
    return Math.floor(now / this.bucketMs);
  }

  private sweep(now = Date.now()): void {
    const minIdx = this.nowBucket(now) - this.windowBuckets;
    sweepMap(this.global, minIdx);
    for (const name of ['model', 'tool', 'session', 'version'] as const) {
      for (const byKey of this.dims[name].values()) sweepMap(byKey, minIdx);
    }
    // 清理窗口外的 trace 版本映射，避免无限增长
    for (const [traceId, { idx }] of this.traceVersion) {
      if (idx < minIdx) this.traceVersion.delete(traceId);
    }
  }

  private dimBucket(dim: DimName, key: string, idx: number): DimensionStats {
    let byKey = this.dims[dim].get(key);
    if (!byKey) {
      byKey = new Map();
      this.dims[dim].set(key, byKey);
    }
    return getOrCreate(byKey, idx);
  }

  private aggregate(
    buckets: Map<number, DimensionStats>,
    filter: SummaryFilter,
  ): AggregatedMetrics {
    const merged = newStats();
    for (const [idx, st] of buckets) {
      if (!inRange(idx, filter, this.bucketMs)) continue;
      mergeStats(merged, st);
    }
    return toMetrics(merged);
  }
}

// ─── 辅助 ─────────────────────────────────────────────────────────

function recordRun(st: DimensionStats, r: RunRecord): void {
  st.requests += 1;
  // 成功率口径（对齐 observability.md §3）：status='success' 且无任何错误分类。
  // 注：文档写的是 stopReason='completed'，但 buildResult 实际取最后一个
  // assistant 消息的 stopReason（真实 provider 为 'stop'/'end_turn'），
  // 故改用「errorClass 未定义」判定，避免真实数据下成功率恒为 0。
  if (r.status === 'success' && r.errorClass === undefined) st.success += 1;
  st.duration.insert(r.durationMs);
  st.turnsSum += r.turns;
  st.turnsCount += 1;
  if (r.errorClass) bump(st.errorClass, r.errorClass);
}

function mergeStats(target: DimensionStats, src: DimensionStats): void {
  target.requests += src.requests;
  target.success += src.success;
  target.totalTokens += src.totalTokens;
  target.duration.merge(src.duration);
  target.turnsSum += src.turnsSum;
  target.turnsCount += src.turnsCount;
  target.modelCalls += src.modelCalls;
  target.retries += src.retries;
  target.permissionDenied += src.permissionDenied;
  for (const [name, agg] of src.tools) {
    const t = target.tools.get(name) ?? { calls: 0, ok: 0, error: 0, totalMs: 0 };
    t.calls += agg.calls;
    t.ok += agg.ok;
    t.error += agg.error;
    t.totalMs += agg.totalMs;
    target.tools.set(name, t);
  }
  for (const [cls, c] of src.errorClass) bump(target.errorClass, cls, c);
  for (const [status, c] of src.retriesByStatus) bump(target.retriesByStatus, status, c);
  target.retryBackoff.merge(src.retryBackoff);
}

function toMetrics(st: DimensionStats): AggregatedMetrics {
  const backoffP50 = st.retryBackoff.quantile(0.5);
  return {
    requests: st.requests,
    successRate: st.requests > 0 ? st.success / st.requests : 0,
    totalTokens: st.totalTokens,
    p50Ms: st.duration.quantile(0.5),
    p95Ms: st.duration.quantile(0.95),
    p99Ms: st.duration.quantile(0.99),
    avgTurns: st.turnsCount > 0 ? st.turnsSum / st.turnsCount : 0,
    retryRate: st.modelCalls > 0 ? st.retries / st.modelCalls : 0,
    retryByStatus: Object.fromEntries(st.retriesByStatus),
    retryBackoffP50Ms: backoffP50,
    retryBackoffP95Ms: st.retryBackoff.quantile(0.95),
    permissionDenied: st.permissionDenied,
    errorClasses: Object.fromEntries(st.errorClass),
  };
}

function inRange(idx: number, filter: SummaryFilter, bucketMs: number): boolean {
  const start = idx * bucketMs;
  if (filter.since !== undefined && start + bucketMs <= filter.since) return false;
  if (filter.until !== undefined && start >= filter.until) return false;
  return true;
}

function getOrCreate<K>(map: Map<K, DimensionStats>, key: K): DimensionStats {
  let st = map.get(key);
  if (!st) {
    st = newStats();
    map.set(key, st);
  }
  return st;
}

function sweepMap(map: Map<number, DimensionStats>, minIdx: number): void {
  for (const key of map.keys()) {
    if (key < minIdx) map.delete(key);
  }
}

function bump(map: Map<string, number>, key: string, delta = 1): void {
  map.set(key, (map.get(key) ?? 0) + delta);
}

function round(n: number, digits: number): number {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}
