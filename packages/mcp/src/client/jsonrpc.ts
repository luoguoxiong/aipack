/**
 * jsonrpc.ts - JSON-RPC 2.0 编解码 + 消息分类（纯函数）
 *
 * 不依赖任何 Node API，可在任意 JS 运行时使用。stdio 传输层以行分隔
 * 逐条调用 parseMessage / serialize。
 */

export type JsonRpcId = number | string | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: Exclude<JsonRpcId, null>;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

// ─── 标准错误码 ─────────────────────────────────────────────────

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

// ─── 构造 ─────────────────────────────────────────────────────

export function createRequest(
  id: Exclude<JsonRpcId, null>,
  method: string,
  params?: unknown,
): JsonRpcRequest {
  const req: JsonRpcRequest = { jsonrpc: '2.0', id, method };
  if (params !== undefined) req.params = params;
  return req;
}

export function createNotification(method: string, params?: unknown): JsonRpcNotification {
  const n: JsonRpcNotification = { jsonrpc: '2.0', method };
  if (params !== undefined) n.params = params;
  return n;
}

export function createSuccessResponse(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: '2.0', id, result };
}

export function createErrorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  const err: JsonRpcErrorResponse = { jsonrpc: '2.0', id, error: { code, message } };
  if (data !== undefined) err.error.data = data;
  return err;
}

// ─── 序列化 ───────────────────────────────────────────────────

export function serialize(message: JsonRpcMessage): string {
  return JSON.stringify(message);
}

// ─── 解析 / 分类 ───────────────────────────────────────────────

function hasOwn(o: unknown, k: string): boolean {
  return typeof o === 'object' && o !== null && Object.prototype.hasOwnProperty.call(o, k);
}

/**
 * 解析一段字符串为 JSON-RPC 消息，或返回 null（非 JSON / 非合法 JSON-RPC）。
 * 容错：不要求 result/error 二者互斥以外的强校验，未知字段保留。
 */
export function parseMessage(raw: string): JsonRpcMessage | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  return classify(obj);
}

/** 对已解析的对象做 JSON-RPC 2.0 形状判定（不入站不 JSON.parse 的场景） */
export function classify(obj: unknown): JsonRpcMessage | null {
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (o.jsonrpc !== '2.0') return null;

  // 响应：有 result 或 error
  if (hasOwn(o, 'result') || hasOwn(o, 'error')) {
    return o as unknown as JsonRpcResponse;
  }
  // 请求 / 通知：有 method
  if (hasOwn(o, 'method') && typeof o.method === 'string') {
    // 有 id（非 null）即请求；通知无 id 字段
    if (hasOwn(o, 'id') && o.id !== null) return o as unknown as JsonRpcRequest;
    if (!hasOwn(o, 'id') || o.id === null) return o as unknown as JsonRpcNotification;
  }
  return null;
}

export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return 'result' in m || 'error' in m;
}

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return !isResponse(m) && 'id' in m && (m as JsonRpcRequest).id !== null;
}

export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return !isResponse(m) && !('id' in m && (m as { id?: unknown }).id !== null);
}

export function isErrorResponse(m: JsonRpcMessage): m is JsonRpcErrorResponse {
  return isResponse(m) && 'error' in m;
}
