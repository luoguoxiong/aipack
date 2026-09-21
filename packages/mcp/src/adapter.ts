/**
 * adapter.ts - MCP 工具 → agent Tool 适配（纯函数）
 *
 * 纯逻辑层，零 Node API：把 McpToolInfo 包装为 agent 原生 Tool，
 * 把 MCP content blocks 映射为 agent ContentBlock，isError 映射为
 * agent "details.error 存在 = 错误结果" 约定（见 agent core/tool-hooks.ts）。
 */

import type {
  Tool,
  ToolResult,
  TextContent,
  ImageContent,
  ContentBlock,
} from '@aipack-ai/agent';
import type { McpServerConfig } from './types';
import type {
  McpToolInfo,
  McpToolCallResult,
  McpContentBlock,
} from './client/protocol';

// ─── 命名 ─────────────────────────────────────────────────────

/** 工具名：`${prefix}__${rawName}`；prefix 为空串则不加前缀 */
export function buildToolName(prefix: string, rawName: string): string {
  return prefix ? `${prefix}__${rawName}` : rawName;
}

// ─── content 映射 ─────────────────────────────────────────────

/**
 * MCP content blocks → agent ContentBlock。
 * agent 的 ContentBlock 仅 text / image / toolCall / thinking 四类，无 resource。
 * 映射规则：
 *   - text   → TextContent(text)
 *   - image  → ImageContent(data, mimeType)（缺字段降级为文本摘要）
 *   - 其余（resource / audio / 未知）→ TextContent（JSON 或 uri 摘要）
 */
export function mapContentBlocks(content: McpContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of content) {
    const mapped = mapOne(block);
    out.push(mapped);
  }
  return out.length ? out : [{ type: 'text', text: '[empty result]' }];
}

function mapOne(block: McpContentBlock): ContentBlock {
  if (block.type === 'text') {
    const text: TextContent = { type: 'text', text: block.text ?? '' };
    return text;
  }
  if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
    const img: ImageContent = { type: 'image', data: block.data, mimeType: block.mimeType };
    return img;
  }
  // resource / audio / 未知：降级为文本摘要，保证前向兼容
  if (block.type === 'resource' && block.resource) {
    const r = block.resource;
    return { type: 'text', text: r.text ?? `[resource: ${r.uri}]` };
  }
  return {
    type: 'text',
    text: `[unsupported content: ${block.type}]`,
  };
}

/** 提取 MCP 结果中的首段文本（用于 details.error 摘要） */
export function extractText(result: McpToolCallResult): string {
  for (const block of result.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return 'MCP tool error';
}

// ─── 结果转换 ─────────────────────────────────────────────────

/** 成功结果：content 映射，details 留空（无 error） */
export function toSuccessResult(result: McpToolCallResult): ToolResult {
  return { content: mapContentBlocks(result.content), details: undefined };
}

/** 错误结果（MCP isError）：details.error 存在 → 命中 agent 错误约定 */
export function toErrorResult(result: McpToolCallResult, serverName: string): ToolResult {
  const msg = extractText(result);
  return {
    content: mapContentBlocks(result.content),
    details: { error: `[mcp:${serverName}] ${msg}` },
  };
}

// ─── 工具包装 ─────────────────────────────────────────────────

export type McpCallFn = (
  rawName: string,
  args: unknown,
  signal?: AbortSignal,
) => Promise<McpToolCallResult>;

/**
 * McpToolInfo → agent Tool：
 *  - name:    `${prefix}__${rawName}`（前缀默认 server name；双下划线分隔）
 *  - description: 保留原始描述，标注 `[mcp:<server>]` 来源
 *  - parameters: inputSchema 原样透传（JSON Schema 与 agent 约定一致）
 *  - permissions: 默认 `['mcp:<server>']`，可被 McpServerConfig.permissions 覆盖
 *  - execute: 调用 call()，content blocks → ToolResult.content，
 *             isError → details.error
 */
export function wrapMcpTool(
  server: McpServerConfig,
  tool: McpToolInfo,
  call: McpCallFn,
): Tool {
  const prefix = server.toolPrefix ?? server.name;
  const permissions = server.permissions ?? [`mcp:${server.name}`];
  const sourceTag = `[mcp:${server.name}]`;
  const description = tool.description
    ? `${tool.description} ${sourceTag}`
    : `MCP tool ${tool.name} ${sourceTag}`;
  const parameters = tool.inputSchema ?? { type: 'object', properties: {} };

  return {
    name: buildToolName(prefix, tool.name),
    description,
    parameters,
    permissions,
    async execute(_toolCallId, args, signal) {
      let result: McpToolCallResult;
      try {
        result = await call(tool.name, args, signal);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `MCP call failed: ${msg}` }],
          details: { error: `[mcp:${server.name}] ${msg}` },
        };
      }
      if (result.isError) return toErrorResult(result, server.name);
      return toSuccessResult(result);
    },
  };
}
