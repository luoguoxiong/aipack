/** 面板 API 响应类型（与 observability-server 契约对齐） */

export interface Summary {
  requests: number;
  successRate: number;
  /** token 总消耗量（input+output+cacheRead+cacheWrite） */
  totalTokens: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  avgTurns: number;
  retryRate: number;
  /** P2-2 per-attempt 重试分布：HTTP 状态码（'429'/'502'，无状态码记 'unknown'）-> 次数 */
  retryByStatus: Record<string, number>;
  /** P2-2 重试退避时长分位（ms，0 表示无重试数据） */
  retryBackoffP50Ms: number;
  retryBackoffP95Ms: number;
  permissionDenied: number;
  errorClasses: Record<string, number>;
  /** Phase 6 成本合计（单位：美元 $，向后兼容，缺失时按 0 处理） */
  costTotal?: number;
}

export interface ToolStat {
  tool: string;
  calls: number;
  successRate: number;
  avgMs: number;
  errors: number;
}

/** /metrics/versions 单版本单工具统计（keyed by tool name） */
export interface VersionToolStat {
  calls: number;
  /** ok / (ok + error)，blocked/skipped 不计入分母 */
  successRate: number;
  avgMs: number;
  errors: number;
}

/** /metrics/versions 单版本聚合（DB 直查，非内存窗口；口径对齐 Summary） */
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
  /** 工具名 -> 统计（keyed by tool name 便于对比 diff） */
  tools: Record<string, VersionToolStat>;
}

export interface VersionListResponse {
  items: VersionMetrics[];
}

export interface TimeseriesPoint {
  t: number;
  v: number;
}

export interface TraceItem {
  traceId: string;
  appId?: string;
  /** 发布版本（appVersion），旧数据缺省为 undefined */
  appVersion?: string;
  startedAt: number;
  durationMs: number;
  status: 'success' | 'error' | 'validation';
  turns: number;
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
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
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

/** P2-1 自定义事件（emit 埋点，归属 run 或指定 session） */
export interface TraceEvent {
  name: string;
  data?: unknown;
  timestamp: number;
  sessionKey?: string;
}

/** P2-2 per-attempt 重试明细（关联 model span） */
export interface RetryAttempt {
  provider: string;
  modelId: string;
  attempt: number;
  errorClass?: string;
  status?: number;
  delayMs?: number;
  timestamp: number;
}

export interface TraceDetail {
  traceId: string;
  spans: Span[];
  events: TraceEvent[];
  retries: RetryAttempt[];
  /** Phase 9 跨系统链路：W3C traceId（可选，用于跨服务链路关联） */
  w3cTraceId?: string;
  /** Phase 9 跨系统链路：父系统 trace 引用（URL 或父 traceId，可选） */
  parentTraceId?: string;
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

// ── Phase 4：多用户 RBAC ──────────────────────────────────────────

/** 多用户登录响应（/api/auth/login multi 模式） */
export interface MultiLoginResponse {
  user: { id: string; email: string; name?: string };
  accessToken: string;
  refreshToken: string;
}

/** /api/auth/me 多用户模式响应 */
export interface MultiMeResponse {
  id: string;
  email: string;
  name?: string;
  createdAt?: number;
  role?: 'owner' | 'editor' | 'viewer';
  projectId?: string;
}

export interface UserInfo {
  id: string;
  email: string;
  name?: string;
  role?: 'owner' | 'editor' | 'viewer';
  projectId?: string;
}

export interface ProjectItem {
  id: string;
  name: string;
  ownerId: string;
  createdAt: number;
}

export interface ProjectMember {
  userId: string;
  email?: string;
  name?: string;
  role: 'owner' | 'editor' | 'viewer';
  grantedAt: number;
  grantedBy: string;
}

// ── Phase 5：Agent 定义 ──────────────────────────────────────────

export interface AgentSpec {
  systemPrompt: string;
  model: {
    provider: string;
    id: string;
    temperature?: number;
    maxTokens?: number;
  };
  tools: string[];
  params?: {
    maxTurns?: number;
    approvalMode?: 'auto' | 'always' | 'never';
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AgentDefinitionItem {
  id: string;
  projectId: string;
  name: string;
  version: number;
  status: 'draft' | 'published' | 'archived';
  spec: AgentSpec;
  createdBy: string;
  createdAt: number;
  publishedAt?: number;
}

// ── 告警 ──────────────────────────────────────────────────────────

export type AlertMetric =
  | 'successRate'
  | 'p95Ms'
  | 'avgTurns'
  | 'retryRate'
  | 'permissionDenied'
  | 'tokensTotal'
  | 'requests'
  | 'toolSuccessRate'
  | 'errorClassCount'
  | 'versionSuccessRate'
  | 'versionP95Ms';

export type AlertOperator = 'lt' | 'lte' | 'gt' | 'gte' | 'regress_by';

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

// ── Phase 6 成本核算 ─────────────────────────────────────────────

/** 成本聚合项（按 model 或 app 维度分组） */
export interface CostSummaryItem {
  /** model id 或 app id */
  key: string;
  /** 成本（单位：分，便于精确累加） */
  costCents: number;
  /** 调用次数 */
  runs: number;
}

/** 模型价格配置 */
export interface ModelPrice {
  modelId: string;
  inputPer1m: number;
  outputPer1m: number;
  cacheReadPer1m: number;
  cacheWritePer1m: number;
  currency: string;
  /** 生效时间（epoch ms） */
  effectiveAt: number;
}

// ── Phase 9 错误归因下钻 ─────────────────────────────────────────

/** 错误类 TopN 计数项 */
export interface ErrorClassCountItem {
  errorClass: string;
  count: number;
}

/** 错误类下钻结果：最近 trace + 模型/工具分布 */
export interface ErrorClassDrillResult {
  errorClass: string;
  recentTraces: Array<{
    traceId: string;
    startedAt: number;
    durationMs: number;
    model?: string;
    appId?: string;
    sessionKey?: string;
  }>;
  byModel: Record<string, number>;
  byTool: Record<string, number>;
}
