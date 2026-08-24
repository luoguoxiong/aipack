/**
 * HybridAggregator — L1 本地微窗口 + L2 Redis 主窗口（Phase 7）。
 *
 * 目的：降低 Redis QPS，同时保证多实例聚合一致性。
 *
 * 架构：
 * - L1（本地 MemoryAggregator）：1min 微窗口，承担"刚写入"数据的即时查询
 * - L2（RedisAggregator）：60min 主窗口，承担跨实例聚合
 *
 * 写入路径（ingest*）：
 *   - 同步写入 L1（O(1) 内存操作，无 RTT）
 *   - 异步写入 L2（fire-and-forget，失败仅日志告警，不阻塞 ingest）
 *
 * 读取路径（summary/timeseries/tools）：
 *   - 并行查 L1 + L2，合并结果
 *   - L1 提供"最近 1min"的即时数据，L2 提供"60min 内"的全量数据
 *   - 合并：计数器相加，直方图拼接，分位数重算
 *
 * 容错：
 * - L2 不可用：仅返回 L1 数据（最近 1min），降级但不报错
 * - L1 永远可用（纯内存）
 *
 * 适用场景：
 * - 高 QPS collector（单实例 >1k req/s）：L1 吸收写放大，L2 周期性同步
 * - 低延迟查询：L1 命中即返回，无需等 L2
 */

import type {
  RunRecord,
  SpanRecord,
  ToolCallRecord,
  PermissionRecord,
  RetryRecord,
} from '@aipack-ai/observability';
import type {
  AggregatedMetrics,
  GroupBy,
  SummaryFilter,
  TimeseriesMetric,
  TimeseriesPoint,
  ToolStat,
} from '../types';
import type { Aggregator } from './interface';
import { Aggregator as MemoryAggregator } from '../aggregator';
import { RedisAggregator } from './redis-aggregator';

export interface HybridAggregatorOptions {
  /** L1 本地聚合器（必填，由调用方创建并配置微窗口） */
  l1: MemoryAggregator;
  /** L2 Redis 聚合器（必填，由调用方创建并配置主窗口） */
  l2: RedisAggregator;
  /** L1 微窗口长度 ms（默认 60000）。D5 修复：L2 查询窗口据此排除 L1 覆盖区 */
  l1WindowMs?: number;
}

export class HybridAggregator implements Aggregator {
  private l1: MemoryAggregator;
  private l2: RedisAggregator;
  private l1WindowMs: number;

  constructor(opts: HybridAggregatorOptions) {
    this.l1 = opts.l1;
    this.l2 = opts.l2;
    this.l1WindowMs = opts.l1WindowMs ?? 60_000;
  }

  /**
   * D5 修复：写入是 L1/L2 双写（L2 60min 窗口含最近 1min），读取若直接相加
   * 会导致最近 1 分钟指标翻倍。修复为时间分区合并：
   *   L2 查 [since, min(until, now - l1Window))，L1 查原窗口（只含最近 1min 数据）
   * 两区不重叠不遗漏；纯历史查询（until < now - l1Window）时 L2 查全窗口、L1 为空。
   */
  private l2Filter(filter: SummaryFilter): SummaryFilter {
    const l1Boundary = Date.now() - this.l1WindowMs;
    const until = filter.until ?? Number.POSITIVE_INFINITY;
    return until > l1Boundary ? { ...filter, until: l1Boundary } : filter;
  }

  // ─── 写入：L1 同步 + L2 异步（fire-and-forget） ──────────────────

  ingestRun(r: RunRecord): void {
    this.l1.ingestRun(r);
    this.l2.ingestRun(r).catch((err) => {
      console.warn('[HybridAggregator] L2 ingestRun 失败:', err);
    });
  }

  ingestModelCall(s: SpanRecord): void {
    this.l1.ingestModelCall(s);
    this.l2.ingestModelCall(s).catch((err) => {
      console.warn('[HybridAggregator] L2 ingestModelCall 失败:', err);
    });
  }

  ingestToolCall(t: ToolCallRecord): void {
    this.l1.ingestToolCall(t);
    this.l2.ingestToolCall(t).catch((err) => {
      console.warn('[HybridAggregator] L2 ingestToolCall 失败:', err);
    });
  }

  ingestPermission(p: PermissionRecord): void {
    this.l1.ingestPermission(p);
    this.l2.ingestPermission(p).catch((err) => {
      console.warn('[HybridAggregator] L2 ingestPermission 失败:', err);
    });
  }

  ingestRetry(r: RetryRecord): void {
    this.l1.ingestRetry(r);
    this.l2.ingestRetry(r).catch((err) => {
      console.warn('[HybridAggregator] L2 ingestRetry 失败:', err);
    });
  }

  // ─── 读取：L1 + L2 并行查询 + 合并 ───────────────────────────────

  async summary(
    filter: SummaryFilter,
    groupBy?: GroupBy,
  ): Promise<AggregatedMetrics | Record<string, AggregatedMetrics>> {
    // 并行查询 L1 + L2（D5：L2 窗口排除 L1 覆盖的最近 l1Window，避免双计）
    const [l1Res, l2Res] = await Promise.allSettled([
      this.l1.summary(filter, groupBy),
      this.l2.summary(this.l2Filter(filter), groupBy),
    ]);
    const l1Data = l1Res.status === 'fulfilled' ? l1Res.value : undefined;
    const l2Data = l2Res.status === 'fulfilled' ? l2Res.value : undefined;
    if (!l1Data && !l2Data) {
      // 两个都失败，返回空 metrics
      return groupBy ? {} : emptyMetrics();
    }
    if (groupBy) {
      // 分组场景：合并两个 Record
      const l1Record = (l1Data as Record<string, AggregatedMetrics>) ?? {};
      const l2Record = (l2Data as Record<string, AggregatedMetrics>) ?? {};
      const allKeys = new Set([...Object.keys(l1Record), ...Object.keys(l2Record)]);
      const out: Record<string, AggregatedMetrics> = {};
      for (const key of allKeys) {
        out[key] = mergeMetrics(l1Record[key], l2Record[key]);
      }
      return out;
    }
    return mergeMetrics(
      l1Data as AggregatedMetrics | undefined,
      l2Data as AggregatedMetrics | undefined,
    );
  }

  async timeseries(
    filter: SummaryFilter,
    stepMs: number,
    metric: TimeseriesMetric,
  ): Promise<TimeseriesPoint[]> {
    // D5：L2 窗口排除 L1 覆盖区（同 summary）；successRate 额外取 requests 序列做加权
    const l2F = this.l2Filter(filter);
    const [l1Res, l2Res] = await Promise.allSettled([
      this.l1.timeseries(filter, stepMs, metric),
      this.l2.timeseries(l2F, stepMs, metric),
    ]);
    const l1Points = l1Res.status === 'fulfilled' ? l1Res.value : [];
    const l2Points = l2Res.status === 'fulfilled' ? l2Res.value : [];

    if (metric === 'successRate') {
      // D5 修复：简单平均会稀释高低流量时段（如 L1 10 条全成功 + L2 1000 条 50%
      // 平均得 75%，实际应为 ~50%）。改为按各源 requests 加权。
      const [l1ReqRes, l2ReqRes] = await Promise.allSettled([
        this.l1.timeseries(filter, stepMs, 'requests'),
        this.l2.timeseries(l2F, stepMs, 'requests'),
      ]);
      const reqByT = new Map<number, { a: number; b: number }>();
      for (const p of l1ReqRes.status === 'fulfilled' ? l1ReqRes.value : []) {
        const e = reqByT.get(p.t) ?? { a: 0, b: 0 };
        e.a += p.v;
        reqByT.set(p.t, e);
      }
      for (const p of l2ReqRes.status === 'fulfilled' ? l2ReqRes.value : []) {
        const e = reqByT.get(p.t) ?? { a: 0, b: 0 };
        e.b += p.v;
        reqByT.set(p.t, e);
      }
      const byT = new Map<number, { sum: number; w: number }>();
      for (const [src, points] of [['a', l1Points], ['b', l2Points]] as const) {
        for (const p of points) {
          const w = reqByT.get(p.t)?.[src] ?? 0;
          const e = byT.get(p.t) ?? { sum: 0, w: 0 };
          e.sum += p.v * w;
          e.w += w;
          byT.set(p.t, e);
        }
      }
      const out: TimeseriesPoint[] = [];
      for (const [t, { sum, w }] of byT) {
        out.push({ t, v: w > 0 ? sum / w : 0 });
      }
      out.sort((a, b) => a.t - b.t);
      return out;
    }

    // 计数型指标：分区后同 t 桶至多一个源有值（边界桶例外），直接求和
    const byT = new Map<number, { sum: number; count: number }>();
    for (const p of [...l1Points, ...l2Points]) {
      const existing = byT.get(p.t) ?? { sum: 0, count: 0 };
      existing.sum += p.v;
      existing.count += 1;
      byT.set(p.t, existing);
    }
    const out: TimeseriesPoint[] = [];
    for (const [t, { sum }] of byT) {
      out.push({ t, v: sum });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  async tools(filter: SummaryFilter): Promise<ToolStat[]> {
    // D5：L2 窗口排除 L1 覆盖区
    const [l1Res, l2Res] = await Promise.allSettled([
      this.l1.tools(filter),
      this.l2.tools(this.l2Filter(filter)),
    ]);
    const l1Tools = l1Res.status === 'fulfilled' ? l1Res.value : [];
    const l2Tools = l2Res.status === 'fulfilled' ? l2Res.value : [];
    const merged = new Map<string, { calls: number; ok: number; error: number; totalMs: number }>();
    for (const t of [...l1Tools, ...l2Tools]) {
      const agg = merged.get(t.tool) ?? { calls: 0, ok: 0, error: 0, totalMs: 0 };
      agg.calls += t.calls;
      agg.ok += Math.round(t.calls * t.successRate);
      agg.error += t.errors;
      agg.totalMs += t.calls * t.avgMs;
      merged.set(t.tool, agg);
    }
    const out: ToolStat[] = [];
    for (const [name, t] of merged) {
      const denom = t.ok + t.error;
      out.push({
        tool: name,
        calls: t.calls,
        successRate: denom > 0 ? t.ok / denom : 0,
        avgMs: t.calls > 0 ? Math.round((t.totalMs / t.calls) * 100) / 100 : 0,
        errors: t.error,
      });
    }
    out.sort((a, b) => a.successRate - b.successRate);
    return out;
  }

  // ─── 生命周期 ────────────────────────────────────────────────────

  sweep(): void {
    this.l1.sweep();
    // L2 sweep 由 RedisAggregator 内部惰性触发
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.l1.close(), this.l2.close()]);
  }
}

// ─── 合并工具 ─────────────────────────────────────────────────────

function emptyMetrics(): AggregatedMetrics {
  return {
    requests: 0,
    successRate: 0,
    totalTokens: 0,
    p50Ms: 0,
    p95Ms: 0,
    p99Ms: 0,
    avgTurns: 0,
    retryRate: 0,
    retryByStatus: {},
    retryBackoffP50Ms: 0,
    retryBackoffP95Ms: 0,
    permissionDenied: 0,
    errorClasses: {},
  };
}

/** 合并两个 AggregatedMetrics（计数器相加，比率按 requests 加权） */
function mergeMetrics(a?: AggregatedMetrics, b?: AggregatedMetrics): AggregatedMetrics {
  if (!a) return b ?? emptyMetrics();
  if (!b) return a;
  const totalReq = a.requests + b.requests;
  const totalModelCalls = (a.requests + b.requests); // 近似：retryRate 分母用 requests
  const mergedErrorClasses: Record<string, number> = { ...a.errorClasses };
  for (const [k, v] of Object.entries(b.errorClasses)) {
    mergedErrorClasses[k] = (mergedErrorClasses[k] ?? 0) + v;
  }
  const mergedRetryByStatus: Record<string, number> = { ...a.retryByStatus };
  for (const [k, v] of Object.entries(b.retryByStatus)) {
    mergedRetryByStatus[k] = (mergedRetryByStatus[k] ?? 0) + v;
  }
  // 分位数取较大者（保守估计，避免乐观低估延迟）
  return {
    requests: totalReq,
    successRate: totalReq > 0
      ? (a.successRate * a.requests + b.successRate * b.requests) / totalReq
      : 0,
    totalTokens: a.totalTokens + b.totalTokens,
    p50Ms: Math.max(a.p50Ms, b.p50Ms),
    p95Ms: Math.max(a.p95Ms, b.p95Ms),
    p99Ms: Math.max(a.p99Ms, b.p99Ms),
    avgTurns: totalReq > 0
      ? (a.avgTurns * a.requests + b.avgTurns * b.requests) / totalReq
      : 0,
    retryRate: totalModelCalls > 0
      ? (a.retryRate * a.requests + b.retryRate * b.requests) / totalModelCalls
      : 0,
    retryByStatus: mergedRetryByStatus,
    retryBackoffP50Ms: Math.max(a.retryBackoffP50Ms, b.retryBackoffP50Ms),
    retryBackoffP95Ms: Math.max(a.retryBackoffP95Ms, b.retryBackoffP95Ms),
    permissionDenied: a.permissionDenied + b.permissionDenied,
    errorClasses: mergedErrorClasses,
  };
}
