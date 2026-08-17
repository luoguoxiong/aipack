/**
 * RedisAggregator — 基于 Redis Hash + ZSET 的分布式聚合器（Phase 7）。
 *
 * 设计：
 * - 时间桶用 ZSET 索引（member=bucketIdx, score=bucketIdx），便于按范围清理/查询
 * - 每个桶一个 Hash，存计数器（requests/success/tokens/turns/...）
 * - 直方图用 Sorted Set 存储延迟采样（p50/p95/p99），按 score=latencyMs 排序
 *   读取时用 ZRANGE + 索引计算分位数（简化版；高精度可用 t-digest Lua 脚本）
 * - 维度（model/tool/session/version）：key 中带维度名+维度值
 *
 * 写入路径（ingest*）：
 *   pipeline 批量 HINCRBY + ZADD + EXPIRE → 单次 RTT 完成所有计数
 *   直方图用 ZADD 加采样（限制每桶 1000 个采样点，超限丢弃避免膨胀）
 *
 * 读取路径（summary/timeseries/tools）：
 *   1. ZRANGEBYSCORE 取窗口内所有桶 idx
 *   2. 逐桶 HGETALL 取计数器，累加
 *   3. 直方图合并各桶采样（ZUNIONSTORE 或客户端合并）
 *
 * 一致性：
 * - 计数器用 HINCRBY 原子累加（多 collector 并发安全）
 * - 直方图 ZADD 原子（但采样上限靠 LLEN 检查，非严格原子；可接受近似）
 * - TTL 兜底：每桶 Hash 设 TTL=windowMs*2，避免 ZSET 清理失败导致僵尸桶
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
import { RedisClient } from './redis-client';

export interface RedisAggregatorOptions {
  /** Redis 客户端（必填） */
  redis: RedisClient;
  /** 应用 ID（全局聚合用 'global'） */
  appId?: string;
  /** 滑动窗口（ms），默认 60min */
  windowMs?: number;
  /** 时间桶粒度（ms），默认 1min */
  bucketMs?: number;
  /** 直方图每桶最大采样数（默认 1000，超限丢弃） */
  maxHistogramSamples?: number;
}

type DimName = 'model' | 'tool' | 'session' | 'version';

interface BucketCounters {
  requests: number;
  success: number;
  error: number;
  totalTokens: number;
  totalTurns: number;
  modelCalls: number;
  retries: number;
  permissionDenied: number;
  // errorClass -> count（Hash 内字段前缀 e:）
  // retryByStatus -> count（Hash 内字段前缀 rs:）
  // tools -> { calls, ok, error, totalMs }（Hash 内字段前缀 t:<name>:）
}

export class RedisAggregator implements Aggregator {
  private redis: RedisClient;
  private appId: string;
  private bucketMs: number;
  private windowBuckets: number;
  private maxHistogramSamples: number;
  private lastSweep = 0;

  constructor(opts: RedisAggregatorOptions) {
    this.redis = opts.redis;
    this.appId = opts.appId ?? 'global';
    this.bucketMs = opts.bucketMs ?? 60 * 1000;
    this.windowBuckets = Math.max(
      1,
      Math.ceil((opts.windowMs ?? 60 * 60 * 1000) / this.bucketMs),
    );
    this.maxHistogramSamples = opts.maxHistogramSamples ?? 1000;
  }

  // ─── Key 设计 ────────────────────────────────────────────────────

  /** ZSET 索引 key（member=bucketIdx, score=bucketIdx） */
  private zsetKey(dim: string, dimKey: string): string {
    return `${this.appId}:${dim}:${dimKey}:buckets`;
  }

  /** 桶 Hash key（存计数器） */
  private bucketKey(dim: string, dimKey: string, idx: number): string {
    return `${this.appId}:${dim}:${dimKey}:b:${idx}`;
  }

  /** 直方图 ZSET key（member=sampleId, score=latencyMs） */
  private histKey(dim: string, dimKey: string, idx: number, name: string): string {
    return `${this.appId}:${dim}:${dimKey}:h:${name}:${idx}`;
  }

  /** trace→version 映射 Hash key */
  private traceVerKey(): string {
    return `${this.appId}:tracever`;
  }

  private nowBucket(now = Date.now()): number {
    return Math.floor(now / this.bucketMs);
  }

  // ─── 写入（pipeline 批量提交） ───────────────────────────────────

  async ingestRun(r: RunRecord): Promise<void> {
    await this.sweepAsync();
    const idx = this.nowBucket();
    const model = r.model ?? 'unknown';
    const version = r.appVersion ?? 'unknown';
    const isOk = r.status === 'success';
    const tokens = (r.inputTokens ?? 0) + (r.outputTokens ?? 0) + (r.cacheRead ?? 0) + (r.cacheWrite ?? 0);

    const p = this.redis.pipeline();
    // 记录 trace 版本映射
    p.hset(this.traceVerKey(), r.traceId, version);
    // 全局 + model + session + version 四个维度
    this.incrBucket(p, 'global', '', idx, (kp) => {
      p.hincrby(kp, 'requests', 1);
      if (isOk) p.hincrby(kp, 'success', 1);
      else p.hincrby(kp, 'error', 1);
      p.hincrby(kp, 'totalTokens', tokens);
      p.hincrby(kp, 'totalTurns', r.turns ?? 0);
      if (r.errorClass) p.hincrby(kp, `e:${r.errorClass}`, 1);
      // 直方图：用 traceId+spanSeq 作为唯一 member（避免去重丢失采样）
      p.zadd(this.histKey('global', '', idx, 'latency'), r.durationMs, `${r.traceId}:run`);
    });
    this.incrBucket(p, 'model', model, idx, (kp) => {
      p.hincrby(kp, 'requests', 1);
      if (isOk) p.hincrby(kp, 'success', 1);
      p.hincrby(kp, 'totalTokens', tokens);
      p.hincrby(kp, 'totalTurns', r.turns ?? 0);
      p.zadd(this.histKey('model', model, idx, 'latency'), r.durationMs, `${r.traceId}:run`);
    });
    if (r.sessionKey) {
      this.incrBucket(p, 'session', r.sessionKey, idx, (kp) => {
        p.hincrby(kp, 'requests', 1);
        if (isOk) p.hincrby(kp, 'success', 1);
      });
    }
    this.incrBucket(p, 'version', version, idx, (kp) => {
      p.hincrby(kp, 'requests', 1);
      if (isOk) p.hincrby(kp, 'success', 1);
      p.hincrby(kp, 'totalTokens', tokens);
    });
    await this.redis.execPipeline(p);
  }

  async ingestModelCall(s: SpanRecord): Promise<void> {
    if (s.kind !== 'model') return;
    await this.sweepAsync();
    const idx = this.nowBucket();
    const modelId = s.name.replace(/^model:/, '');
    const retries = Math.max(0, (s.attempts ?? 1) - 1);
    const tokens = (s.inputTokens ?? 0) + (s.outputTokens ?? 0) + (s.cacheRead ?? 0) + (s.cacheWrite ?? 0);
    const version = (await this.redis.hget(this.traceVerKey(), s.traceId)) ?? 'unknown';

    const p = this.redis.pipeline();
    for (const [dim, key] of [
      ['global', ''],
      ['model', modelId],
      ['session', s.sessionKey ?? 'unknown'],
      ['version', version],
    ] as const) {
      this.incrBucket(p, dim, key, idx, (kp) => {
        p.hincrby(kp, 'modelCalls', 1);
        p.hincrby(kp, 'retries', retries);
        p.hincrby(kp, 'totalTokens', tokens);
        if (s.errorClass) p.hincrby(kp, `e:${s.errorClass}`, 1);
        p.zadd(this.histKey(dim, key, idx, 'latency'), s.durationMs, `${s.traceId}:${s.spanId}`);
      });
    }
    await this.redis.execPipeline(p);
  }

  async ingestToolCall(t: ToolCallRecord): Promise<void> {
    await this.sweepAsync();
    const idx = this.nowBucket();
    const isOk = t.status === 'ok';
    const isErr = t.status === 'error';
    const version = (await this.redis.hget(this.traceVerKey(), t.traceId)) ?? 'unknown';

    const p = this.redis.pipeline();
    for (const [dim, key] of [
      ['global', ''],
      ['tool', t.toolName],
      ['version', version],
    ] as const) {
      this.incrBucket(p, dim, key, idx, (kp) => {
        if (isOk || isErr) {
          p.hincrby(kp, 'requests', 1);
          p.zadd(this.histKey(dim, key, idx, 'latency'), t.durationMs, `${t.traceId}:${t.toolName}:${idx}`);
        }
        if (isOk) p.hincrby(kp, `t:${t.toolName}:ok`, 1);
        if (isErr) p.hincrby(kp, `t:${t.toolName}:error`, 1);
        if (isOk || isErr) p.hincrby(kp, `t:${t.toolName}:calls`, 1);
        if (isOk || isErr) p.hincrbyfloat(kp, `t:${t.toolName}:totalMs`, t.durationMs);
      });
    }
    await this.redis.execPipeline(p);
  }

  async ingestPermission(_p: PermissionRecord): Promise<void> {
    await this.sweepAsync();
    const idx = this.nowBucket();
    const p = this.redis.pipeline();
    this.incrBucket(p, 'global', '', idx, (kp) => {
      p.hincrby(kp, 'permissionDenied', 1);
    });
    await this.redis.execPipeline(p);
  }

  async ingestRetry(r: RetryRecord): Promise<void> {
    await this.sweepAsync();
    const idx = this.nowBucket();
    const status = r.status !== undefined ? String(r.status) : 'unknown';
    const modelId = r.modelId || 'unknown';
    const p = this.redis.pipeline();
    for (const [dim, key] of [
      ['global', ''],
      ['model', modelId],
    ] as const) {
      this.incrBucket(p, dim, key, idx, (kp) => {
        p.hincrby(kp, `rs:${status}`, 1);
        p.zadd(this.histKey(dim, key, idx, 'backoff'), r.delayMs, `${r.traceId}:${idx}:${Math.random()}`);
      });
    }
    await this.redis.execPipeline(p);
  }

  /** 通用桶增量：ZADD 索引 + EXPIRE + 回调填充 HINCRBY */
  private incrBucket(
    p: ReturnType<RedisClient['pipeline']>,
    dim: string,
    dimKey: string,
    idx: number,
    fill: (bucketKey: string) => void,
  ): void {
    const zset = this.zsetKey(dim, dimKey);
    const bucket = this.bucketKey(dim, dimKey, idx);
    p.zadd(zset, idx, String(idx));
    p.expire(zset, Math.ceil((this.windowBuckets * this.bucketMs) / 1000) * 2);
    p.expire(bucket, Math.ceil((this.windowBuckets * this.bucketMs) / 1000) * 2);
    fill(bucket);
  }

  // ─── 读取 ────────────────────────────────────────────────────────

  async summary(
    filter: SummaryFilter,
    groupBy?: GroupBy,
  ): Promise<AggregatedMetrics | Record<string, AggregatedMetrics>> {
    await this.sweepAsync();
    if (groupBy) {
      // 遍历该维度所有 key（用 SCAN，简化版：假设 key 数量可控）
      const dimKeys = await this.scanDimKeys(groupBy);
      const out: Record<string, AggregatedMetrics> = {};
      for (const key of dimKeys) {
        out[key] = await this.aggregateDim(groupBy, key, filter);
      }
      return out;
    }
    const source = filter.version
      ? { dim: 'version' as const, key: filter.version }
      : { dim: 'global' as const, key: '' };
    return this.aggregateDim(source.dim, source.key, filter);
  }

  async timeseries(
    filter: SummaryFilter,
    stepMs: number,
    metric: TimeseriesMetric,
  ): Promise<TimeseriesPoint[]> {
    await this.sweepAsync();
    const source = filter.version
      ? { dim: 'version' as const, key: filter.version }
      : { dim: 'global' as const, key: '' };
    const stepIdx = Math.max(1, Math.round(stepMs / this.bucketMs));
    const bucketIdxs = await this.windowBucketsList(source.dim, source.key, filter);
    const groups = new Map<number, { requests: number; success: number; totalTokens: number }>();
    for (const idxStr of bucketIdxs) {
      const idx = Number(idxStr);
      if (!inRange(idx, filter, this.bucketMs)) continue;
      const g = Math.floor(idx / stepIdx);
      const counters = await this.readBucketCounters(source.dim, source.key, idx);
      const gs = groups.get(g) ?? { requests: 0, success: 0, totalTokens: 0 };
      gs.requests += counters.requests;
      gs.success += counters.success;
      gs.totalTokens += counters.totalTokens;
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
      out.push({ t: g * stepIdx * this.bucketMs, v: Math.round(v * 1e8) / 1e8 });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  async tools(filter: SummaryFilter): Promise<ToolStat[]> {
    await this.sweepAsync();
    const source = filter.version
      ? { dim: 'version' as const, key: filter.version }
      : { dim: 'global' as const, key: '' };
    const bucketIdxs = await this.windowBucketsList(source.dim, source.key, filter);
    const merged = new Map<string, { calls: number; ok: number; error: number; totalMs: number }>();
    for (const idxStr of bucketIdxs) {
      const idx = Number(idxStr);
      if (!inRange(idx, filter, this.bucketMs)) continue;
      const raw = await this.redis.hgetall(this.bucketKey(source.dim, source.key, idx));
      for (const [field, val] of Object.entries(raw)) {
        if (!field.startsWith('t:')) continue;
        const parts = field.split(':');
        if (parts.length !== 3) continue;
        const [, toolName, metric] = parts;
        const n = Number(val);
        const agg = merged.get(toolName) ?? { calls: 0, ok: 0, error: 0, totalMs: 0 };
        if (metric === 'calls') agg.calls += n;
        else if (metric === 'ok') agg.ok += n;
        else if (metric === 'error') agg.error += n;
        else if (metric === 'totalMs') agg.totalMs += n;
        merged.set(toolName, agg);
      }
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

  // ─── 内部辅助 ────────────────────────────────────────────────────

  /** 读取单个桶的所有计数器（HGETALL → 解析） */
  private async readBucketCounters(dim: string, key: string, idx: number): Promise<BucketCounters> {
    const raw = await this.redis.hgetall(this.bucketKey(dim, key, idx));
    return {
      requests: Number(raw.requests ?? 0),
      success: Number(raw.success ?? 0),
      error: Number(raw.error ?? 0),
      totalTokens: Number(raw.totalTokens ?? 0),
      totalTurns: Number(raw.totalTurns ?? 0),
      modelCalls: Number(raw.modelCalls ?? 0),
      retries: Number(raw.retries ?? 0),
      permissionDenied: Number(raw.permissionDenied ?? 0),
    };
  }

  /** 聚合单个维度的窗口数据 */
  private async aggregateDim(dim: string, key: string, filter: SummaryFilter): Promise<AggregatedMetrics> {
    const bucketIdxs = await this.windowBucketsList(dim, key, filter);
    const merged: BucketCounters = {
      requests: 0, success: 0, error: 0, totalTokens: 0, totalTurns: 0,
      modelCalls: 0, retries: 0, permissionDenied: 0,
    };
    const errorClasses: Record<string, number> = {};
    const retryByStatus: Record<string, number> = {};
    const latencySamples: number[] = [];
    const backoffSamples: number[] = [];

    for (const idxStr of bucketIdxs) {
      const idx = Number(idxStr);
      if (!inRange(idx, filter, this.bucketMs)) continue;
      const raw = await this.redis.hgetall(this.bucketKey(dim, key, idx));
      merged.requests += Number(raw.requests ?? 0);
      merged.success += Number(raw.success ?? 0);
      merged.error += Number(raw.error ?? 0);
      merged.totalTokens += Number(raw.totalTokens ?? 0);
      merged.totalTurns += Number(raw.totalTurns ?? 0);
      merged.modelCalls += Number(raw.modelCalls ?? 0);
      merged.retries += Number(raw.retries ?? 0);
      merged.permissionDenied += Number(raw.permissionDenied ?? 0);
      for (const [field, val] of Object.entries(raw)) {
        if (field.startsWith('e:')) {
          const cls = field.slice(2);
          errorClasses[cls] = (errorClasses[cls] ?? 0) + Number(val);
        } else if (field.startsWith('rs:')) {
          const status = field.slice(3);
          retryByStatus[status] = (retryByStatus[status] ?? 0) + Number(val);
        }
      }
      // 直方图采样（限制采样数避免内存膨胀）
      const latencyVals = await this.redis.zrangebyscore(this.histKey(dim, key, idx, 'latency'), 0, '+inf');
      latencySamples.push(...latencyVals.map(Number));
      const backoffVals = await this.redis.zrangebyscore(this.histKey(dim, key, idx, 'backoff'), 0, '+inf');
      backoffSamples.push(...backoffVals.map(Number));
    }

    latencySamples.sort((a, b) => a - b);
    backoffSamples.sort((a, b) => a - b);
    const successRate = merged.requests > 0 ? merged.success / merged.requests : 0;
    const avgTurns = merged.requests > 0 ? merged.totalTurns / merged.requests : 0;
    const retryRate = merged.modelCalls > 0 ? merged.retries / merged.modelCalls : 0;

    return {
      requests: merged.requests,
      successRate: Math.round(successRate * 1e8) / 1e8,
      totalTokens: merged.totalTokens,
      p50Ms: percentile(latencySamples, 0.5),
      p95Ms: percentile(latencySamples, 0.95),
      p99Ms: percentile(latencySamples, 0.99),
      avgTurns: Math.round(avgTurns * 100) / 100,
      retryRate: Math.round(retryRate * 1e8) / 1e8,
      retryByStatus,
      retryBackoffP50Ms: percentile(backoffSamples, 0.5),
      retryBackoffP95Ms: percentile(backoffSamples, 0.95),
      permissionDenied: merged.permissionDenied,
      errorClasses,
    };
  }

  /** 取窗口内所有桶 idx（ZRANGEBYSCORE） */
  private async windowBucketsList(dim: string, key: string, filter: SummaryFilter): Promise<string[]> {
    const now = Date.now();
    const maxIdx = filter.until ? Math.floor(filter.until / this.bucketMs) : this.nowBucket(now);
    const minIdx = filter.since ? Math.floor(filter.since / this.bucketMs) : this.nowBucket(now) - this.windowBuckets;
    return this.redis.zrangebyscore(this.zsetKey(dim, key), minIdx, maxIdx);
  }

  /** SCAN 某维度的所有 key（简化：用 KEYS，生产应换 SCAN） */
  private async scanDimKeys(dim: DimName): Promise<string[]> {
    // 简化实现：用 KEYS 模式匹配；高 QPS 场景应维护维度索引 Set
    const pattern = this.redis.prefix + `${this.appId}:${dim}:*:buckets`;
    const keys = await this.redis.raw.keys(pattern);
    const dimKeys: string[] = [];
    for (const fullKey of keys) {
      // 解析 key：aipack:agg:{appId}:{dim}:{dimKey}:buckets
      const stripped = fullKey.startsWith(this.redis.prefix) ? fullKey.slice(this.redis.prefix.length) : fullKey;
      const parts = stripped.split(':');
      // [appId, dim, dimKey..., 'buckets']
      if (parts.length >= 4 && parts[1] === dim) {
        dimKeys.push(parts.slice(2, -1).join(':'));
      }
    }
    return dimKeys;
  }

  // ─── 清理 / 生命周期 ─────────────────────────────────────────────

  /** 公共 sweep（同步签名，内部异步） */
  sweep(): void {
    void this.sweepAsync();
  }

  /** 异步清理：每 5min 一次 ZREMRANGEBYSCORE（避免每次 ingest 都清理） */
  private async sweepAsync(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweep < 5 * 60 * 1000) return;
    this.lastSweep = now;
    const minIdx = this.nowBucket(now) - this.windowBuckets;
    // 仅清理 global + version 维度（其他维度靠 TTL 兜底）
    const dims: Array<[string, string]> = [['global', '']];
    for (const [dim, key] of dims) {
      await this.redis.zremrangebyscore(this.zsetKey(dim, key), 0, minIdx);
    }
  }

  async close(): Promise<void> {
    // Redis 连接由外部管理（多个 aggregator 共用一个 RedisClient）
    // 此处 no-op；如需独立连接，由调用方 close RedisClient
  }
}

// ─── 工具函数 ─────────────────────────────────────────────────────

function inRange(idx: number, filter: SummaryFilter, bucketMs: number): boolean {
  const t = idx * bucketMs;
  if (filter.since !== undefined && t < filter.since - bucketMs) return false;
  if (filter.until !== undefined && t > filter.until) return false;
  return true;
}

/** 计算分位数（已排序数组） */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return Math.round(sorted[idx] * 100) / 100;
}
