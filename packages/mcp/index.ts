/**
 * aipack-mcp —— aipack MCP 插件
 *
 * 打通 MCP 生态（客户端方向，主）：Agent 连接外部 MCP Server，把远端工具
 * 包装为 aipack 原生 Tool，零成本接入 MCP 工具生态；一经包装即获得 runtime
 * 全套能力（权限审批 / 超时 / 钩子 / telemetry / 并行调用）。
 *
 * 零运行时依赖：自研 JSON-RPC 2.0 编解码 + MCP 核心协议子集（initialize /
 * tools/list / tools/call / ping / cancelled / list_changed）。
 * 服务端方向、http/sse 传输、resources/prompts/sampling 留待 M2/M3。
 *
 * 快速接入：
 *   import { createMcpPlugin } from '@aipack-ai/mcp';
 *   const mcp = createMcpPlugin({
 *     servers: [{ name: 'echo', transport: { type: 'stdio', command: 'node', args: ['echo-server.mjs'] } }],
 *   });
 *   const runtime = createRuntime({ ..., extensions: [...mcp.extensions] });
 *   // 可选预热：await mcp.ready();
 */

// ─── 插件入口 ───────────────────────────────────────────────────
export { McpExtension, createMcpPlugin } from './src/extension';
export type { McpPlugin } from './src/extension';

// ─── Registry（高级用例：程序化多 server 管理）─────────────────
export { McpRegistry } from './src/registry';
export type { McpClientFactory } from './src/registry';

// ─── 客户端（高级用例：直接驱动单个 MCP Server）────────────────
export { McpClient, createTransportFromConfig } from './src/client/mcp-client';
export { StdioMcpTransport } from './src/client/stdio-transport';
export { HttpMcpTransport, createHttpTransport } from './src/client/http-transport';
export type { HttpTransportOptions } from './src/client/http-transport';
export type { McpTransport } from './src/client/stdio-transport';
export type {
  McpClientLike,
  McpClientOptions,
  CallToolOptions,
} from './src/client/mcp-client';

// ─── 契约层（纯函数，零 Node API）────────────────────────────────
// JSON-RPC 2.0 编解码
export {
  createRequest,
  createNotification,
  createSuccessResponse,
  createErrorResponse,
  serialize,
  parseMessage,
  classify,
  isResponse,
  isRequest,
  isNotification,
  isErrorResponse,
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
} from './src/client/jsonrpc';
export type {
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  JsonRpcMessage,
} from './src/client/jsonrpc';

// MCP 协议子集
export {
  MCP_PROTOCOL_VERSION,
  MCP_BASELINE_VERSION,
  negotiateProtocol,
  createInitializeRequest,
  createInitializedNotification,
  parseInitializeResult,
  createListToolsRequest,
  parseToolListResponse,
  createCallToolRequest,
  parseToolCallResult,
  errorResponseToCallResult,
  createPingRequest,
  createCancelledNotification,
  createListChangedNotification,
  isListChangedNotification,
} from './src/client/protocol';
export type {
  McpClientInfo,
  McpServerInfo,
  McpServerCapabilities,
  McpInitializeResult,
  McpToolInfo,
  McpContentBlock,
  McpToolCallResult,
  McpToolListResult,
} from './src/client/protocol';

// 工具适配
export {
  wrapMcpTool,
  buildToolName,
  mapContentBlocks,
  extractText,
  toSuccessResult,
  toErrorResult,
} from './src/adapter';
export type { McpCallFn } from './src/adapter';

// ─── 加载器（Node only）─────────────────────────────────────────
export { loadMcpConfig } from './src/loader';
export type { LoadMcpConfigOptions, LoadMcpConfigResult } from './src/loader';

// ─── 服务端方向（M3）──────────────────────────────────────────
export { McpServerHost, createMcpServerHost } from './src/server/host';
export { runStdioServer } from './src/server/stdio-runner';
export type {
  McpServerHostOptions,
  McpAuthorizeCall,
  McpAuthorizeFn,
} from './src/server/host';
export { mapAgentContentToMcp, toolResultToMcpCallResult } from './src/server/host';

// ─── 服务端协议（纯函数：响应构造 + 入站 params 解析 + resources/prompts）──
export {
  createInitializeResult,
  buildToolsListResult,
  buildToolCallResult,
  buildResourcesListResult,
  buildResourceReadResult,
  buildPromptsListResult,
  buildPromptGetResult,
  parseInitializeParams,
  parseToolCallParams,
  parseListToolsParams,
  parseResourceReadParams,
  parsePromptGetParams,
} from './src/client/protocol';
export type {
  McpResource,
  McpPromptArgument,
  McpPromptMessage,
  McpPrompt,
  McpServerInfoLike,
} from './src/client/protocol';

// ─── 配置 / 诊断类型 ────────────────────────────────────────────
export type {
  McpStdioTransportConfig,
  McpHttpTransportConfig,
  McpSseTransportConfig,
  McpTransportConfig,
  McpServerConfig,
  McpDiagnosticType,
  McpDiagnostic,
  McpPluginOptions,
  McpServerStatus,
} from './src/types';

// ─── 从 @aipack-ai/agent 再导出常用类型（方便单一 import）─────────
export type { Extension, Tool, ToolResult, ContentBlock } from '@aipack-ai/agent';
