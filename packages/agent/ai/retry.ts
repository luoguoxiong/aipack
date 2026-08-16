// ─── 统一重试工具模块 ───────────────────────────────────────────
// aipack/ai 内部使用（从 aipack 早期 src/utils/retry 迁移而来）

// ─── 配置 ──────────────────────────────────────────────────────────

export interface RetryOptions {
  /** 最大重试次数（默认 2） */
  maxRetries?: number;
  /** 基础重试延迟（毫秒，默认 1000） */
  baseDelayMs?: number;
  /** 最大重试延迟（毫秒，默认 30000） */
  maxDelayMs?: number;
  /** 重试回调：仅在真正退避重试时调用（可观测/埋点用；重试耗尽由调用方依据最终错误兜底） */
  onRetryAttempt?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
}

const DEFAULTS: Required<Omit<RetryOptions, 'onRetryAttempt'>> = {
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

import { isAgentError } from './errors';

/** 检查 HTTP 状态码是否应重试（429 限流 / 5xx 服务器错误） */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/** cause 链上可重试的系统错误码 */
const RETRYABLE_ERRNO = /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH)$/i;

/** 检查错误对象是否属于可重试的网络错误 */
export function isRetryableNetworkError(error: unknown): boolean {
  const msg = String(error);
  const name = (error as any)?.name ?? '';

  if (name === 'AbortError') return false;
  // 任何 abort 类错误（含跨 realm 的 DOMException 等）不可重试，
  // 避免对非幂等 POST 重复发送导致重复计费/重复副作用。
  if (/abort/i.test(msg)) return false;

  // 优先检查 cause 链上的系统错误码：undici/fetch 的网络错误把
  // errno（ECONNRESET 等）放在 err.cause.code，比消息文本匹配可靠
  let cause: unknown = (error as { cause?: unknown } | null)?.cause;
  for (let depth = 0; cause != null && depth < 3; depth++) {
    const c = cause as { code?: unknown; name?: unknown };
    if (c.name === 'AbortError' || c.code === 'ABORT_ERR') return false;
    if (typeof c.code === 'string' && RETRYABLE_ERRNO.test(c.code)) return true;
    cause = (cause as { cause?: unknown }).cause;
  }

  const patterns = [
    'fetch failed', 'network error', 'network timeout',
    'econnrefused', 'econnreset', 'etimedout',
    'socket hang up', 'request timed out', 'timed out',
    'dns lookup', 'enotfound', 'eai_again',
  ];

  const lower = msg.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

/**
 * 统一判断错误是否可重试（HTTP 状态码或错误对象）。
 * 支持直接传入 fetch Response 对象（其 status 可用于 429/5xx 判定），
 * 修复此前 Response 对象被当成普通错误导致永不重试的问题。
 */
export function isRetryableError(statusOrError: number | unknown): boolean {
  if (typeof statusOrError === 'number') {
    return isRetryableHttpStatus(statusOrError);
  }
  // AgentError 分类优先：如 timeout / auth / context-overflow 明确不可重试，
  // 避免其消息命中网络模式（如 "timed out"）导致错误重试。
  if (isAgentError(statusOrError)) {
    return statusOrError.retryable;
  }
  const status = (statusOrError as { status?: unknown } | null)?.status;
  if (typeof status === 'number') {
    return isRetryableHttpStatus(status);
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

// ─── Retry-After 解析 ─────────────────────────────────────────────

/**
 * 从错误对象提取 Retry-After 延迟（毫秒）。
 * 支持 fetch Response 对象（stream-* 重试时直接 throw res）及
 * 任何带 headers.get 的错误包装。值可为秒数或 HTTP-date 格式。
 * 无 header 或无法解析时返回 undefined。
 */
export function extractRetryAfterMs(error: unknown): number | undefined {
  const headers = (error as { headers?: unknown } | null | undefined)?.headers;
  if (headers == null) return undefined;
  // 必须以方法调用形式访问（headers.get(...)）：undici 的 brandCheck 要求
  // this 绑定在 headers 上，取出函数引用单独调用会抛 Illegal invocation
  if (typeof (headers as { get?: unknown }).get !== 'function') return undefined;
  const value = (headers as { get(name: string): string | null }).get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value); // HTTP-date 格式（如 "Wed, 21 Oct 2026 07:28:00 GMT"）
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
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
      // fn 返回了非 ok 结果（类型上禁止，运行时防御）
      lastError = result as unknown as Error;
    } catch (err) {
      lastError = err;

      if (attempt < maxRetries && isRetryableError(err)) {
        // 429 时优先尊重 Retry-After（服务端限流窗口），取其与指数退避的较大值，
        // 并以 maxDelayMs 封顶防止服务端超大值卡死重试
        const retryAfterMs = extractRetryAfterMs(err);
        const backoff = calculateDelay(attempt, baseDelayMs, maxDelayMs);
        const delay = retryAfterMs !== undefined
          ? Math.min(Math.max(backoff, retryAfterMs), maxDelayMs)
          : backoff;
        options?.onRetryAttempt?.({ attempt: attempt + 1, error: err, delayMs: delay });
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      throw err;
    }
  }

  // 正常流程不可达；防御 fn 始终返回非 ok 导致 lastError 为空
  throw lastError instanceof Error
    ? lastError
    : new Error('Retry exhausted without a result');
}

// ─── 工具层：字符串模式匹配 ────────────────────────────────────────

/** 检查错误消息是否匹配可重试模式列表 */
export function matchesRetryablePattern(errorMessage: string, patterns: string[]): boolean {
  const lower = errorMessage.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}
