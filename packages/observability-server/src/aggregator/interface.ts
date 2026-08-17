/**
 * Aggregator 接口抽象（Phase 7）。
 *
 * 目的：将"内存聚合"与"Redis 共享聚合"解耦，collector 与 worker 无状态化。
 *
 * 实现：
 * - `MemoryAggregator`（原 src/aggregator.ts）：进程内 Map，单实例可用
 * - `RedisAggregator`：滑动窗口 + 直方图用 Redis Hash + ZSET，多实例共享
 * - `HybridAggregator`：本地 L1（1min 微窗口）+ Redis L2（60min 主窗口），降低 Redis QPS
 *
 * 注：ingest* 方法在 MemoryAggregator 中同步、在 Redis/Hybrid 中异步。
 *      为统一接口，全部声明为 `Promise<void>`，Memory 实现返回已 resolved Promise。
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

/**
 * Aggregator 接口。
 *
 * 写入端（ingest*）：collector / worker 收到 EventBatch 后调用
 * 读取端（summary / timeseries / tools）：API 查询 + Prometheus 导出
 */
export interface Aggregator {
  // ─── 写入 ───────────────────────────────────────────────────────
  /** Run 完成（success/error/validation） */
  ingestRun(r: RunRecord): Promise<void> | void;
  /** 模型 span（kind='model'），累计 token / retries / latency */
  ingestModelCall(s: SpanRecord): Promise<void> | void;
  /** 工具调用 */
  ingestToolCall(t: ToolCallRecord): Promise<void> | void;
  /** 权限决策（allow/deny） */
  ingestPermission(p: PermissionRecord): Promise<void> | void;
  /** 模型重试 */
  ingestRetry(r: RetryRecord): Promise<void> | void;

  // ─── 读取 ───────────────────────────────────────────────────────
  /** 聚合摘要（支持 groupBy 维度细分） */
  summary(filter: SummaryFilter, groupBy?: GroupBy): Promise<AggregatedMetrics | Record<string, AggregatedMetrics>>;
  /** 时间序列（按 stepMs 分桶） */
  timeseries(filter: SummaryFilter, stepMs: number, metric: TimeseriesMetric): Promise<TimeseriesPoint[]>;
  /** 工具成功率统计（按成功率升序） */
  tools(filter: SummaryFilter): Promise<ToolStat[]>;

  // ─── 生命周期 ────────────────────────────────────────────────────
  /** 清理过期桶（Memory 实现惰性清理；Redis 实现可选 no-op，靠 TTL） */
  sweep(): void;
  /** 关闭（释放连接 / 清理定时器） */
  close(): Promise<void>;
}

/** Aggregator 工厂签名：collector / worker 通过此函数按 appId 获取实例 */
export type AggregatorFactory = (appId?: string) => Aggregator;

/** Aggregator 配置（工厂函数用） */
export interface AggregatorConfig {
  /** 滑动窗口（ms），默认 60min */
  windowMs?: number;
  /** 时间桶粒度（ms），默认 1min */
  bucketMs?: number;
}
