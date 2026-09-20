/**
 * server/host.ts - MCP 服务端宿主（Node only，但消息分发逻辑为纯 async）
 *
 * 把 aipack 原生 Tool[] / resources / prompts 反向暴露为标准 MCP Server，
 * 供外部 MCP 客户端（Claude Desktop、Cursor 等）调用。
 *
 * 与 multi-agent/MCPBridge 的关系：泛化而非复制——MCPBridge 保持不动
 * （避免 breaking），本模块提供面向任意 Tool[] 的通用实现；MCPBridge 后续可迁移。
 *
 * 设计：
 *  - 传输层无关：只产 / 解 JSON-RPC 消息，由 stdio-entry / http 入口驱动
 *  - 入站三类消息：响应（不应收到，忽略）、通知（initialized/cancelled，no-op）、
 *    请求（dispatch：initialize / tools/* / resources/* / prompts/* / ping）
 *  - 工具调用经 authorize 钩子裁决（stdio 本地默认放行；可注入 PermissionPolicy 包装）
 *  - agent ToolResult.content → MCP content blocks（text/image 1:1；thinking/toolCall
 *    降级为文本摘要），details.error 存在 → isError
 *  - 未知方法回 -32601；非法 params 内部抛错回 -32603
 */

import type {
  Tool,
  ToolResult,
  ContentBlock,
  TextContent,
  ImageContent,
} from '@aipack-ai/agent';
import * as jsonrpc from '../client/jsonrpc';
import {
  createInitializeResult,
  buildToolsListResult,
  buildToolCallResult,
  buildResourcesListResult,
  buildResourceReadResult,
  buildPromptsListResult,
  buildPromptGetResult,
  parseToolCallParams,
  parseResourceReadParams,
  parsePromptGetParams,
  createListChangedNotification,
  type McpServerCapabilities,
  type McpContentBlock,
  type McpResource,
  type McpPrompt,
  type McpServerInfoLike,
} from '../client/protocol';

// ─── 反向 content 映射（agent ContentBlock → MCP content block）──────────

/**
 * agent ContentBlock → MCP McpContentBlock。
 *  - text  → { type:'text', text }
 *  - image → { type:'image', data, mimeType }（缺 mimeType 降级文本）
 *  - thinking → { type:'text', text }（MCP 无 thinking 概念，透传为文本）
 *  - toolCall → { type:'text', text: JSON }（摘要）
 */
export function mapAgentContentToMcp(blocks: ContentBlock[]): McpContentBlock[] {
  const out: McpContentBlock[] = [];
  for (const b of blocks) {
    out.push(mapOneAgentBlock(b));
  }
  return out.length ? out : [{ type: 'text', text: '[empty result]' }];
}

function mapOneAgentBlock(b: ContentBlock): McpContentBlock {
  if (b.type === 'text') {
    const t = b as TextContent;
    return { type: 'text', text: t.text };
  }
  if (b.type === 'image') {
    const img = b as ImageContent;
    if (typeof img.data === 'string' && typeof img.mimeType === 'string') {
      return { type: 'image', data: img.data, mimeType: img.mimeType };
    }
    return { type: 'text', text: '[image: missing data/mimeType]' };
  }
  // thinking / toolCall：降级为文本摘要
  return { type: 'text', text: JSON.stringify(b) };
}

/** agent ToolResult → MCP tools/call 结果（isError 由 details.error 推导） */
export function toolResultToMcpCallResult(result: ToolResult): { content: McpContentBlock[]; isError?: boolean } {
  const isError = isToolResultError(result);
  return { content: mapAgentContentToMcp(result.content ?? []), isError: isError ? true : undefined };
}

function isToolResultError(result: ToolResult): boolean {
  const d = result.details;
  if (d && typeof d === 'object' && 'error' in (d as Record<string, unknown>)) {
    const e = (d as Record<string, unknown>).error;
    return !!e || typeof e === 'string';
  }
  return false;
}

// ─── 选项 ─────────────────────────────────────────────────────

export interface McpAuthorizeCall {
  /** 工具名 */
  toolName: string;
  /** 工具声明的权限能力 */
  permissions: readonly string[];
  /** 经 prepareArguments 处理后的参数 */
  args: unknown;
}

/**
 * 授权钩子：返回 true 放行、false 拒绝（→ isError 结果）。
 * stdio 本地默认放行（对齐计划"本地拉起默认放行"）；http 场景可注入
 * 包装 PermissionPolicy 的 authorize（check → allow/confirm 视为 true，deny/pending 视为 false）。
 */
export type McpAuthorizeFn = (call: McpAuthorizeCall) => Promise<boolean>;

export interface McpServerHostOptions {
  /** serverInfo.name */
  name: string;
  /** 默认 '0.1.0' */
  version?: string;
  /** 暴露的工具集合（静态数组或动态解析器，支持运行时热变更） */
  tools: Tool[] | (() => Tool[] | Promise<Tool[]>);
  /** 可选 resources（提供则 advertise resources capability 并处理 resources/* ） */
  resources?: McpResource[] | (() => McpResource[] | Promise<McpResource[]>);
  /** 可选 prompts（提供则 advertise prompts capability 并处理 prompts/* ） */
  prompts?: McpPrompt[] | (() => McpPrompt[] | Promise<McpPrompt[]>);
  /** 工具调用授权钩子；缺省放行 */
  authorize?: McpAuthorizeFn;
  /** 单次工具调用超时（默认不设，交由工具自身/runtime） */
  toolTimeoutMs?: number;
  /** 服务端主动发出的通知（如 tools/list_changed）落点；stdio-entry 用以写 stdout */
  onNotification?: (msg: jsonrpc.JsonRpcNotification) => void;
}

// ─── McpServerHost ─────────────────────────────────────────────

/**
 * MCP 服务端宿主。传输层无关——只产 / 解 JSON-RPC 消息。
 *
 * 用法（程序化）：
 *   const host = createMcpServerHost({ name: 'my-agent', tools: [...] });
 *   const resp = await host.handleRequest(parsedRequest);
 *
 * 独立进程入口见 `./stdio-entry.ts`。
 */
export class McpServerHost {
  private serverInfo: McpServerInfoLike;
  private toolsResolver: () => Tool[] | Promise<Tool[]>;
  private resourcesResolver?: () => McpResource[] | Promise<McpResource[]>;
  private promptsResolver?: () => McpPrompt[] | Promise<McpPrompt[]>;
  private authorize?: McpAuthorizeFn;
  private toolTimeoutMs?: number;
  private onNotification?: (msg: jsonrpc.JsonRpcNotification) => void;
  private capabilities: McpServerCapabilities;

  constructor(options: McpServerHostOptions) {
    this.serverInfo = { name: options.name, version: options.version ?? '0.1.0' };
    this.toolsResolver = typeof options.tools === 'function'
      ? options.tools as () => Tool[] | Promise<Tool[]>
      : () => options.tools as Tool[];
    if (options.resources) {
      this.resourcesResolver = typeof options.resources === 'function'
        ? options.resources as () => McpResource[] | Promise<McpResource[]>
        : () => options.resources as McpResource[];
    }
    if (options.prompts) {
      this.promptsResolver = typeof options.prompts === 'function'
        ? options.prompts as () => McpPrompt[] | Promise<McpPrompt[]>
        : () => options.prompts as McpPrompt[];
    }
    this.authorize = options.authorize;
    this.toolTimeoutMs = options.toolTimeoutMs;
    this.onNotification = options.onNotification;
    this.capabilities = this.computeCapabilities();
  }

  getServerInfo(): McpServerInfoLike {
    return { ...this.serverInfo };
  }

  getCapabilities(): McpServerCapabilities {
    return { ...this.capabilities };
  }

  private computeCapabilities(): McpServerCapabilities {
    const caps: Record<string, unknown> = { tools: {} };
    if (this.resourcesResolver) caps.resources = {};
    if (this.promptsResolver) caps.prompts = {};
    return caps as McpServerCapabilities;
  }

  /** 主动通知客户端工具列表已变更 */
  notifyToolsListChanged(): void {
    this.onNotification?.(createListChangedNotification());
  }

  /**
   * 处理一条入站 JSON-RPC 消息。
   * - 请求 → 返回响应（JsonRpcResponse）
   * - 通知 → 返回 null（不回写）
   * - 响应 / 非法消息 → 返回 null
   */
  async handleRequest(input: unknown): Promise<jsonrpc.JsonRpcMessage | null> {
    const msg = jsonrpc.classify(input);
    if (!msg) return null;

    if (jsonrpc.isResponse(msg)) return null; // 服务端不处理客户端响应

    if (jsonrpc.isNotification(msg)) {
      // notifications/initialized / notifications/cancelled：no-op
      return null;
    }

    if (!jsonrpc.isRequest(msg)) return null;
    return this.onRequest(msg as jsonrpc.JsonRpcRequest);
  }

  private async onRequest(req: jsonrpc.JsonRpcRequest): Promise<jsonrpc.JsonRpcMessage> {
    try {
      switch (req.method) {
        case 'initialize':
          return jsonrpc.createSuccessResponse(
            req.id,
            createInitializeResult(this.serverInfo, this.capabilities),
          );
        case 'notifications/initialized':
          return jsonrpc.createSuccessResponse(req.id, {});
        case 'tools/list':
          return jsonrpc.createSuccessResponse(
            req.id,
            buildToolsListResult(await this.toToolInfos(await this.toolsResolver())),
          );
        case 'tools/call':
          return jsonrpc.createSuccessResponse(req.id, await this.handleToolCall(req));
        case 'ping':
          return jsonrpc.createSuccessResponse(req.id, {});
        case 'resources/list':
          if (!this.resourcesResolver) break;
          return jsonrpc.createSuccessResponse(
            req.id,
            buildResourcesListResult(await this.resourcesResolver()),
          );
        case 'resources/read': {
          if (!this.resourcesResolver) break;
          const { uri } = parseResourceReadParams(req.params);
          if (!uri) return jsonrpc.createErrorResponse(req.id, jsonrpc.INVALID_PARAMS, 'resources/read requires uri');
          const found = (await this.resourcesResolver()).find((r) => r.uri === uri);
          if (!found) return jsonrpc.createErrorResponse(req.id, jsonrpc.INVALID_PARAMS, `resource not found: ${uri}`);
          return jsonrpc.createSuccessResponse(req.id, buildResourceReadResult(found));
        }
        case 'prompts/list':
          if (!this.promptsResolver) break;
          return jsonrpc.createSuccessResponse(
            req.id,
            buildPromptsListResult(await this.promptsResolver()),
          );
        case 'prompts/get': {
          if (!this.promptsResolver) break;
          const { name } = parsePromptGetParams(req.params);
          if (!name) return jsonrpc.createErrorResponse(req.id, jsonrpc.INVALID_PARAMS, 'prompts/get requires name');
          const found = (await this.promptsResolver()).find((p) => p.name === name);
          if (!found) return jsonrpc.createErrorResponse(req.id, jsonrpc.INVALID_PARAMS, `prompt not found: ${name}`);
          return jsonrpc.createSuccessResponse(req.id, buildPromptGetResult(found.messages ?? []));
        }
        default:
          break;
      }
      return jsonrpc.createErrorResponse(
        req.id,
        jsonrpc.METHOD_NOT_FOUND,
        `method not found: ${req.method}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonrpc.createErrorResponse(req.id, jsonrpc.INTERNAL_ERROR, message);
    }
  }

  private async handleToolCall(req: jsonrpc.JsonRpcRequest): Promise<unknown> {
    const { name, arguments: args } = parseToolCallParams(req.params);
    if (!name) {
      return buildToolCallResult(
        [{ type: 'text', text: 'tools/call requires name' }],
        true,
      );
    }
    const tools = await this.toolsResolver();
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      return buildToolCallResult(
        [{ type: 'text', text: `unknown tool: ${name}` }],
        true,
      );
    }

    const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;

    // 授权（stdio 本地默认放行）
    if (this.authorize) {
      const allowed = await this.authorize({
        toolName: tool.name,
        permissions: tool.permissions ?? [],
        args: prepared,
      });
      if (!allowed) {
        return buildToolCallResult(
          [{ type: 'text', text: `permission denied: ${tool.name}` }],
          true,
        );
      }
    }

    let result: ToolResult;
    try {
      result = await this.callWithTimeout(tool, prepared);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return buildToolCallResult(
        [{ type: 'text', text: `tool execution failed: ${message}` }],
        true,
      );
    }
    const mapped = toolResultToMcpCallResult(result);
    return buildToolCallResult(mapped.content, mapped.isError);
  }

  private callWithTimeout(tool: Tool, args: unknown): Promise<ToolResult> {
    if (!this.toolTimeoutMs) return tool.execute('mcp', args);
    return new Promise<ToolResult>((resolve, reject) => {
      const ac = new AbortController();
      const timer = setTimeout(() => {
        ac.abort();
        reject(new Error(`tools/call timeout: ${tool.name} (${this.toolTimeoutMs}ms)`));
      }, this.toolTimeoutMs);
      tool.execute('mcp', args, ac.signal).then(
        (r) => { clearTimeout(timer); resolve(r); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  private toToolInfos(tools: Tool[]): Array<{ name: string; description?: string; inputSchema?: unknown }> {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters,
    }));
  }
}

/** 工厂 */
export function createMcpServerHost(options: McpServerHostOptions): McpServerHost {
  return new McpServerHost(options);
}
