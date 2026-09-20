import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { McpClient } from '../src/client/mcp-client';
import { HttpMcpTransport } from '../src/client/http-transport';

// ─── 最小 Streamable HTTP MCP server 夹具（node:http，零依赖）──────

interface ServerState {
  port: number;
  close(): Promise<void>;
  /** 收到过的 POST 请求头快照（用于断言 session/protocol 头传播） */
  observedHeaders: http.IncomingHttpHeaders[];
  /** 收到过的 ping 响应计数（client 应答 server 主动 ping） */
  pingReplies: number;
}

function startHttpMcpServer(): Promise<ServerState> {
  const tools = [
    { name: 'echo', description: 'echo back', inputSchema: { type: 'object' } },
    { name: 'add', description: 'add two', inputSchema: { type: 'object' } },
  ];
  const observedHeaders: http.IncomingHttpHeaders[] = [];
  let pingReplies = 0;
  let sessionId: string | undefined;
  let nextServerId = 1;
  const sseClients: http.ServerResponse[] = [];

  const server = http.createServer((req, res) => {
    // GET SSE 长连：周期发 ping 请求
    if (req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      sseClients.push(res);
      const timer = setInterval(() => {
        const id = `s${nextServerId++}`;
        const msg = { jsonrpc: '2.0', id, method: 'ping', params: {} };
        res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
      }, 300);
      req.on('close', () => {
        clearInterval(timer);
        const i = sseClients.indexOf(res);
        if (i >= 0) sseClients.splice(i, 1);
      });
      return;
    }

    // POST
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      observedHeaders.push(req.headers);
      let msg: any;
      try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }

      // 响应（client 回复 server 主动 ping 等）：有 id + result/error，无 method → 202
      // 通知（notifications/initialized / cancelled）：有 method，无 id → 202
      const isResponse = msg.method === undefined && (msg.result !== undefined || msg.error !== undefined);
      const isNotification = msg.method !== undefined && msg.id === undefined;
      if (isResponse || isNotification) {
        if (isResponse) pingReplies++;
        res.writeHead(202);
        res.end();
        return;
      }

      // 请求
      res.setHeader('Content-Type', 'application/json');
      if (msg.method === 'initialize') {
        sessionId = `sess-${Date.now()}`;
        res.setHeader('Mcp-Session-Id', sessionId);
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2025-06-18',
            serverInfo: { name: 'http-echo', version: '1.0.0' },
            capabilities: { tools: { listChanged: true } },
          },
        }));
        return;
      }
      // 后续请求要求携带 session id（spec）
      if (!req.headers['mcp-session-id']) {
        res.writeHead(400);
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'no session' } }));
        return;
      }
      if (msg.method === 'tools/list') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools } }));
        return;
      }
      if (msg.method === 'tools/call') {
        const { name, arguments: args } = msg.params ?? {};
        if (name === 'echo') {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(args?.text ?? '') }] } }));
        } else if (name === 'add') {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(Number(args?.a) + Number(args?.b)) }] } }));
        } else {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'unknown' }] } }));
        }
        return;
      }
      if (msg.method === 'ping') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
        return;
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not found' } }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({
        port,
        observedHeaders,
        get pingReplies() { return pingReplies; },
        close: () => new Promise<void>((r) => {
          // 关闭所有 keep-alive 连接，避免 server.close() 等待
          (server as any).closeAllConnections?.();
          server.close(() => r());
        }),
      });
    });
  });
}

describe('HttpMcpTransport + Streamable HTTP server 端到端', () => {
  test('握手 / session 头传播 / tools/list / tools/call', async () => {
    const srv = await startHttpMcpServer();
    const transport = new HttpMcpTransport({ url: `http://127.0.0.1:${srv.port}/mcp` });
    const client = new McpClient({ transport, clientInfo: { name: 'test', version: '0.1.0' } });
    try {
      const init = await client.connect();
      assert.equal(init.protocolVersion, '2025-06-18');
      assert.equal(init.serverInfo.name, 'http-echo');
      assert.equal(init.capabilities?.tools?.listChanged, true);

      const tools = await client.listTools();
      assert.ok(tools.some((t) => t.name === 'echo'));

      const echo = await client.callTool('echo', { text: 'hi-http' });
      assert.equal(echo.content[0].text, 'hi-http');

      const add = await client.callTool('add', { a: 5, b: 7 });
      assert.equal(add.content[0].text, '12');

      // 等 GET 流投递一个 server ping，client 应答（避免 hang）
      await new Promise((r) => setTimeout(r, 800));
      assert.ok(srv.pingReplies >= 1, `expected client to reply to server ping, got ${srv.pingReplies}`);

      // 断言后续 POST 携带 session id + protocol version 头
      const later = srv.observedHeaders.filter((h) => h['mcp-session-id']);
      assert.ok(later.length >= 2, 'subsequent requests should carry Mcp-Session-Id');
      // initialize 之后至少有一个请求带 MCP-Protocol-Version
      const withVer = srv.observedHeaders.filter((h) => h['mcp-protocol-version']);
      assert.ok(withVer.length >= 1, 'subsequent requests should carry MCP-Protocol-Version');
    } finally {
      await client.dispose();
      await srv.close();
    }
  });

  test('未知工具名返回 isError', async () => {
    const srv = await startHttpMcpServer();
    const transport = new HttpMcpTransport({ url: `http://127.0.0.1:${srv.port}/mcp` });
    const client = new McpClient({ transport, clientInfo: { name: 'test', version: '0.1.0' } });
    try {
      await client.connect();
      const r = await client.callTool('nope', {});
      assert.equal(r.isError, true);
    } finally {
      await client.dispose();
      await srv.close();
    }
  });
});
