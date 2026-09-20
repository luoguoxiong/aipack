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

// ─── 服务端方向：resources / prompts（M3，可选）──────────────
// host 在 options 提供 resources / prompts 时才 advertise 对应 capability 并
// 处理 resources/list | resources/read | prompts/list | prompts/get；
// 未提供时 capability 缺省，方法回 -32601（method not found）。

export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  /** 内嵌文本（read 时返回 text 块） */
  text?: string;
  /** 内嵌二进制（base64；read 时返回 blob 块） */
  blob?: string;
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptMessage {
  role: 'user' | 'assistant';
  content:
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType?: string }
    | { type: 'resource'; resource: { uri: string; text?: string; blob?: string; mimeType?: string } };
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
  /** 静态消息（get 时返回）；或由 host 外部动态构造 */
  messages?: McpPromptMessage[];
}

// ─── 服务端：入站请求 params 解析（纯函数，容错）──────────────

export function parseInitializeParams(params: unknown): {
  protocolVersion?: string;
  clientInfo?: McpClientInfo;
  capabilities?: Record<string, unknown>;
} {
  const p = (params ?? {}) as Record<string, unknown>;
  return {
    protocolVersion: typeof p.protocolVersion === 'string' ? p.protocolVersion : undefined,
    clientInfo: p.clientInfo as McpClientInfo | undefined,
    capabilities: p.capabilities as Record<string, unknown> | undefined,
  };
}

export function parseToolCallParams(params: unknown): { name?: string; arguments?: unknown } {
  const p = (params ?? {}) as Record<string, unknown>;
  return {
    name: typeof p.name === 'string' ? p.name : undefined,
    arguments: p.arguments,
  };
}

export function parseListToolsParams(params: unknown): { cursor?: string } {
  const p = (params ?? {}) as Record<string, unknown>;
  return { cursor: typeof p.cursor === 'string' ? p.cursor : undefined };
}

export function parseResourceReadParams(params: unknown): { uri?: string } {
  const p = (params ?? {}) as Record<string, unknown>;
  return { uri: typeof p.uri === 'string' ? p.uri : undefined };
}

export function parsePromptGetParams(params: unknown): { name?: string; arguments?: Record<string, unknown> } {
  const p = (params ?? {}) as Record<string, unknown>;
  return {
    name: typeof p.name === 'string' ? p.name : undefined,
    arguments: p.arguments as Record<string, unknown> | undefined,
  };
}

// ─── 服务端：响应 result 构造（纯函数；host 用 createSuccessResponse 包装）──

export interface McpServerInfoLike {
  name: string;
  version: string;
}

/** 服务端 initialize 响应 result */
export function createInitializeResult(
  serverInfo: McpServerInfoLike,
  capabilities: McpServerCapabilities,
): unknown {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities,
    serverInfo,
  };
}

/** 服务端 tools/list 响应 result */
export function buildToolsListResult(
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
  nextCursor?: string,
): unknown {
  const list = tools.map((t) => {
    const out: Record<string, unknown> = { name: t.name };
    if (t.description !== undefined) out.description = t.description;
    out.inputSchema = t.inputSchema ?? { type: 'object', properties: {} };
    return out;
  });
  const r: Record<string, unknown> = { tools: list };
  if (nextCursor) r.nextCursor = nextCursor;
  return r;
}

/** 服务端 tools/call 响应 result */
export function buildToolCallResult(content: McpContentBlock[], isError?: boolean): unknown {
  const r: Record<string, unknown> = { content: content.length ? content : [{ type: 'text', text: '[empty result]' }] };
  if (isError) r.isError = true;
  return r;
}

/** 服务端 resources/list 响应 result */
export function buildResourcesListResult(resources: McpResource[], nextCursor?: string): unknown {
  const list = resources.map((r0) => {
    const out: Record<string, unknown> = { uri: r0.uri };
    if (r0.name !== undefined) out.name = r0.name;
    if (r0.description !== undefined) out.description = r0.description;
    if (r0.mimeType !== undefined) out.mimeType = r0.mimeType;
    return out;
  });
  const r: Record<string, unknown> = { resources: list };
  if (nextCursor) r.nextCursor = nextCursor;
  return r;
}

/** 服务端 resources/read 响应 result（按 uri 查找；未命中返回 null 交由 host 报错） */
export function buildResourceReadResult(resource: McpResource): unknown {
  const contents: Record<string, unknown> = { uri: resource.uri };
  if (resource.mimeType !== undefined) contents.mimeType = resource.mimeType;
  if (resource.text !== undefined) contents.text = resource.text;
  else if (resource.blob !== undefined) contents.blob = resource.blob;
  return { contents: [contents] };
}

/** 服务端 prompts/list 响应 result */
export function buildPromptsListResult(prompts: McpPrompt[], nextCursor?: string): unknown {
  const list = prompts.map((p0) => {
    const out: Record<string, unknown> = { name: p0.name };
    if (p0.description !== undefined) out.description = p0.description;
    if (p0.arguments !== undefined) out.arguments = p0.arguments;
    return out;
  });
  const r: Record<string, unknown> = { prompts: list };
  if (nextCursor) r.nextCursor = nextCursor;
  return r;
}

/** 服务端 prompts/get 响应 result */
export function buildPromptGetResult(messages: McpPromptMessage[]): unknown {
  return { messages: messages ?? [] };
}

export { isErrorResponse };
