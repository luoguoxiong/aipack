/**
 * extensions/mcp-bridge.ts - MCPBridge Extension
 *
 * 将 AgentGraph 暴露为 MCP (Model Context Protocol) 工具，
 * 使外部 MCP 客户端可以直接调用多 Agent 编排图。
 *
 * 设计原则：不依赖外部 MCP SDK，仅输出符合 MCP 规范的 JSON 结构，
 * 由宿主环境（如 aipack CLI）负责实际的 MCP 传输层。
 */

import type { AgentGraph, MCPBridgeOpts, MultiAgentResult } from '../core/types';
import type { Tool, ToolResult, ContentBlock } from '@aipack-ai/agent';
import { createMcpServerHost } from '@aipack-ai/mcp';
import type { McpServerHost } from '@aipack-ai/mcp';

// ─── MCP 工具定义 ────────────────────────────────────────────────

/** MCP 工具参数定义 */
export interface MCPToolParameter {
  name: string;
  description: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
}

/** MCP 工具定义 */
export interface MCPToolDefinition {
  /** 工具名 */
  name: string;
  /** 工具描述 */
  description: string;
  /** 参数 schema */
  parameters: MCPToolParameter[];
}

/** MCP 工具调用请求 */
export interface MCPToolCallRequest {
  /** 工具名 */
  name: string;
  /** 参数 */
  arguments: Record<string, unknown>;
}

/** MCP 工具调用结果 */
export interface MCPToolCallResult {
  /** 是否错误 */
  isError?: boolean;
  /** 结果内容列表 */
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
}

// ─── MCPBridge ───────────────────────────────────────────────────

/**
 * MCPBridge：将 AgentGraph 注册为 MCP 工具
 *
 * 用法：
 * ```typescript
 * const bridge = new MCPBridge(graph, { toolPrefix: 'ma_' });
 *
 * // 获取工具列表（供 MCP Server 注册）
 * const tools = bridge.listTools();
 *
 * // 处理工具调用
 * const result = await bridge.handleCall({ name: 'ma_run', arguments: { input: '...' } });
 *
 * // M3：经标准 stdio MCP Server 暴露（补齐传输层，供 Claude Desktop 等拉起）
 * import { runStdioServer } from '@aipack-ai/mcp';
 * await runStdioServer(bridge.toMcpServerHost());
 * ```
 *
 * M3 起，run/status 核心逻辑在 handleCall（legacy）与 asTools（统一路径）间共享，
 * 避免与 packages/mcp 的协议实现重复。
 */
export class MCPBridge {
  private graph: AgentGraph;
  private opts: Required<MCPBridgeOpts>;

  constructor(graph: AgentGraph, opts?: MCPBridgeOpts) {
    this.graph = graph;
    this.opts = {
      serverName: opts?.serverName ?? 'aipack-multi-agent',
      serverVersion: opts?.serverVersion ?? '1.0.0',
      toolPrefix: opts?.toolPrefix ?? '',
    };
  }

  /** 获取 MCP Server 信息 */
  getServerInfo() {
    return {
      name: this.opts.serverName,
      version: this.opts.serverVersion,
    };
  }

  /** 列出所有可用 MCP 工具（legacy 形状：MCPToolDefinition[]） */
  listTools(): MCPToolDefinition[] {
    const prefix = this.opts.toolPrefix;

    return [
      {
        name: `${prefix}run`,
        description: '运行多Agent编排图，传入用户输入，返回执行结果',
        parameters: [
          {
            name: 'input',
            description: '用户输入文本',
            type: 'string',
            required: true,
          },
        ],
      },
      {
        name: `${prefix}status`,
        description: '获取当前图执行状态',
        parameters: [],
      },
    ];
  }

  // ─── 核心逻辑（handleCall 与 asTools 共享，单一来源）──────────────

  /** run 工具核心：执行图并序列化为 MCP 形状结果 */
  private async runTool(input: unknown): Promise<MCPToolCallResult> {
    const inputText = input as string | undefined;
    if (!inputText) {
      return {
        isError: true,
        content: [{ type: 'text', text: '缺少必需参数: input' }],
      };
    }

    const result = await this.graph.run(inputText);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: result.success,
            content: result.content,
            lastAgentId: result.lastAgentId,
            stepsCompleted: result.stepsCompleted,
            stopReason: result.stopReason,
            totalUsage: result.totalUsage,
          }, null, 2),
        },
      ],
    };
  }

  /** status 工具核心：图执行状态序列化为 MCP 形状结果 */
  private statusTool(): MCPToolCallResult {
    const state = this.graph.getState();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            currentAgentId: state.currentAgentId,
            stepsCompleted: state.stepsCompleted,
            finished: state.finished,
            error: state.error,
            nodeStates: Object.fromEntries(state.nodeStates),
          }, null, 2),
        },
      ],
    };
  }

  /** 处理 MCP 工具调用（legacy API，行为保持不变） */
  async handleCall(request: MCPToolCallRequest): Promise<MCPToolCallResult> {
    const prefix = this.opts.toolPrefix;
    const runToolName = `${prefix}run`;
    const statusToolName = `${prefix}status`;

    try {
      if (request.name === runToolName) {
        return await this.runTool(request.arguments.input);
      }
      if (request.name === statusToolName) {
        return this.statusTool();
      }
      return {
        isError: true,
        content: [{ type: 'text', text: `未知工具: ${request.name}` }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `执行错误: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  }

  // ─── M3 统一：暴露为 agent 原生 Tool[]，接入 McpServerHost / stdio 传输 ──

  /**
   * 将 AgentGraph 暴露为 agent 原生 `Tool[]`（JSON Schema 参数 + execute）。
   * 可直接喂给 `@aipack-ai/mcp` 的 `createMcpServerHost({ tools })`，
   * 再经 `runStdioServer` 拉起为标准 stdio MCP Server——补齐 MCPBridge
   * 原本缺失的传输层（"由宿主环境负责实际的 MCP 传输" 这一缺口）。
   *
   * 工具 `${prefix}run` / `${prefix}status` 与 legacy `listTools()`/`handleCall()`
   * 共享 `runTool` / `statusTool` 核心，语义一致。
   */
  asTools(): Tool[] {
    const prefix = this.opts.toolPrefix;
    return [
      {
        name: `${prefix}run`,
        description: '运行多Agent编排图，传入用户输入，返回执行结果',
        parameters: {
          type: 'object',
          properties: { input: { type: 'string', description: '用户输入文本' } },
          required: ['input'],
        },
        permissions: [],
        execute: async (_id: string, args: unknown): Promise<ToolResult> => {
          const input = (args as { input?: string } | null)?.input;
          return toToolResult(await this.runTool(input));
        },
      },
      {
        name: `${prefix}status`,
        description: '获取当前图执行状态',
        parameters: { type: 'object', properties: {} },
        permissions: [],
        execute: async (): Promise<ToolResult> => toToolResult(this.statusTool()),
      },
    ];
  }

  /**
   * 构建一个 `McpServerHost`（来自 `@aipack-ai/mcp`），把本 AgentGraph 作为
   * 标准 MCP Server 暴露。配合 `runStdioServer(host)` 即可经 stdin/stdout
   * 服务外部 MCP 客户端（Claude Desktop / Cursor）。
   *
   * 与 legacy `handleCall()` 共享 `runTool` / `statusTool` 核心，保证语义一致。
   */
  toMcpServerHost(): McpServerHost {
    return createMcpServerHost({
      name: this.opts.serverName,
      version: this.opts.serverVersion,
      tools: this.asTools(),
    });
  }
}

/** MCPToolCallResult → agent ToolResult（isError → details.error，对齐 mcp 包约定） */
function toToolResult(r: MCPToolCallResult): ToolResult {
  const isError = r.isError === true;
  return {
    content: r.content as ContentBlock[],
    details: isError ? { error: r.content[0]?.text ?? 'error' } : undefined,
  };
}

// ─── createMCPBridge 工厂函数 ────────────────────────────────────

/** 创建 MCPBridge */
export function createMCPBridge(graph: AgentGraph, opts?: MCPBridgeOpts): MCPBridge {
  return new MCPBridge(graph, opts);
}

/**
 * 便捷工厂：从 AgentGraph 直接构建一个 `McpServerHost`（@aipack-ai/mcp），
 * 供 `runStdioServer(host)` 拉起为标准 stdio MCP Server。
 *
 * ```typescript
 * import { runStdioServer } from '@aipack-ai/mcp';
 * const host = createMultiAgentMcpServerHost(graph, { serverName: 'my-graph' });
 * await runStdioServer(host);
 * ```
 */
export function createMultiAgentMcpServerHost(graph: AgentGraph, opts?: MCPBridgeOpts): McpServerHost {
  return new MCPBridge(graph, opts).toMcpServerHost();
}
