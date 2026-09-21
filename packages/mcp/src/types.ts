/**
 * types.ts - MCP 插件配置与诊断类型（纯数据，零 Node API）
 *
 * 与 skills 包分层约定一致：契约层只含数据形状，不含任何 Node 运行时 API。
 */

// ─── 传输层配置 ─────────────────────────────────────────────────

export interface McpStdioTransportConfig {
  type: 'stdio';
  command: string;
  args?: string[];
  /** 子进程环境变量；值支持 `${VAR}` 展开（对齐 .mcp.json 生态） */
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpTransportConfig {
  /** Streamable HTTP（M2 实现；M1 标注但不可用） */
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export interface McpSseTransportConfig {
  /** legacy SSE（M2） */
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

export type McpTransportConfig =
  | McpStdioTransportConfig
  | McpHttpTransportConfig
  | McpSseTransportConfig;

// ─── 服务端配置 ─────────────────────────────────────────────────

export interface McpServerConfig {
  /** 唯一标识；默认同时作为工具名前缀 */
  name: string;
  transport: McpTransportConfig;
  /** 默认 true；false 时跳过连接（配置文件中保留条目） */
  enabled?: boolean;
  /** 工具名前缀，默认 = name；传空字符串可禁用前缀 */
  toolPrefix?: string;
  /** 工具白名单：只注册匹配的工具（名称为 MCP 原始名） */
  toolFilter?: string[] | ((rawName: string) => boolean);
  /** 该 server 单次调用超时（默认走 runtime 的 toolTimeoutMs） */
  timeoutMs?: number;
  /** 覆盖包装工具的权限标记，默认 ['mcp:<name>'] */
  permissions?: string[];
}

// ─── 诊断 ─────────────────────────────────────────────────────

export type McpDiagnosticType = 'error' | 'warning' | 'collision';

export interface McpDiagnostic {
  type: McpDiagnosticType;
  server: string;
  message: string;
}

// ─── 插件选项 / 状态 ─────────────────────────────────────────────

export interface McpClientInfo {
  name: string;
  version: string;
}

export interface McpPluginOptions {
  /** 外部 MCP Server 配置列表 */
  servers?: McpServerConfig[];
  /** 客户端标识（默认 { name: 'aipack-mcp', version: '0.1.0' }） */
  clientInfo?: McpClientInfo;
  /** 单次请求（initialize / tools/list / tools/call）超时，默认 30s */
  requestTimeoutMs?: number;
}

export interface McpServerStatus {
  name: string;
  enabled: boolean;
  connected: boolean;
  transport: string;
  toolCount: number;
  error?: string;
}
