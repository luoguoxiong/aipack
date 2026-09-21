import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildRuntime } from '../src/builder.js';
import type { Args } from '../src/args.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const echoFixture = path.resolve(here, '../../mcp/tests/fixtures/echo-server.mjs');

const minimalArgs = {
  safe: false,
  noTools: true,   // 跳过内置工具，聚焦 MCP
  noSession: true, // 临时会话，不落盘
  messages: [],
} as unknown as Args;

async function withMcpConfig(dir: string, servers: Record<string, unknown>) {
  await fs.writeFile(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
}

describe('CLI builder × .mcp.json 接线', () => {
  test('加载 .mcp.json → mcp 插件就绪 → 工具可调用', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-mcp-'));
    await withMcpConfig(cwd, {
      echo: { command: process.execPath, args: [echoFixture] },
    });

    const built = await buildRuntime({
      args: minimalArgs,
      cwd,
      confirmFn: async () => true,
    });

    try {
      assert.ok(built.mcp, 'mcp plugin should be wired when .mcp.json present');
      const diags = await built.mcp.ready();
      assert.equal(diags.length, 0, `unexpected diagnostics: ${JSON.stringify(diags)}`);

      const statuses = built.mcp.registry.getStatus();
      assert.equal(statuses[0].name, 'echo');
      assert.equal(statuses[0].connected, true);
      assert.ok(statuses[0].toolCount >= 2);

      const echo = await built.mcp.registry.callTool('echo', 'echo', { text: 'via-cli' });
      assert.equal(echo.content[0].text, 'via-cli');

      const add = await built.mcp.registry.callTool('echo', 'add', { a: 30, b: 12 });
      assert.equal(add.content[0].text, '42');
    } finally {
      await built.mcp?.dispose().catch(() => {});
      await built.runtime.close();
    }
  });

  test('无 .mcp.json 时 mcp 为 undefined（零影响）', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-mcp-'));
    const built = await buildRuntime({ args: minimalArgs, cwd, confirmFn: async () => true });
    try {
      assert.equal(built.mcp, undefined);
    } finally {
      await built.runtime.close();
    }
  });

  test('http 配置加载（不实际连接，仅校验归一化进 plugin）', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-mcp-'));
    await withMcpConfig(cwd, {
      docs: { type: 'http', url: 'https://mcp.example.invalid/mcp' },
    });
    const built = await buildRuntime({ args: minimalArgs, cwd, confirmFn: async () => true });
    try {
      assert.ok(built.mcp);
      const st = built.mcp.registry.getStatus();
      assert.equal(st[0].transport, 'http');
    } finally {
      await built.mcp?.dispose().catch(() => {});
      await built.runtime.close();
    }
  });
});
