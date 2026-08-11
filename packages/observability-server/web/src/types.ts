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
