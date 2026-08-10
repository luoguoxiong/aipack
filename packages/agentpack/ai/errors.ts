/**
 * AgentError - 统一错误分类体系
 *
 * AI 调用链（stream 层 / retry 层 / 上层消费者）共享同一套错误分类：
 * - retryable         网络抖动 / 5xx 瞬时错误（可重试）
 * - rate-limit        429 限流（可重试，配合退避）
 * - timeout           超时（半开连接 / idle 断流）
 * - auth              认证失败（401/403 / 缺少 API key / key 无效）
 * - context-overflow  上下文超限（413 / context length 错误）
 * - invalid-request   请求非法（其余 4xx）
 * - unknown           未分类
 *
 * 用途：
 * 1. retry 决策（isRetryableError 优先读取 category，替代消息模式匹配）
 * 2. 上层差异化处理（如 auth 错误提示用户换 key、context-overflow 触发压缩）
 * 3. errorMessage 带 [category] 前缀，人可直接阅读
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

// ─── AgentError 类 ─────────────────────────────────────────────────

export interface AgentErrorOptions {
  /** 错误分类（缺省 unknown） */
  category?: AgentErrorCategory;
  /** HTTP 状态码（如有） */
  status?: number;
  /** 是否可重试（缺省按分类推导：retryable / rate-limit 可重试） */
  retryable?: boolean;
  /** 原始错误（如 fetch Response / 底层 Error） */
  cause?: unknown;
}

const RETRYABLE_CATEGORIES: ReadonlySet<AgentErrorCategory> = new Set([
  AgentErrorCategory.RETRYABLE,
  AgentErrorCategory.RATE_LIMIT,
]);

/** 该分类默认是否可重试 */
export function isRetryableCategory(category: AgentErrorCategory): boolean {
  return RETRYABLE_CATEGORIES.has(category);
}

export class AgentError extends Error {
  readonly category: AgentErrorCategory;
  readonly status?: number;
  readonly retryable: boolean;
  /** 原始错误（ES2022 cause，Node 18 起 Error 构造支持 options.cause） */
  override readonly cause?: unknown;

  constructor(message: string, options: AgentErrorOptions = {}) {
    super(message);
    this.name = 'AgentError';
    this.category = options.category ?? AgentErrorCategory.UNKNOWN;
    this.status = options.status;
    this.retryable = options.retryable ?? isRetryableCategory(this.category);
    // 不依赖 ES2022 Error 构造 options.cause（低 target 转译可能丢失），显式赋值
    this.cause = options.cause;
  }
}

/** 类型守卫：兼容跨包/跨 realm 复制的 AgentError 对象 */
export function isAgentError(error: unknown): error is AgentError {
  if (error instanceof AgentError) return true;
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { name?: unknown }).name === 'AgentError' &&
    typeof (error as { category?: unknown }).category === 'string'
  );
}

// ─── HTTP 状态码分类 ───────────────────────────────────────────────

export function classifyHttpStatus(status: number): AgentErrorCategory {
  if (status === 401 || status === 403) return AgentErrorCategory.AUTH;
  if (status === 429) return AgentErrorCategory.RATE_LIMIT;
  if (status === 413) return AgentErrorCategory.CONTEXT_OVERFLOW;
  if (status >= 500 && status < 600) return AgentErrorCategory.RETRYABLE;
  if (status >= 400 && status < 500) return AgentErrorCategory.INVALID_REQUEST;
  return AgentErrorCategory.UNKNOWN;
}

// ─── 错误消息分类（覆盖无 HTTP 状态码的场景）────────────────────────

const CONTEXT_OVERFLOW_PATTERNS = [
  'context length',
  'context window',
  'context overflow',
  'context too long',
  'maximum context',
  'too many tokens',
  'token limit',
  'prompt is too long',
  'input is too long',
  'exceeds the model',
];

const RATE_LIMIT_PATTERNS = [
  'rate limit',
  'too many requests',
  'ratelimit',
];

const AUTH_PATTERNS = [
  'unauthorized',
  'authentication',
  'invalid api key',
  'incorrect api key',
  'api key invalid',
  'permission denied',
  'forbidden',
  '401',
  '403',
];

const TIMEOUT_PATTERNS = [
  'timeout',
  'timed out',
  'etimedout',
];

export function classifyErrorMessage(message: string): AgentErrorCategory {
  const lower = message.toLowerCase();
  if (CONTEXT_OVERFLOW_PATTERNS.some((p) => lower.includes(p))) {
    return AgentErrorCategory.CONTEXT_OVERFLOW;
  }
  if (RATE_LIMIT_PATTERNS.some((p) => lower.includes(p))) {
    return AgentErrorCategory.RATE_LIMIT;
  }
  if (AUTH_PATTERNS.some((p) => lower.includes(p))) {
    return AgentErrorCategory.AUTH;
  }
  if (TIMEOUT_PATTERNS.some((p) => lower.includes(p))) {
    return AgentErrorCategory.TIMEOUT;
  }
  return AgentErrorCategory.UNKNOWN;
}

// ─── 分类组合 ──────────────────────────────────────────────────────

/**
 * 从任意错误对象推导分类：
 * AgentError 优先；有 status 按状态码；否则按消息模式。
 */
export function classifyError(error: unknown): AgentErrorCategory {
  if (isAgentError(error)) return error.category;
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return classifyHttpStatus(status);
  const msg = (error as Error | null)?.message ?? String(error ?? '');
  return classifyErrorMessage(msg);
}

/** 是否属于"上下文超限"（供压缩/截断策略复用） */
export function isContextOverflowError(error: unknown): boolean {
  return classifyError(error) === AgentErrorCategory.CONTEXT_OVERFLOW;
}

// ─── 格式化 ────────────────────────────────────────────────────────

/** 分类标签（如 [auth]），unknown 分类返回空串 */
export function categoryLabel(category: AgentErrorCategory): string {
  return category === AgentErrorCategory.UNKNOWN ? '' : `[${category}] `;
}

/**
 * 构造带分类前缀的 errorMessage：
 *   [auth] API error 401: Invalid API key
 *   [rate-limit] API error 429: Too many requests
 *   [timeout] Stream idle timeout after 60000ms
 */
export function formatCategoryError(
  category: AgentErrorCategory,
  message: string,
): string {
  return `${categoryLabel(category)}${message}`;
}

/**
 * 基于 HTTP 状态码构造分类错误消息：
 *   apiErrorLabel 形如 "API error" / "Anthropic API error"
 */
export function formatHttpError(
  status: number,
  message: string,
  apiErrorLabel = 'API error',
): string {
  const category = classifyHttpStatus(status);
  return formatCategoryError(category, `${apiErrorLabel} ${status}: ${message}`);
}
