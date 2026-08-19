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
 * ```
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

  /** 列出所有可用 MCP 工具 */
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

  /** 处理 MCP 工具调用 */
  async handleCall(request: MCPToolCallRequest): Promise<MCPToolCallResult> {
    const prefix = this.opts.toolPrefix;
    const runTool = `${prefix}run`;
    const statusTool = `${prefix}status`;

    try {
      if (request.name === runTool) {
        const input = request.arguments.input as string;
        if (!input) {
          return {
            isError: true,
            content: [{ type: 'text', text: '缺少必需参数: input' }],
          };
        }

        const result = await this.graph.run(input);
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

      if (request.name === statusTool) {
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
}

// ─── createMCPBridge 工厂函数 ────────────────────────────────────

/** 创建 MCPBridge */
export function createMCPBridge(graph: AgentGraph, opts?: MCPBridgeOpts): MCPBridge {
  return new MCPBridge(graph, opts);
}
