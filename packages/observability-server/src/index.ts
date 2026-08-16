/**
 * @aipack-ai/observability-server — aipack 可观测性收集服务。
 *
 * 接收各应用 SDK（@aipack-ai/observability）的埋点上报，统一完成：
 *   - SQLite 落盘（runs / spans / tool_calls，事务批量）
 *   - 内存聚合（滑动窗口 + 在线直方图，p50/p95/p99）
 *   - REST 查询 API（/metrics/*、/traces/*）
 * 上报鉴权：appId + appSecret（OBS_APPS 白名单）。
 *
 * 部署：pnpm --filter @aipack-ai/observability-server dev
 * 或：bin `observability-server`（需先 build）。
 */

export { createCollector, createCollectorServer } from './collector';
export type { Collector, CollectorOptions, RetentionOptions, AlertOptions, TlsOptions } from './collector';
export { Aggregator } from './aggregator';
export type { AggregatorOptions } from './aggregator';
export { SQLiteStore } from './store';
export type {
  AppRecord,
  AppStore,
  AlertRuleRow,
  AlertEventRow,
  AlertStore,
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
export { createAlertEvaluator } from './alerts/evaluator';
export type { AlertEvaluator, EvaluatorDeps } from './alerts/evaluator';
export { createNotifier } from './alerts/notify';
export type { Notifier, NotifierOptions, AlertNotification } from './alerts/notify';
export {
  ALERT_METRICS,
  ALERT_OPERATORS,
  validateRule,
  compare,
  ALERT_METRIC_LABELS,
  ALERT_OPERATOR_LABELS,
  DEFAULT_LOOKBACK_MS,
  DEFAULT_COOLDOWN_MS,
} from './alerts/rules';
export type {
  AlertMetric,
  AlertOperator,
  AlertRule,
  NewAlertRule,
  ValidateResult,
} from './alerts/rules';
export type {
  AggregatedMetrics,
  GroupBy,
  SummaryFilter,
  TimeseriesMetric,
  TimeseriesPoint,
  ToolStat,
  VersionMetrics,
  VersionToolStat,
} from './types';
