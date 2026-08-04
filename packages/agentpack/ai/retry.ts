// ─── 统一重试工具模块 ───────────────────────────────────────────
// agentpack/ai 内部使用（从 agentpack 早期 src/utils/retry 迁移而来）

// ─── 配置 ──────────────────────────────────────────────────────────

export interface RetryOptions {
  /** 最大重试次数（默认 2） */
  maxRetries?: number;
  /** 基础重试延迟（毫秒，默认 1000） */
  baseDelayMs?: number;
  /** 最大重试延迟（毫秒，默认 30000） */
  maxDelayMs?: number;
}

const DEFAULTS: Required<RetryOptions> = {
  maxRetries: 2,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

// ─── 延迟计算（指数退避 + jitter）────────────────────────────────

/**
 * 计算第 attempt 次重试的退避延迟（毫秒）。
 * 公式：min(base * 2^attempt, max)，附加 ±25% 随机 jitter。
 */
export function calculateDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
  const jitter = exponential * 0.25;
  return Math.round(exponential - jitter + Math.random() * jitter * 2);
}

// ─── HTTP 错误分类 ────────────────────────────────────────────────

/** 检查 HTTP 状态码是否应重试（429 限流 / 5xx 服务器错误） */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/** 检查错误对象是否属于可重试的网络错误 */
export function isRetryableNetworkError(error: unknown): boolean {
  const msg = String(error);
  const name = (error as any)?.name ?? '';

  if (name === 'AbortError') return false;

  const patterns = [
    'fetch failed', 'network error', 'network timeout',
    'econnrefused', 'econnreset', 'etimedout',
    'socket hang up', 'request timed out', 'timeout',
    'dns lookup', 'enotfound', 'eai_again',
  ];

  const lower = msg.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

/** 统一判断错误是否可重试（HTTP 状态码或错误对象） */
export function isRetryableError(statusOrError: number | unknown): boolean {
  if (typeof statusOrError === 'number') {
    return isRetryableHttpStatus(statusOrError);
  }
  return isRetryableNetworkError(statusOrError);
}

// ─── 结果包装 ──────────────────────────────────────────────────────

export interface RetryResult<T> {
  ok: true;
  value: T;
}

export function ok<T>(value: T): RetryResult<T> {
  return { ok: true, value };
}

// ─── 通用重试执行器 ────────────────────────────────────────────────

/**
 * 执行异步操作并自动重试可重试的错误。
 *
 * @example
 * ```ts
 * const res = await retry(async (attempt) => {
 *   const r = await fetch(url);
 *   if (!r.ok && isRetryableHttpStatus(r.status)) throw r;
 *   return ok(r);
 * });
 * ```
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<RetryResult<T>>,
  options?: RetryOptions,
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs } = { ...DEFAULTS, ...options };

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn(attempt);
      if (result.ok) return result.value;
    } catch (err) {
      lastError = err;

      if (attempt < maxRetries && isRetryableError(err)) {
        const delay = calculateDelay(attempt, baseDelayMs, maxDelayMs);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      throw err;
    }
  }

  throw lastError;
}

// ─── 工具层：字符串模式匹配 ────────────────────────────────────────

/** 检查错误消息是否匹配可重试模式列表 */
export function matchesRetryablePattern(errorMessage: string, patterns: string[]): boolean {
  const lower = errorMessage.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}
