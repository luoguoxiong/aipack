/**
 * protocol.ts - MCP 协议子集消息构造 / 校验（纯函数）
 *
 * v1 范围：initialize / notifications/initialized / tools/list / tools/call /
 * ping / notifications/cancelled / notifications/tools/list_changed。
 * resources / prompts / sampling 留待后续版本。
 *
 * 设计原则：本模块只产 / 解 MCP 消息形状，不分配 JSON-RPC id（id 由会话层
 * McpClient 分配并经 jsonrpc.createRequest 注入），保证纯函数可单测。
 */

import {
  createRequest,
  createNotification,
  type JsonRpcRequest,
  type JsonRpcNotification,
  isErrorResponse,
} from './jsonrpc';

// ─── 协议版本 ─────────────────────────────────────────────────

/** 客户端宣告版本（最新稳定） */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
/** 协议基线；server 声明版本 < 此值则视为不兼容 */
export const MCP_BASELINE_VERSION = '2024-11-05';

// ─── 能力 / 信息 ─────────────────────────────────────────────

export interface McpClientInfo {
  name: string;
  version: string;
}

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: Record<string, unknown> | {};
  prompts?: Record<string, unknown> | {};
  logging?: Record<string, unknown> | {};
  [key: string]: unknown;
}

// ─── 工具形状 ─────────────────────────────────────────────────

export interface McpToolInfo {
  name: string;
  description?: string;
  /** JSON Schema，直接对接 agent Tool.parameters */
  inputSchema?: unknown;
  annotations?: unknown;
}

export interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  /** 规范中 resource 块的载荷在嵌套字段 */
  resource?: { uri: string; text?: string; blob?: string; mimeType?: string };
}

export interface McpToolCallResult {
  content: McpContentBlock[];
  isError?: boolean;
}

// ─── initialize ───────────────────────────────────────────────

export interface McpInitializeResult {
  protocolVersion: string;
  serverInfo: McpServerInfo;
  capabilities: McpServerCapabilities;
}

/**
 * 协议版本协商：client 发送 clientVersion，server 返回其版本。
 * - server 版本 === clientVersion → ok，使用之
 * - server 版本 >= baseline → ok，使用 server 版本（降级）
 * - 否则不兼容
 */
export function negotiateProtocol(
  clientVersion: string,
  serverVersion: string,
): { ok: boolean; version?: string } {
  if (!serverVersion || typeof serverVersion !== 'string') return { ok: false };
  if (serverVersion === clientVersion) return { ok: true, version: serverVersion };
  // 字符串序不足以判断版本先后，这里仅做基线存在性校验：只要 >= baseline 即接受
  if (serverVersion >= MCP_BASELINE_VERSION) return { ok: true, version: serverVersion };
  return { ok: false };
}

export function createInitializeRequest(
  id: number | string,
  client: McpClientInfo,
): JsonRpcRequest {
  return createRequest(id, 'initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: client,
  });
}

export function createInitializedNotification(): JsonRpcNotification {
  return createNotification('notifications/initialized');
}

/** 解析 initialize 响应 result；容错：缺省字段给出合理默认 */
export function parseInitializeResult(result: unknown): McpInitializeResult {
  const r = (result ?? {}) as Record<string, unknown>;
  const serverInfo = (r.serverInfo ?? { name: 'unknown', version: '0.0.0' }) as McpServerInfo;
  const capabilities = (r.capabilities ?? {}) as McpServerCapabilities;
  const protocolVersion = typeof r.protocolVersion === 'string' ? r.protocolVersion : '';
  return { protocolVersion, serverInfo, capabilities };
}

// ─── tools/list ──────────────────────────────────────────────

export function createListToolsRequest(id: number | string, cursor?: string): JsonRpcRequest {
  const params: Record<string, unknown> = {};
  if (cursor) params.cursor = cursor;
  return createRequest(id, 'tools/list', Object.keys(params).length ? params : undefined);
}

export interface McpToolListResult {
  tools: McpToolInfo[];
  nextCursor?: string;
}

export function parseToolListResponse(result: unknown): McpToolListResult {
  const r = (result ?? {}) as Record<string, unknown>;
  const rawTools = Array.isArray(r.tools) ? (r.tools as unknown[]) : [];
  const tools: McpToolInfo[] = [];
  for (const t of rawTools) {
    const tt = t as Record<string, unknown>;
    if (!tt || typeof tt.name !== 'string') continue; // 跳过非法工具
    tools.push({
      name: tt.name,
      description: typeof tt.description === 'string' ? tt.description : undefined,
      inputSchema: tt.inputSchema,
      annotations: tt.annotations,
    });
  }
  const nextCursor = typeof r.nextCursor === 'string' ? r.nextCursor : undefined;
  return { tools, nextCursor };
}

// ─── tools/call ───────────────────────────────────────────────

export function createCallToolRequest(
  id: number | string,
  name: string,
  args: unknown,
): JsonRpcRequest {
  return createRequest(id, 'tools/call', { name, arguments: args ?? {} });
}

/**
 * 解析 tools/call 响应。容错：
 * - content 缺失 → 空数组
 * - 未知 type / 未知字段保留（由 adapter 层降级映射）
 * - JSON-RPC error 响应 → 转为 isError + 错误文本
 */
export function parseToolCallResult(result: unknown): McpToolCallResult {
  if (result && typeof result === 'object' && 'error' in result) {
    // 调用方传入的是整个 JSON-RPC error 对象（不应发生，但兜底）
    const err = (result as { error: { message?: string } }).error;
    return { content: [{ type: 'text', text: err?.message ?? 'MCP call error' }], isError: true };
  }
  const r = (result ?? {}) as Record<string, unknown>;
  const rawContent = Array.isArray(r.content) ? (r.content as unknown[]) : [];
  const content: McpContentBlock[] = [];
  for (const c of rawContent) {
    const cc = c as Record<string, unknown>;
    if (!cc || typeof cc.type !== 'string') {
      content.push({ type: 'text', text: '[unsupported content]' });
      continue;
    }
    content.push({
      type: cc.type,
      text: typeof cc.text === 'string' ? cc.text : undefined,
      data: typeof cc.data === 'string' ? cc.data : undefined,
      mimeType: typeof cc.mimeType === 'string' ? cc.mimeType : undefined,
      resource: cc.resource as McpContentBlock['resource'],
    });
  }
  if (content.length === 0) content.push({ type: 'text', text: '[empty result]' });
  // isError 仅在 true 时显式置位，否则 undefined（与 agent "details.error 缺省 = 成功" 约定一致）
  const isError = r.isError === true ? true : undefined;
  return { content, isError };
}

/** 把 JSON-RPC error 响应转为 MCP 工具调用结果（isError） */
export function errorResponseToCallResult(message: string): McpToolCallResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ─── ping ─────────────────────────────────────────────────────

export function createPingRequest(id: number | string): JsonRpcRequest {
  return createRequest(id, 'ping', {});
}

// ─── notifications ────────────────────────────────────────────

/** 取消通知：告知 server 某请求已被取消（协作型 server 可停止计算） */
export function createCancelledNotification(
  requestId: number | string,
  reason?: string,
): JsonRpcNotification {
  const params: Record<string, unknown> = { requestId };
  if (reason) params.reason = reason;
  return createNotification('notifications/cancelled', params);
}

/** 工具列表变更通知：订阅后 server 主动告知客户端重新拉取 */
export function createListChangedNotification(): JsonRpcNotification {
  return createNotification('notifications/tools/list_changed');
}

export function isListChangedNotification(m: { method?: string }): boolean {
  return m.method === 'notifications/tools/list_changed';
}

export { isErrorResponse };
