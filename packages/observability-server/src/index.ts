/**
 * @aipack/observability-server — aipack 可观测性收集服务。
 *
 * 接收各应用 SDK（@aipack/observability）的埋点上报，统一完成：
 *   - SQLite 落盘（runs / spans / tool_calls，事务批量）
 *   - 内存聚合（滑动窗口 + 在线直方图，p50/p95/p99）
 *   - REST 查询 API（/metrics/*、/traces/*）
 * 上报鉴权：appId + appSecret（OBS_APPS 白名单）。
 *
 * 部署：pnpm --filter @aipack/observability-server dev
 * 或：bin `observability-server`（需先 build）。
 */

export { createCollector } from './collector';
export type { Collector, CollectorOptions } from './collector';
export { Aggregator } from './aggregator';
export type { AggregatorOptions } from './aggregator';
export { SQLiteStore } from './store';
export type {
  AppRecord,
  AppStore,
  RunQueryFilter,
  RunListItem,
  TraceDetail,
  TraceStore,
} from './store';
export { createApiHandler } from './server';
export type { ApiHandler, ApiDeps } from './server';
export { createAdminHandler } from './admin';
export type { AdminDeps, AdminHandler } from './admin';
export { SessionManager, readBearerToken } from './auth';
export type { AdminCredentials } from './auth';
export type {
  AggregatedMetrics,
  GroupBy,
  SummaryFilter,
  TimeseriesMetric,
  TimeseriesPoint,
  ToolStat,
} from './types';
