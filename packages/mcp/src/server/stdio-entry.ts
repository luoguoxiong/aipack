/**
 * server/stdio-entry.ts - MCP stdio 服务端进程入口（Node only）
 *
 * 读 stdin 行分隔 JSON-RPC → McpServerHost.handleRequest → 写 stdout。
 * 外部 MCP 客户端（Claude Desktop / Cursor）可直接在配置里拉起：
 *
 *   node packages/mcp/dist/server/stdio-entry.js
 *
 * 工具来源（按优先级）：
 *   1. 环境变量 AIPACK_MCP_TOOLS 指向一个 ESM 模块（.js/.mjs/.ts），
 *      其默认导出或具名 `tools` 导出为 Tool[]；
 *   2. 未设置时回退到内置演示工具（echo / add），便于开箱即用与自测。
 *
 * 本文件为进程入口（直接运行即启动 main）；程序化复用循环请 import
 * `runStdioServer` / `createMcpServerHost`（从包主入口 @aipack-ai/mcp）。
 */

import { pathToFileURL } from 'node:url';
import type { Tool } from '@aipack-ai/agent';
import * as jsonrpc from '../client/jsonrpc';
import { createMcpServerHost } from './host';
import { runStdioServer } from './stdio-runner';

// ─── 工具来源解析 ─────────────────────────────────────────────

async function loadToolsFromEnv(): Promise<Tool[]> {
  const p = process.env.AIPACK_MCP_TOOLS;
  if (!p) return DEMO_TOOLS;
  const url = pathToFileURL(p).href;
  const mod = (await import(url)) as { tools?: Tool[]; default?: Tool[] | { tools?: Tool[] } };
  if (Array.isArray(mod.tools)) return mod.tools;
  if (Array.isArray(mod.default)) return mod.default as Tool[];
  if (mod.default && Array.isArray((mod.default as { tools?: Tool[] }).tools)) {
    return (mod.default as { tools: Tool[] }).tools;
  }
  throw new Error(`AIPACK_MCP_TOOLS module "${p}" does not export \`tools\` (Tool[])`);
}

// ─── 内置演示工具（开箱即用 / 自测）──────────────────────────

const DEMO_TOOLS: Tool[] = [
  {
    name: 'echo',
    description: 'Echo back the input text',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'text to echo' } },
      required: ['text'],
    },
    permissions: [],
    async execute(_id: string, args: unknown) {
      const text = String((args as { text?: string } | null)?.text ?? '');
      return { content: [{ type: 'text' as const, text }], details: undefined };
    },
  },
  {
    name: 'add',
    description: 'Add two numbers',
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
    permissions: [],
    async execute(_id: string, args: unknown) {
      const a = Number((args as { a?: number } | null)?.a ?? 0);
      const b = Number((args as { b?: number } | null)?.b ?? 0);
      return { content: [{ type: 'text' as const, text: String(a + b) }], details: undefined };
    },
  },
];

// ─── 进程入口 ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const tools = await loadToolsFromEnv();
  const host = createMcpServerHost({
    name: process.env.AIPACK_MCP_SERVER_NAME ?? 'aipack-mcp',
    version: process.env.AIPACK_MCP_SERVER_VERSION ?? '0.1.0',
    tools,
    // host 主动通知（如 tools/list_changed）→ 即时写 stdout
    onNotification: (n) => {
      process.stdout.write(jsonrpc.serialize(n) + '\n');
    },
  });
  await runStdioServer(host);
}

// 本文件为进程入口：直接运行即启动 main（不做 import.meta.url 主模块判定，
// 以避免打包器把副作用代码 hoist 到共享 chunk 后判定失效）。
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
