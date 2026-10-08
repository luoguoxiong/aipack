/**
 * core/errors - 错误分类契约
 *
 * AI 调用链共享的错误分类常量与类型。
 * 定义在 core（契约层）供 telemetry / ai / runtime 各层单向依赖；
 * 实现层（ai/errors.ts 的 AgentError 类、分类函数）re-export 本文件。
 */

// ─── 分类常量 ──────────────────────────────────────────────────────

export const AgentErrorCategory = {
  RETRYABLE: 'retryable',
  TIMEOUT: 'timeout',
  AUTH: 'auth',
  CONTEXT_OVERFLOW: 'context-overflow',
  RATE_LIMIT: 'rate-limit',
  INVALID_REQUEST: 'invalid-request',
  UNKNOWN: 'unknown',
} as const;

export type AgentErrorCategory =
  (typeof AgentErrorCategory)[keyof typeof AgentErrorCategory];
