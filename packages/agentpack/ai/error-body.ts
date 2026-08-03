/**
 * 统一错误格式化
 *
 * 从不同来源（HTTP 响应、SDK 错误、网络错误）提取状态码和 body，
 * 格式化为可读的错误消息文本。
 */

// ─── 常量 ──────────────────────────────────────────────────────────

/** 错误 body 截断长度 */
const MAX_BODY_LENGTH = 2000;

// ─── 核心类型 ──────────────────────────────────────────────────────

export interface NormalizedError {
  /** HTTP 状态码（如果有） */
  status?: number;
  /** 错误消息 */
  message: string;
  /** 原始错误 body 文本（截断后） */
  body?: string;
}

// ─── Body 提取 ─────────────────────────────────────────────────────

/**
 * 从 Response 对象提取错误 body
 */
async function extractResponseBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return '';
    // 尝试格式化为 JSON
    try {
      const parsed = JSON.parse(text);
      // 尝试提取 API 友好的 error.message
      const errorMsg =
        parsed?.error?.message ??
        parsed?.error?.msg ??
        parsed?.message;
      if (errorMsg && typeof errorMsg === 'string') {
        return errorMsg;
      }
    } catch {
      // 不是 JSON，返回原始文本
    }
    return text;
  } catch {
    return '';
  }
}

// ─── 错误标准化 ────────────────────────────────────────────────────

/**
 * 从 HTTP Response 标准化错误
 */
export async function normalizeResponseError(response: Response): Promise<NormalizedError> {
  const body = await extractResponseBody(response);
  const truncated = body.length > MAX_BODY_LENGTH
    ? body.slice(0, MAX_BODY_LENGTH) + '...'
    : body;

  // 从 body 中提取更有意义的短消息
  const shortMessage = truncated.length > 0 ? truncated : response.statusText;

  return {
    status: response.status,
    message: shortMessage,
    body: truncated,
  };
}

/**
 * 从异常/错误对象标准化错误
 */
export function normalizeError(error: unknown): NormalizedError {
  const err = error as any;

  // AbortError
  if (err?.name === 'AbortError') {
    return { message: 'Request aborted' };
  }

  // Response-like object (thrown from retry)
  if (err?.status && typeof err.status === 'number') {
    return {
      status: err.status,
      message: err.statusText || `HTTP ${err.status}`,
    };
  }

  // Error-like object
  const msg = err?.message ?? String(error ?? 'Unknown error');

  return { message: String(msg) };
}

// ─── 格式化 ────────────────────────────────────────────────────────

/**
 * 格式化为单行错误消息
 */
export function formatError(error: NormalizedError): string {
  const parts: string[] = [];

  if (error.status) {
    parts.push(`HTTP ${error.status}`);
  }

  if (error.message) {
    parts.push(parts.length > 0 ? `- ${error.message}` : error.message);
  }

  return parts.join(' ');
}
