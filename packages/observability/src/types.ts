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
  costUsd?: number;
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
  costUsd?: number;
  /** 会话标识（支撑 session 维度成本统计） */
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

/** 客户端一次上报的批量事件（POST /api/v1/ingest body，appId 附加） */
export interface EventBatch {
  runs: RunRecord[];
  spans: SpanRecord[];
  toolCalls: ToolCallRecord[];
  permissions: PermissionRecord[];
}
