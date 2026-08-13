/**
 * 上报 SDK 记录类型（@aipack/observability）。
 * 客户端 telemetry 事件转成这些原始记录后批量上报；收集服务（@aipack/observability-server）
 * 依赖这些类型做落盘与聚合。
 */

export interface RunRecord {
  traceId: string;
  startedAt: number;
  endedAt: number;
  sessionKey: string;
  channel?: string;
  model?: string;
  /** 发布版本（接入方 agent 应用版本，如 '1.3.0'）。可空：旧 SDK / 未配置时缺省，服务端归入 unknown */
  appVersion?: string;
  status: 'success' | 'error' | 'validation';
  errorClass?: string;
  turns: number;
  durationMs: number;
  activeMs: number;
  queuedMs: number;
  ttftMs?: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface SpanRecord {
  traceId: string;
  spanId: string;
  kind: 'run' | 'model' | 'tool';
  name: string; // model:<id> / tool:<name> / run
  startedAt: number;
  durationMs: number;
  status: 'ok' | 'error';
  errorClass?: string;
  attempts?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** 会话标识（支撑 session 维度 token 统计） */
  sessionKey?: string;
}

export interface ToolCallRecord {
  traceId: string;
  spanId: string;
  toolName: string;
  status: 'ok' | 'error' | 'blocked' | 'skipped';
  durationMs: number;
  errorClass?: string;
}

/** 权限拦截记录（收集端仅计入聚合器计数，不落库） */
export interface PermissionRecord {
  traceId?: string;
  sessionKey: string;
  toolName: string;
  reason: string;
  /** 事件发生时刻（epoch ms） */
  timestamp: number;
}

/** 自定义业务事件（P2-1：obs.emit 通用埋点，入 Trace 时间轴） */
export interface EventRecord {
  /** run 内 emit 自动注入；run 外缺省 */
  traceId?: string;
  sessionKey?: string;
  /** 事件名（如 'tool_picked' / 'cancelled'），面板按此分组 */
  name: string;
  /** 任意 JSON 可序列化数据 */
  data?: unknown;
  /** 事件发生时刻（epoch ms） */
  timestamp: number;
}

/** 单次 provider 内部重试（P2-2：per-attempt 维度，关联 model span） */
export interface RetryRecord {
  traceId: string;
  /** 关联的模型调用 span */
  spanId?: string;
  provider: string;
  modelId: string;
  /** 第几次重试（从 1 开始） */
  attempt: number;
  errorClass?: string;
  /** HTTP 状态码（如有，如 429/502） */
  status?: number;
  /** 本次退避延迟（ms） */
  delayMs: number;
  /** 重试发生时刻（epoch ms） */
  timestamp: number;
}

/** 客户端一次上报的批量事件（POST /api/v1/ingest body，appId 附加） */
export interface EventBatch {
  runs: RunRecord[];
  spans: SpanRecord[];
  toolCalls: ToolCallRecord[];
  permissions: PermissionRecord[];
  retries: RetryRecord[];
  events: EventRecord[];
}
