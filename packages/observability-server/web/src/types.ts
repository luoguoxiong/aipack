/** 面板 API 响应类型（与 observability-server 契约对齐） */

export interface Summary {
  requests: number;
  successRate: number;
  costUsd: number;
  costUnknown: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  avgTurns: number;
  retryRate: number;
  permissionDenied: number;
  errorClasses: Record<string, number>;
}

export interface ToolStat {
  tool: string;
  calls: number;
  successRate: number;
  avgMs: number;
  errors: number;
}

export interface TimeseriesPoint {
  t: number;
  v: number;
}

export interface TraceItem {
  traceId: string;
  appId?: string;
  startedAt: number;
  durationMs: number;
  status: 'success' | 'error' | 'validation';
  turns: number;
  tokens: { input: number; output: number };
  costUsd?: number;
  retries: number;
  sessionKey: string;
}

export interface TraceListResponse {
  page: number;
  pageSize: number;
  total: number;
  items: TraceItem[];
}

export interface Span {
  spanId: string;
  kind: 'run' | 'model' | 'tool';
  name: string;
  startedAt: number;
  durationMs: number;
  status: 'ok' | 'error';
  errorClass?: string;
  attempts?: number;
  tokens: { input: number; output: number };
  costUsd?: number;
}

export interface TraceDetail {
  traceId: string;
  spans: Span[];
}

export interface AppInfo {
  appId: string;
  appSecret: string;
  name: string;
  createdAt: number;
  lastSeenAt?: number;
}

export interface LoginResponse {
  token: string;
  username: string;
}

// ── 告警 ──────────────────────────────────────────────────────────

export type AlertMetric =
  | 'successRate'
  | 'p95Ms'
  | 'avgTurns'
  | 'retryRate'
  | 'permissionDenied'
  | 'costUsd'
  | 'requests'
  | 'toolSuccessRate'
  | 'errorClassCount';

export type AlertOperator = 'lt' | 'lte' | 'gt' | 'gte';

export interface AlertRule {
  id: string;
  name: string;
  appId?: string;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  lookbackMs: number;
  cooldownMs: number;
  webhookUrl?: string;
  toolName?: string;
  errorClass?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AlertEvent {
  id: number;
  ruleId: string;
  ruleName: string;
  appId?: string;
  metric: string;
  operator: string;
  threshold: number;
  value: number;
  status: 'fired' | 'recovered';
  createdAt: number;
}

export interface AlertEventListResponse {
  total: number;
  items: AlertEvent[];
}

// ── 面板元信息 ─────────────────────────────────────────────────────

export interface Meta {
  /** Trace 详情"查看日志"跳转模板（%s 替换为 traceId），未配置时缺省 */
  logStreamUrlTemplate?: string;
}
