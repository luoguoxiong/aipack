/**
 * 指数退避重试策略
 *
 * 支持可重试错误分类（5xx / 网络错误 / 限流）与不可重试错误（4xx / 认证错误）
 */

// ─── 默认配置 ──────────────────────────────────────────────────────

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

// ─── 错误分类 ──────────────────────────────────────────────────────

/** 检查 HTTP 状态码是否应重试 */
export function isRetryableHttpStatus(status: number): boolean {
  // 429 Too Many Requests（限流）-> 重试
  // 5xx 服务器错误 -> 重试
  return status === 429 || (status >= 500 && status < 600);
}

/** 检查错误类型是否应重试（网络错误、超时等） */
export function isRetryableNetworkError(error: unknown): boolean {
  const msg = String(error);
  const name = (error as any)?.name ?? '';

  // 中止请求不重试
  if (name === 'AbortError') return false;

  // 网络错误可重试
  const retryable = [
    'fetch failed',
    'network error',
    'network timeout',
    'econnrefused',
    'econnreset',
    'etimedout',
    'socket hang up',
    'request timed out',
    'timeout',
    'dns lookup',
    'enotfound',
    'eai_again',
  ];

  const lower = msg.toLowerCase();
  return retryable.some((pattern) => lower.includes(pattern));
}

/** 判断错误是否可重试 */
export function isRetryableError(statusOrError: number | unknown): boolean {
  if (typeof statusOrError === 'number') {
    return isRetryableHttpStatus(statusOrError);
  }
  return isRetryableNetworkError(statusOrError);
}

// ─── 延迟计算（带 jitter）─────────────────────────────────────────

function calculateDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  // 指数退避: 2^attempt * baseDelayMs
  const exponential = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
  // 添加 ±25% 随机 jitter
  const jitter = exponential * 0.25;
  return Math.round(exponential - jitter + Math.random() * jitter * 2);
}

// ─── 重试执行器 ────────────────────────────────────────────────────

export interface RetryableResult<T> {
  ok: true;
  value: T;
}

export function ok<T>(value: T): RetryableResult<T> {
  return { ok: true, value };
}

/**
 * 执行异步操作并自动重试可重试的错误
 *
 * @example
 * ```ts
 * const result = await retry(async (attempt) => {
 *   const res = await fetch(url);
 *   if (!res.ok && isRetryableHttpStatus(res.status)) throw res;
 *   return ok(res);
 * });
 * ```
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<RetryableResult<T>>,
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
