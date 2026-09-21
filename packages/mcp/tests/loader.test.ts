import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadMcpConfig } from '../src/loader';

async function writeConfig(dir: string, file: string, content: unknown): Promise<string> {
  const full = path.join(dir, file);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, JSON.stringify(content));
  return full;
}

describe('loadMcpConfig 归一化', () => {
  test('stdio 条目（无 type）补 type:stdio', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-'));
    await writeConfig(dir, '.mcp.json', {
      mcpServers: { github: { command: 'npx', args: ['-y', 'server-github'], env: { TOKEN: '${GITHUB_TOKEN}' } } },
    });
    const { servers, diagnostics } = await loadMcpConfig({ cwd: dir });
    assert.equal(diagnostics.length, 0);
    assert.equal(servers.length, 1);
    assert.equal(servers[0].name, 'github');
    assert.equal(servers[0].transport.type, 'stdio');
    assert.equal(servers[0].transport.type === 'stdio' && servers[0].transport.command, 'npx');
    assert.equal(servers[0].transport.type === 'stdio' && servers[0].transport.env?.TOKEN, '${GITHUB_TOKEN}');
  });

  test('http 条目取 type+url+headers', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-'));
    await writeConfig(dir, '.mcp.json', {
      mcpServers: { docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${MCP_TOKEN}' } } },
    });
    const { servers } = await loadMcpConfig({ cwd: dir });
    assert.equal(servers[0].transport.type, 'http');
    assert.equal(servers[0].transport.type === 'http' && servers[0].transport.url, 'https://mcp.example.com/mcp');
  });

  test('sse 条目', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-'));
    await writeConfig(dir, '.mcp.json', { mcpServers: { old: { type: 'sse', url: 'https://x/sse' } } });
    const { servers } = await loadMcpConfig({ cwd: dir });
    assert.equal(servers[0].transport.type, 'sse');
  });

  test('缺字段记 error 诊断并跳过', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-'));
    await writeConfig(dir, '.mcp.json', { mcpServers: { bad: { type: 'http' } } });
    const { servers, diagnostics } = await loadMcpConfig({ cwd: dir });
    assert.equal(servers.length, 0);
    assert.ok(diagnostics.some((d) => d.server === 'bad' && d.type === 'error'));
  });

  test('透传 toolFilter / timeoutMs / permissions / enabled', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-'));
    await writeConfig(dir, '.mcp.json', {
      mcpServers: { s: { command: 'node', toolFilter: ['a', 'b'], timeoutMs: 5000, permissions: ['custom'], enabled: false, toolPrefix: '' } },
    });
    const { servers } = await loadMcpConfig({ cwd: dir });
    assert.deepEqual(servers[0].toolFilter, ['a', 'b']);
    assert.equal(servers[0].timeoutMs, 5000);
    assert.deepEqual(servers[0].permissions, ['custom']);
    assert.equal(servers[0].enabled, false);
    assert.equal(servers[0].toolPrefix, '');
  });
});

describe('loadMcpConfig 合并 / 缺省', () => {
  test('项目级覆盖用户级同名 server', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-'));
    const userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-user-'));
    await writeConfig(userDir, 'mcp.json', { mcpServers: { s: { command: 'node-user' }, other: { command: 'node-other' } } });
    await writeConfig(cwd, '.mcp.json', { mcpServers: { s: { command: 'node-proj' } } });
    const { servers } = await loadMcpConfig({ cwd, userDir });
    const s = servers.find((x) => x.name === 's');
    const other = servers.find((x) => x.name === 'other');
    assert.ok(s && s.transport.type === 'stdio' && s.transport.command === 'node-proj');
    assert.ok(other);
  });

  test('无配置文件返回空列表无诊断', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-'));
    const userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-user-'));
    const { servers, diagnostics } = await loadMcpConfig({ cwd, userDir });
    assert.deepEqual(servers, []);
    assert.deepEqual(diagnostics, []);
  });

  test('配置文件 JSON 损坏不抛错（静默跳过）', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-'));
    const full = path.join(cwd, '.mcp.json');
    await fs.writeFile(full, '{not valid json');
    const { servers } = await loadMcpConfig({ cwd });
    assert.deepEqual(servers, []);
  });
});
