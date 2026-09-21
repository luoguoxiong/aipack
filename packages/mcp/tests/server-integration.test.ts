import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient } from '../src/client/mcp-client';
import { StdioMcpTransport } from '../src/client/stdio-transport';
import type { McpCreateMessageParams, McpCreateMessageResult } from '../src/client/protocol';

const here = path.dirname(fileURLToPath(import.meta.url));
const entryPath = path.resolve(here, '../src/server/stdio-entry.ts');
const mcpPkgDir = path.resolve(here, '..');
const toolsFixture = path.resolve(here, 'fixtures/server-tools.mjs');

// 拉起 stdio-entry.ts 作为外部 MCP Server（经 tsx 加载 TS 入口）。
// 复用客户端 StdioMcpTransport：command = node，args = ['--import','tsx', entry]。
function makeServerClient(
  env: Record<string, string> = {},
  timeoutMs = 10_000,
  onSampling?: (p: McpCreateMessageParams) => Promise<McpCreateMessageResult>,
) {
  const transport = new StdioMcpTransport({
    command: process.execPath,
    args: ['--import', 'tsx', entryPath],
    cwd: mcpPkgDir,
    env: { ...process.env, ...env },
  });
  return new McpClient({
    transport,
    clientInfo: { name: 'aipack-mcp-test', version: '0.1.0' },
    requestTimeoutMs: timeoutMs,
    onSampling,
  });
}

describe('MCP server（stdio-entry）端到端：内置 demo 工具', () => {
  test('initialize / tools/list / tools/call / ping / unknown', async () => {
    const client = makeServerClient();
    try {
      const init = await client.connect();
      assert.equal(init.protocolVersion, '2025-06-18');
      assert.equal(init.serverInfo.name, 'aipack-mcp');
      assert.ok(init.capabilities?.tools !== undefined);

      const tools = await client.listTools();
      assert.ok(tools.some((t) => t.name === 'echo'));
      assert.ok(tools.some((t) => t.name === 'add'));

      const echoRes = await client.callTool('echo', { text: 'hi' });
      assert.equal(echoRes.content[0].text, 'hi');
      assert.equal(echoRes.isError, undefined);

      const addRes = await client.callTool('add', { a: 2, b: 3 });
      assert.equal(addRes.content[0].text, '5');

      // 未知工具 → isError
      const nope = await client.callTool('nope', {});
      assert.equal(nope.isError, true);
      assert.match(nope.content[0].text ?? '', /unknown tool/);

      // client→server ping 应答 {}
      await client.ping();
    } finally {
      await client.dispose();
    }
  });
});

describe('MCP server（stdio-entry）端到端：AIPACK_MCP_TOOLS 加载外部工具', () => {
  test('加载 server-tools.mjs 的 greet 工具并调用', async () => {
    const client = makeServerClient({ AIPACK_MCP_TOOLS: toolsFixture });
    try {
      const init = await client.connect();
      assert.equal(init.serverInfo.name, 'aipack-mcp');

      const tools = await client.listTools();
      assert.ok(tools.some((t) => t.name === 'greet'));
      assert.ok(!tools.some((t) => t.name === 'echo'), 'demo 工具不应出现');

      const res = await client.callTool('greet', { name: 'aipack' });
      assert.equal(res.content[0].text, 'hello aipack');
      assert.equal(res.isError, undefined);
    } finally {
      await client.dispose();
    }
  });
});

describe('MCP server（stdio-entry）端到端：sampling 双向', () => {
  test('server 宣告 sampling 能力；ask_llm 经 server→client 采样返回结果', async () => {
    const client = makeServerClient({}, 10_000, async (params) => {
      // 客户端应答 server 的 sampling/createMessage
      const userText = (params.messages[0].content as { text?: string }).text ?? '';
      return {
        role: 'assistant',
        content: { type: 'text', text: `LLM:${userText}` },
        model: 'mock-client-llm',
        stopReason: 'endTurn' as const,
      };
    });
    try {
      const init = await client.connect();
      assert.ok(init.capabilities?.sampling !== undefined, 'server 应宣告 sampling 能力');

      const tools = await client.listTools();
      assert.ok(tools.some((t) => t.name === 'ask_llm'), 'demo 应含 ask_llm');

      // 调用 ask_llm → server 经 sampleLLM 向本客户端发 sampling/createMessage
      // → 本客户端 onSampling 应答 → server 返回工具结果
      const res = await client.callTool('ask_llm', { question: 'meaning of life?' });
      assert.equal(res.isError, undefined);
      assert.equal(res.content[0].text, 'LLM:meaning of life?');
    } finally {
      await client.dispose();
    }
  });

  test('未配置 onSampling 时 ask_llm → isError（server 采样被拒）', async () => {
    const client = makeServerClient(); // 无 onSampling
    try {
      await client.connect();
      const res = await client.callTool('ask_llm', { question: 'q' });
      assert.equal(res.isError, true);
      assert.match(res.content[0].text ?? '', /sampling/);
    } finally {
      await client.dispose();
    }
  });
});
