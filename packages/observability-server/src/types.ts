/**
 * 收集服务聚合类型（@aipack-ai/observability-server）。
 * 记录类型（RunRecord/SpanRecord/ToolCallRecord/PermissionRecord/EventBatch）
 * 定义在 @aipack-ai/observability（上报 SDK），本包依赖其做落盘与聚合。
 */

/** 聚合查询的时间过滤（epoch ms）；version 精确匹配发布版本（缺省不过滤） */
export interface SummaryFilter {
  since?: number;
  until?: number;
  version?: string;
}

/** /metrics/summary 聚合结果（口径对齐 observability.md §3） */
export interface AggregatedMetrics {
  /** 请求量（run 计数，含 stream） */
  requests: number;
  /** status='success' 且无 errorClass 占比 */
  successRate: number;
  /** token 总消耗量（模型 span 累计，input+output+cacheRead+cacheWrite） */
  totalTokens: number;
  /** 端到端耗时分位数（run 级 durationMs 直方图） */
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  /** 平均 step 长度 */
  avgTurns: number;
  /** 重试率 = Σ(attempts-1) / 模型调用数 */
  retryRate: number;
  /** P2-2 per-attempt 重试分布：HTTP 状态码（如 '429'/'502'，无状态码记 'unknown'）-> 次数 */
  retryByStatus: Record<string, number>;
  /** P2-2 重试退避时长分位（ms，0 表示无重试数据） */
  retryBackoffP50Ms: number;
  retryBackoffP95Ms: number;
  /** 权限拦截次数 */
  permissionDenied: number;
  /** 错误分类计数（errorClass -> 次数），供面板错误分析 */
  errorClasses: Record<string, number>;
  /** Phase 6 — Cost：窗口内总成本（分）；memory 聚合器累计 model span 的 costCents */
  costTotal?: number;
}

export type GroupBy = 'model' | 'tool' | 'session';

export type TimeseriesMetric = 'requests' | 'successRate' | 'tokensTotal' | 'cost';

export interface TimeseriesPoint {
  /** 桶起始时间（epoch ms） */
  t: number;
  v: number;
}

/** /metrics/tools 单工具统计 */
export interface ToolStat {
  tool: string;
  calls: number;
  /** ok / (ok + error)，blocked/skipped 不计入分母 */
  successRate: number;
  avgMs: number;
  errors: number;
}

/** /metrics/versions 单版本单工具统计（口径对齐 ToolStat，keyed by tool name） */
export interface VersionToolStat {
  calls: number;
  /** ok / (ok + error)，blocked/skipped 不计入分母 */
  successRate: number;
  avgMs: number;
  errors: number;
}

/** /metrics/versions 单版本聚合（SQLite 直查，非内存窗口；口径对齐 AggregatedMetrics） */
export interface VersionMetrics {
  version: string;
  /** 最近一次该版本上报时间（epoch ms，供面板按"最近版本"排序） */
  lastSeenAt: number;
  requests: number;
  successRate: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  totalTokens: number;
  avgTurns: number;
  retryRate: number;
  errorClasses: Record<string, number>;
  /** 工具名 -> 统计（keyed by tool name 便于面板 diff） */
  tools: Record<string, VersionToolStat>;
}
