import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Tool, ToolResult } from '@aipack-ai/agent';
import { McpClient } from '../src/client/mcp-client';
import { HttpMcpTransport } from '../src/client/http-transport';
import { createMcpServerHost } from '../src/server/host';
import type { McpServerHost } from '../src/server/host';
import { runHttpServer } from '../src/server/http-runner';
import type { McpHttpServerHandle } from '../src/server/http-runner';

// ─── 测试工具 ─────────────────────────────────────────────────

function echoTool(): Tool {
  return {
    name: 'echo',
    description: 'echo back',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    permissions: [],
    async execute(_id: string, args: unknown): Promise<ToolResult> {
      const text = String((args as { text?: string } | null)?.text ?? '');
      return { content: [{ type: 'text', text }], details: undefined };
    },
  };
}

function addTool(): Tool {
  return {
    name: 'add',
    description: 'add two',
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
    permissions: [],
    async execute(_id: string, args: unknown): Promise<ToolResult> {
      const a = Number((args as { a?: number } | null)?.a ?? 0);
      const b = Number((args as { b?: number } | null)?.b ?? 0);
      return { content: [{ type: 'text', text: String(a + b) }], details: undefined };
    },
  };
}

interface ServerFixture {
  host: McpServerHost;
  handle: McpHttpServerHandle;
  url: string;
  close(): Promise<void>;
}

async function startServer(opts?: { sampling?: boolean }): Promise<ServerFixture> {
  const tools: Tool[] = [echoTool(), addTool()];
  const host = createMcpServerHost({
    name: 'aipack-mcp-http-test',
    version: '0.1.0',
    tools,
    sampling: opts?.sampling === true,
  });
  const handle = await runHttpServer(host, { port: 0 });
  return {
    host,
    handle,
    url: handle.url,
    close: async () => {
      await handle.close();
    },
  };
}

function makeClient(url: string, opts?: {
  onSampling?: (p: import('../src/client/protocol').McpCreateMessageParams) =>
    Promise<import('../src/client/protocol').McpCreateMessageResult>;
}): McpClient {
  const transport = new HttpMcpTransport({ url });
  return new McpClient({
    transport,
    clientInfo: { name: 'test-client', version: '0.1.0' },
    requestTimeoutMs: 10_000,
    onSampling: opts?.onSampling,
  });
}

// ─── 握手 / session 头 / 基础方法 ─────────────────────────────

describe('MCP HTTP server：握手 + session 头 + 基本方法', () => {
  test('initialize → protocolVersion + capabilities + Mcp-Session-Id 响应头', async () => {
    const srv = await startServer();
    const client = makeClient(srv.url);
    try {
      const init = await client.connect();
      assert.equal(init.protocolVersion, '2025-06-18');
      assert.equal(init.serverInfo.name, 'aipack-mcp-http-test');
      assert.ok(init.capabilities?.tools !== undefined);
      // resources/prompts 未提供 → 不应 advertise
      assert.equal(init.capabilities?.resources, undefined);
      assert.equal(init.capabilities?.prompts, undefined);
    } finally {
      await client.dispose();
      await srv.close();
    }
  });

  test('tools/list / tools/call 正常路径（application/json Accept）', async () => {
    const srv = await startServer();
    const client = makeClient(srv.url);
    try {
      await client.connect();
      const tools = await client.listTools();
      assert.ok(tools.some((t) => t.name === 'echo'));
      assert.ok(tools.some((t) => t.name === 'add'));

      const echo = await client.callTool('echo', { text: 'hi-http' });
      assert.equal(echo.content[0].text, 'hi-http');
      assert.equal(echo.isError, undefined);

      const add = await client.callTool('add', { a: 5, b: 7 });
      assert.equal(add.content[0].text, '12');
    } finally {
      await client.dispose();
      await srv.close();
    }
  });

  test('未知工具 → isError', async () => {
    const srv = await startServer();
    const client = makeClient(srv.url);
    try {
      await client.connect();
      const r = await client.callTool('nope', {});
      assert.equal(r.isError, true);
    } finally {
      await client.dispose();
      await srv.close();
    }
  });

  test('ping → {}', async () => {
    const srv = await startServer();
    const client = makeClient(srv.url);
    try {
      await client.connect();
      await client.ping(); // 不应抛错
    } finally {
      await client.dispose();
      await srv.close();
    }
  });

  test('未提供 Mcp-Session-Id 的非 initialize 请求 → -32600', async () => {
    const srv = await startServer();
    // 直接 POST tools/list，不先握手
    const transport = new HttpMcpTransport({ url: srv.url });
    const client = new McpClient({
      transport,
      clientInfo: { name: 'no-init', version: '0.1.0' },
    });
    try {
      await assert.rejects(
        () => client.listTools(),
        /Mcp-Session-Id|session/i,
      );
    } finally {
      await client.dispose();
      await srv.close();
    }
  });
});

// ─── POST SSE 响应路径 ───────────────────────────────────────

describe('MCP HTTP server：POST + Accept: text/event-stream', () => {
  test('POST tools/list → SSE 流（含响应事件）', async () => {
    const srv = await startServer();
    // 用 raw fetch 直接发 POST，绕过 McpClient（它默认 application/json）
    const init = await fetch(srv.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'raw', version: '0.1.0' },
        },
      }),
    });
    assert.equal(init.status, 200);
    assert.match(init.headers.get('content-type') ?? '', /text\/event-stream/);
    const sid = init.headers.get('mcp-session-id');
    assert.ok(sid, 'initialize 应返回 Mcp-Session-Id');
    await init.body!.cancel();

    // 再 POST tools/list（带 session）→ SSE 流
    const list = await fetch(srv.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'Mcp-Session-Id': sid,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    assert.equal(list.status, 200);
    assert.match(list.headers.get('content-type') ?? '', /text\/event-stream/);
    const text = await list.text();
    // 至少含一条 message 事件，data 为响应
    assert.match(text, /event: message\ndata: \{[\s\S]*"method":"tools\/list"|"tools":/);
    assert.match(text, /"id":2/);

    await srv.close();
  });

  test('POST 通知 → 202 Accepted（不论 Accept 头）', async () => {
    const srv = await startServer();
    // initialize
    const init = await fetch(srv.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'n', version: '0' } },
      }),
    });
    const sid = init.headers.get('mcp-session-id')!;
    await init.body!.cancel();

    // 通知（notifications/initialized）→ 202
    const n = await fetch(srv.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.equal(n.status, 202);
    await n.body!.cancel();

    await srv.close();
  });
});

// ─── GET 长连 + 主动通知推送 ─────────────────────────────────

describe('MCP HTTP server：GET 长连 + server 主动通知推送', () => {
  test('host.notifyToolsListChanged 经 GET 流推到 client', async () => {
    const srv = await startServer();
    // 1) 拿 session id（先 handshake）
    const initRes = await fetch(srv.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
      }),
    });
    const sid = initRes.headers.get('mcp-session-id');
    assert.ok(sid, 'initialize 应返回 Mcp-Session-Id');
    await initRes.body!.cancel();

    // 2) 开 GET 长连，监听 SSE 事件
    const events: unknown[] = [];
    const got = new Promise<void>((resolve, reject) => {
      const ac = new AbortController();
      const timer = setTimeout(() => reject(new Error('timeout: list_changed not received')), 3000);
      fetch(srv.url, {
        method: 'GET',
        headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': sid },
        signal: ac.signal,
      }).then(async (res) => {
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        // 监听一段时间
        const start = Date.now();
        while (Date.now() - start < 2500) {
          const { value, done } = await Promise.race([
            reader.read(),
            new Promise<{ value: undefined; done: false }>((r) => setTimeout(() => r({ value: undefined, done: false }), 200)),
          ]);
          if (done) break;
          if (value) buf += decoder.decode(value, { stream: true });
          // 解析 \n\n 分隔的事件
          let sep: number;
          while ((sep = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
            if (dataLine) events.push(dataLine.slice(5).replace(/^ /, ''));
          }
          // 命中目标 → resolve
          if (events.some((d) => String(d).includes('list_changed'))) {
            clearTimeout(timer);
            ac.abort();
            resolve();
            return;
          }
        }
        clearTimeout(timer);
        ac.abort();
        reject(new Error('timeout'));
      }).catch((err) => {
        clearTimeout(timer);
        // 中止流导致的 AbortError 视为正常关闭
        if ((err as Error).name === 'AbortError') return;
        reject(err);
      });
    });

    // 3) 触发主动通知
    srv.host.notifyToolsListChanged();

    await got;

    // 断言确实收到 list_changed 通知
    assert.ok(
      events.some((d) => String(d).includes('list_changed')),
      `expected list_changed in events, got: ${JSON.stringify(events)}`,
    );

    await srv.close();
  });
});

// ─── sampling 双向 ───────────────────────────────────────────

describe('MCP HTTP server：sampling 双向', () => {
  test('host.sampleLLM 经 GET 流发 sampling/createMessage，client onSampling 应答', async () => {
    // ask_llm 工具：调 host.sampleLLM → server outbound → client 应答
    const askLlm: Tool = {
      name: 'ask_llm',
      description: 'ask client llm',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      },
      permissions: [],
      async execute(_id: string, args: unknown): Promise<ToolResult> {
        const question = String((args as { question?: string } | null)?.question ?? '');
        // 通过 holder 拿 host
        const host = (globalThis as { __host?: McpServerHost }).__host!;
        try {
          const res = await host.sampleLLM({
            messages: [{ role: 'user', content: { type: 'text', text: question } }],
            maxTokens: 64,
          });
          const text = res.content.type === 'text' ? (res.content.text ?? '') : '';
          return { content: [{ type: 'text', text: `LLM:${text}` }], details: undefined };
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          return { content: [{ type: 'text', text: `sampling failed: ${m}` }], details: { error: m } };
        }
      },
    };

    const host = createMcpServerHost({
      name: 'aipack-mcp-http-sampling',
      version: '0.1.0',
      tools: [askLlm],
      sampling: true,
    });
    (globalThis as { __host?: McpServerHost }).__host = host;
    const handle = await runHttpServer(host, { port: 0 });

    try {
      const client = makeClient(handle.url, {
        onSampling: async (params) => {
          const userText = (params.messages[0].content as { text?: string }).text ?? '';
          return {
            role: 'assistant',
            content: { type: 'text', text: `client-llm:${userText}` },
            model: 'mock-client-llm',
            stopReason: 'endTurn' as const,
          };
        },
      });
      try {
        const init = await client.connect();
        assert.ok(init.capabilities?.sampling !== undefined, 'server 应宣告 sampling');

        // 等 GET 流 ready
        await new Promise((r) => setTimeout(r, 100));

        const res = await client.callTool('ask_llm', { question: 'meaning?' });
        assert.equal(res.isError, undefined);
        assert.equal(res.content[0].text, 'LLM:client-llm:meaning?');
      } finally {
        await client.dispose();
      }
    } finally {
      delete (globalThis as { __host?: McpServerHost }).__host;
      await handle.close();
    }
  });
});

// ─── helpers ─────────────────────────────────────────────────
// (test 文件已直接使用 fetch + SSE 解析，无额外 helper)