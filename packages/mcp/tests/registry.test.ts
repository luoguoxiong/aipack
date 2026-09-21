import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { McpRegistry } from '../src/registry';
import type { McpClientFactory } from '../src/registry';
import type { McpClientLike, CallToolOptions } from '../src/client/mcp-client';
import type { McpToolInfo, McpToolCallResult, McpInitializeResult } from '../src/client/protocol';
import type { McpServerConfig } from '../src/types';

// ─── 测试替身 ─────────────────────────────────────────────────

interface StubOptions {
  tools?: McpToolInfo[];
  connectThrows?: Error;
  callResult?: McpToolCallResult;
}

function makeStubClient(opts: StubOptions = {}): McpClientLike {
  const tools = opts.tools ?? [];
  let disposed = false;
  let listChangedCb: (() => void) | undefined;
  return {
    async connect(): Promise<McpInitializeResult> {
      if (opts.connectThrows) throw opts.connectThrows;
      return {
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'stub', version: '1.0.0' },
        capabilities: { tools: { listChanged: true } },
      };
    },
    async listTools(): Promise<McpToolInfo[]> {
      return [...tools];
    },
    async callTool(name: string, _args: unknown, _o?: CallToolOptions): Promise<McpToolCallResult> {
      return opts.callResult ?? { content: [{ type: 'text', text: `stub:${name}` }] };
    },
    setOnListChanged(cb: () => void) {
      listChangedCb = cb;
    },
    isInitialized() {
      return true;
    },
    isDisposed() {
      return disposed;
    },
    async dispose() {
      disposed = true;
    },
  };
}

function makeStubFactory(stubFor: (cfg: McpServerConfig) => StubOptions): McpClientFactory {
  return (cfg) => makeStubClient(stubFor(cfg));
}

/** 最小 Runtime 替身：收集 registerTool / unregisterTool 调用 */
function makeStubRuntime() {
  const registered = new Map<string, { name: string; permissions?: string[]; execute?: unknown }>();
  return {
    registered,
    registerTool(tool: { name: string; permissions?: string[]; execute?: unknown }) {
      registered.set(tool.name, { name: tool.name, permissions: tool.permissions, execute: tool.execute });
    },
    unregisterTool(name: string) {
      return registered.delete(name);
    },
  };
}

function stdioCfg(name: string, over: Partial<McpServerConfig> = {}): McpServerConfig {
  return { name, transport: { type: 'stdio', command: 'node' }, ...over };
}

// ─── 用例 ─────────────────────────────────────────────────────

describe('McpRegistry 多 server 合并 / 冲突 / 过滤', () => {
  test('多 server 工具合并注册进 runtime', async () => {
    const rt = makeStubRuntime();
    const reg = new McpRegistry(
      {
        servers: [
          stdioCfg('a'),
          stdioCfg('b'),
        ],
      },
      makeStubFactory((cfg) => ({
        tools: cfg.name === 'a' ? [{ name: 'echo' }, { name: 'add' }] : [{ name: 'get' }],
      })),
    );
    reg.bindRuntime(rt as never);
    await reg.ensureConnected();
    assert.ok(rt.registered.has('a__echo'));
    assert.ok(rt.registered.has('a__add'));
    assert.ok(rt.registered.has('b__get'));
  });

  test('同名工具跨 server 默认前缀不冲突', async () => {
    const rt = makeStubRuntime();
    const reg = new McpRegistry(
      { servers: [stdioCfg('a'), stdioCfg('b')] },
      makeStubFactory(() => ({ tools: [{ name: 'echo' }] })),
    );
    reg.bindRuntime(rt as never);
    await reg.ensureConnected();
    assert.ok(rt.registered.has('a__echo'));
    assert.ok(rt.registered.has('b__echo'));
  });

  test('同 server + 显式空前缀导致跨工具同名 → 幂等去重不重复注册', async () => {
    const rt = makeStubRuntime();
    const reg = new McpRegistry(
      {
        servers: [
          { ...stdioCfg('a'), toolPrefix: '' },
          { ...stdioCfg('b'), toolPrefix: '' },
        ],
      },
      makeStubFactory(() => ({ tools: [{ name: 'echo' }] })),
    );
    reg.bindRuntime(rt as never);
    await reg.ensureConnected();
    // 两个 server 都产 echo（无前缀），registered 仅一份（幂等）
    assert.ok(rt.registered.has('echo'));
    assert.equal(rt.registered.size, 1);
  });

  test('toolFilter 白名单生效', async () => {
    const rt = makeStubRuntime();
    const reg = new McpRegistry(
      { servers: [{ ...stdioCfg('a'), toolFilter: ['echo'] }] },
      makeStubFactory(() => ({ tools: [{ name: 'echo' }, { name: 'add' }, { name: 'drop' }] })),
    );
    reg.bindRuntime(rt as never);
    await reg.ensureConnected();
    assert.ok(rt.registered.has('a__echo'));
    assert.ok(!rt.registered.has('a__add'));
    assert.ok(!rt.registered.has('a__drop'));
  });

  test('toolFilter 函数形式生效', async () => {
    const rt = makeStubRuntime();
    const reg = new McpRegistry(
      { servers: [{ ...stdioCfg('a'), toolFilter: (n) => n.startsWith('a') }] },
      makeStubFactory(() => ({ tools: [{ name: 'add' }, { name: 'apple' }, { name: 'echo' }] })),
    );
    reg.bindRuntime(rt as never);
    await reg.ensureConnected();
    assert.ok(rt.registered.has('a__add'));
    assert.ok(rt.registered.has('a__apple'));
    assert.ok(!rt.registered.has('a__echo'));
  });
});

describe('McpRegistry 连接失败 / 环境变量 / 诊断', () => {
  test('单 server 连接失败不阻断其他 server', async () => {
    const rt = makeStubRuntime();
    const reg = new McpRegistry(
      { servers: [stdioCfg('bad'), stdioCfg('good')] },
      makeStubFactory((cfg) => ({
        tools: cfg.name === 'good' ? [{ name: 'ok' }] : [],
        connectThrows: cfg.name === 'bad' ? new Error('boom') : undefined,
      })),
    );
    reg.bindRuntime(rt as never);
    const diags = await reg.ensureConnected();
    assert.ok(diags.some((d) => d.server === 'bad' && d.type === 'error' && d.message.includes('boom')));
    assert.ok(rt.registered.has('good__ok'));
  });

  test('env 变量未定义 → 该 server 跳过并记 error 诊断', async () => {
    const rt = makeStubRuntime();
    // 临时令某环境变量未定义
    const saved = process.env.MCP_TEST_MISSING;
    delete process.env.MCP_TEST_MISSING;
    const reg = new McpRegistry(
      {
        servers: [
          { name: 'needsenv', transport: { type: 'stdio', command: 'node', env: { TOKEN: '${MCP_TEST_MISSING}' } } },
        ],
      },
      makeStubFactory(() => ({ tools: [{ name: 'x' }] })),
    );
    reg.bindRuntime(rt as never);
    const diags = await reg.ensureConnected();
    assert.ok(diags.some((d) => d.server === 'needsenv' && d.message.includes('MCP_TEST_MISSING')));
    assert.equal(rt.registered.size, 0);
    process.env.MCP_TEST_MISSING = saved;
  });

  test('enabled=false 的 server 跳过', async () => {
    const rt = makeStubRuntime();
    const reg = new McpRegistry(
      { servers: [{ ...stdioCfg('off'), enabled: false }, stdioCfg('on')] },
      makeStubFactory((cfg) => ({ tools: cfg.name === 'on' ? [{ name: 'ok' }] : [] })),
    );
    reg.bindRuntime(rt as never);
    await reg.ensureConnected();
    assert.ok(!rt.registered.has('off__ok'));
    assert.ok(rt.registered.has('on__ok'));
  });
});

describe('McpRegistry callTool / refresh / dispose', () => {
  test('callTool 分发到对应 server 并返回结果', async () => {
    const reg = new McpRegistry(
      { servers: [stdioCfg('a')] },
      makeStubFactory(() => ({
        tools: [{ name: 'echo' }],
        callResult: { content: [{ type: 'text', text: 'pong' }] },
      })),
    );
    await reg.ensureConnected();
    const r = await reg.callTool('a', 'echo', { text: 'ping' });
    assert.equal(r.content[0].text, 'pong');
    assert.equal(r.isError, undefined);
  });

  test('callTool 未知 server 返回 isError', async () => {
    const reg = new McpRegistry({ servers: [] });
    await reg.ensureConnected();
    const r = await reg.callTool('nope', 'echo', {});
    assert.equal(r.isError, true);
    assert.match(r.content[0].text ?? '', /not connected/);
  });

  test('ensureConnected 幂等：多次调用只连接一次', async () => {
    let connects = 0;
    const reg = new McpRegistry(
      { servers: [stdioCfg('a')] },
      (() => {
        const inner = makeStubClient({ tools: [{ name: 'echo' }] });
        return {
          connect: async () => { connects++; return await inner.connect(); },
          listTools: (n: never) => Promise.resolve(n as unknown as McpToolInfo[]) && inner.listTools(),
          callTool: (a: string, b: unknown, c?: CallToolOptions) => inner.callTool(a, b, c),
          setOnListChanged: (cb: () => void) => inner.setOnListChanged(cb),
          isInitialized: () => inner.isInitialized(),
          isDisposed: () => inner.isDisposed(),
          dispose: () => inner.dispose(),
        } as unknown as McpClientLike;
      }) as McpClientFactory,
    );
    await reg.ensureConnected();
    await reg.ensureConnected();
    assert.equal(connects, 1);
  });

  test('refresh 注册新增工具并移除已消失工具（完整移除）', async () => {
    const rt = makeStubRuntime();
    const tools: McpToolInfo[] = [{ name: 'echo' }, { name: 'add' }];
    const reg = new McpRegistry(
      { servers: [stdioCfg('a')] },
      makeStubFactory(() => ({ tools })),
    );
    reg.bindRuntime(rt as never);
    await reg.ensureConnected();
    assert.ok(rt.registered.has('a__echo'));
    assert.ok(rt.registered.has('a__add'));
    // 模拟 server 端工具列表变更：移除 add、新增 mul
    tools.splice(1, 1, { name: 'mul' });
    await reg.refresh();
    assert.ok(rt.registered.has('a__echo'));
    assert.ok(!rt.registered.has('a__add'), 'add should be unregistered');
    assert.ok(rt.registered.has('a__mul'), 'mul should be registered');
  });

  test('refresh 新增工具（无移除场景）', async () => {
    const rt = makeStubRuntime();
    const tools: McpToolInfo[] = [{ name: 'echo' }];
    const reg = new McpRegistry(
      { servers: [stdioCfg('a')] },
      makeStubFactory(() => ({ tools })),
    );
    reg.bindRuntime(rt as never);
    await reg.ensureConnected();
    // 模拟 server 端新增工具
    tools.push({ name: 'add' });
    await reg.refresh();
    assert.ok(rt.registered.has('a__echo'));
    assert.ok(rt.registered.has('a__add'));
  });

  test('dispose 后状态清空', async () => {
    const reg = new McpRegistry(
      { servers: [stdioCfg('a')] },
      makeStubFactory(() => ({ tools: [{ name: 'echo' }] })),
    );
    await reg.ensureConnected();
    await reg.dispose();
    assert.equal(reg.getStatus()[0].connected, false);
  });
});
