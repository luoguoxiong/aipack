/**
 * server/http-runner.ts - Streamable HTTP 服务端传输层（Node only，无副作用）
 *
 * MCP 2025-06-18 Streamable HTTP：
 *  - POST endpoint：接收 JSON-RPC（请求 / 通知 / 响应）；响应可走
 *    `application/json` 单条响应 / `text/event-stream` SSE 流 / `202 Accepted`
 *  - GET endpoint（Accept: text/event-stream）：长连，server 主动推消息
 *    （list_changed / ping / sampling 请求）；30s SSE 注释 keepalive
 *  - DELETE endpoint：会话终止（清理 stream + reject 所有 pending 出站请求）
 *  - 首次 initialize 响应头携带 `Mcp-Session-Id`；后续请求头必须携带
 *
 * 出站（server → client）：
 *  - 主动通知（host.onNotification）→ 广播到所有 session 的所有活跃 SSE 流
 *  - 出站请求（host.sampleLLM）→ 经 AsyncLocalStorage 把"当前 session"绑定到
 *    host.handleRequest 调用栈，sampleLLM 触发时拿到 session 并写入该 session 的
 *    一个活跃 GET 流；客户端在 GET 流上收到请求，回写响应（入站响应经 POST 关联
 *    outbound pending 表 resolve）
 *
 * 设计取舍：
 *  - POST 同步返回 JSON/SSE：host 内部 await 工具完成后写响应。耗时 tools/call
 *    会阻塞 POST 直到完成。生产 server 若需"复杂请求 202 + GET 流投递"，可在此
 *    模块后续扩展（现默认阻塞以简化）
 *  - 多 session：每个 session 独立 outboundPending；id 在所有 session 间共享
 *    （outbound id 在 pending 表里有 session 隔离，无冲突）
 *  - 零依赖：Node 18+ node:http + node:async_hooks + node:crypto
 */

import http from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as jsonrpc from '../client/jsonrpc';
import type { McpServerHost } from './host';

// ─── 类型 ─────────────────────────────────────────────────────

export interface McpHttpServerOptions {
  /** endpoint path；默认 `/mcp` */
  endpoint?: string;
  /** listen host；默认 `127.0.0.1` */
  host?: string;
  /** listen port；0 表示随机 */
  port?: number;
  /** 出站请求超时（sampling 等）；默认 60_000ms */
  outboundTimeoutMs?: number;
  /** 自定义 http.Server 工厂（注入 TLS / 鉴权中间件等高级用例）；默认 node:http.createServer */
  createServer?: typeof http.createServer;
  /** listen ready 后回调（拿到实际 port / url） */
  onListening?: (info: { host: string; port: number; url: string }) => void;
}

export interface McpHttpServerHandle {
  /** listen host */
  host: string;
  /** listen port（listen 后为实际分配值） */
  port: number;
  /** endpoint path */
  endpoint: string;
  /** 完整 URL（含 endpoint） */
  url: string;
  /** 启动监听（createMcpHttpServer 返回后需调一次；runHttpServer 已自动调） */
  listen(): Promise<void>;
  /** 关闭 server 并断开所有活跃会话流 */
  close(): Promise<void>;
  /** 底层 http.Server（高级用例：手动 closeAllConnections 等） */
  server: http.Server;
}

// ─── session 内部状态 ────────────────────────────────────────

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Session {
  id: string;
  /** 该 session 当前的活跃 SSE 流（独立 GET 流 + 进行中的 POST 内嵌 SSE） */
  getStreams: Set<http.ServerResponse>;
  /** 该 session 待响应的出站请求（host.sampleLLM 触发） */
  outboundPending: Map<number, Pending>;
  /** GET 流的 keepalive 定时器，close/DELETE 时需清理，避免悬挂句柄 */
  keepaliveTimers: Set<ReturnType<typeof setInterval>>;
}

/** AsyncLocalStorage：把"当前请求所属 session"绑到 host.handleRequest 调用栈 */
const sessionStorage = new AsyncLocalStorage<Session>();

// ─── 工厂 / listen ────────────────────────────────────────────

/**
 * 创建一个未 listen 的 MCP HTTP server 句柄。
 * - 自动注入 host.onNotification（广播）+ host.setOutboundRequest（绑 session）
 * - 调用 `handle.listen()` 启动监听
 */
export function createMcpHttpServer(
  host: McpServerHost,
  options: McpHttpServerOptions = {},
): McpHttpServerHandle {
  const endpoint = options.endpoint ?? '/mcp';
  const listenHost = options.host ?? '127.0.0.1';
  let listenPort = options.port ?? 0;
  const outboundTimeoutMs = options.outboundTimeoutMs ?? 60_000;
  const createServer = options.createServer ?? http.createServer;

  const sessions = new Map<string, Session>();

  // host 主动通知 → 广播到所有 session 的所有流
  host.setOnNotification((msg) => {
    const data = formatSseMessage(msg);
    for (const s of sessions.values()) {
      for (const stream of s.getStreams) {
        try { stream.write(data); } catch { /* 流可能已关 */ }
      }
    }
  });

  // host 出站请求通道：经 AsyncLocalStorage 拿当前 session，写到该 session 的 GET 流
  host.setOutboundRequest((method, params) => {
    const session = sessionStorage.getStore();
    if (!session) {
      throw new Error('outbound request not bound to a session: no AsyncLocalStorage context');
    }
    const id = nextOutboundId++;
    const req = jsonrpc.createRequest(id, method, params);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (session.outboundPending.delete(id)) {
          reject(new Error(`outbound request timeout: ${method} (id=${id})`));
        }
      }, outboundTimeoutMs);
      session.outboundPending.set(id, { resolve, reject, timer });
      const target = pickStream(session);
      if (!target) {
        clearTimeout(timer);
        session.outboundPending.delete(id);
        reject(new Error(`outbound request failed: no active GET stream for session ${session.id}`));
        return;
      }
      try {
        target.write(formatSseMessage(req));
      } catch (err) {
        clearTimeout(timer);
        session.outboundPending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });

  const server = createServer((req, res) => {
    void routeRequest(host, sessions, endpoint, req, res);
  });

  const handle: McpHttpServerHandle = {
    host: listenHost,
    get port() { return listenPort; },
    endpoint,
    get url() { return `http://${listenHost}:${listenPort}${endpoint}`; },
    server,
    close: () => new Promise<void>((resolve) => {
      for (const s of sessions.values()) {
        for (const t of s.keepaliveTimers) clearInterval(t);
        s.keepaliveTimers.clear();
        for (const stream of s.getStreams) {
          try { stream.end(); } catch { /* noop */ }
        }
        for (const p of s.outboundPending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error('server closed'));
        }
      }
      sessions.clear();
      server.close(() => resolve());
      // keep-alive / SSE 长连不会自行断开，必须主动销毁，否则 close 回调永不触发
      try { server.closeAllConnections?.(); } catch { /* noop */ }
    }),
    listen: () => new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenPort, listenHost, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') listenPort = addr.port;
        options.onListening?.({ host: listenHost, port: listenPort, url: handle.url });
        resolve();
      });
    }),
  };

  return handle;
}

/**
 * listen 一个 MCP HTTP server 并返回 handle。
 * - `options.port = 0` → 随机端口（handle.port 为实际分配值）
 */
export function runHttpServer(
  host: McpServerHost,
  options: McpHttpServerOptions = {},
): Promise<McpHttpServerHandle> {
  const handle = createMcpHttpServer(host, options);
  return handle.listen().then(() => handle);
}

// ─── 路由 ──────────────────────────────────────────────────────

async function routeRequest(
  host: McpServerHost,
  sessions: Map<string, Session>,
  endpoint: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = req.url ?? '';
  if (!url.startsWith(endpoint)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }
  const sessionId = stringHeader(req.headers['mcp-session-id']);

  if (req.method === 'POST') return handlePost(host, sessions, req, res, sessionId);
  if (req.method === 'GET') return handleGet(sessions, req, res, sessionId);
  if (req.method === 'DELETE') return handleDelete(sessions, req, res, sessionId);

  res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET, POST, DELETE' });
  res.end('Method Not Allowed');
}

// ─── POST handler ─────────────────────────────────────────────

function handlePost(
  host: McpServerHost,
  sessions: Map<string, Session>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string | undefined,
): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
    }
    res.end();
  });
  req.on('end', () => {
    void onPostEnd(host, sessions, req, res, sessionId, Buffer.concat(chunks).toString('utf8'));
  });
}

async function onPostEnd(
  host: McpServerHost,
  sessions: Map<string, Session>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string | undefined,
  body: string,
): Promise<void> {
  const msg = jsonrpc.parseMessage(body);
  if (!msg) {
    writeJsonError(res, null, jsonrpc.PARSE_ERROR, 'parse error');
    return;
  }

  // 入站响应（client 应答我们发起的 sampling 等）→ 关联 outbound pending
  if (jsonrpc.isResponse(msg)) {
    if (sessionId) {
      const s = sessions.get(sessionId);
      if (s) resolveOutbound(s, msg);
    }
    res.writeHead(202);
    res.end();
    return;
  }

  // 通知 → 不回响应；用 host.handleRequest 让 host 内部能处理 cancelled 等
  if (jsonrpc.isNotification(msg)) {
    const s = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && !s) {
      res.writeHead(202); // 通知失败不致命：客户端可能在 close 之前发了 cancelled
      res.end();
      return;
    }
    if (s) await sessionStorage.run(s, () => host.handleRequest(msg));
    res.writeHead(202);
    res.end();
    return;
  }

  // 请求：先解析 session（initialize 是创建点，其他方法必须已有）
  const reqMsg = msg as jsonrpc.JsonRpcRequest;
  const isInit = reqMsg.method === 'initialize';
  let session: Session;
  if (isInit) {
    session = {
      id: randomUUID(),
      getStreams: new Set(),
      outboundPending: new Map(),
      keepaliveTimers: new Set(),
    };
    sessions.set(session.id, session);
  } else {
    if (!sessionId) {
      writeJsonError(res, reqMsg.id, jsonrpc.INVALID_REQUEST, 'missing Mcp-Session-Id');
      return;
    }
    const found = sessions.get(sessionId);
    if (!found) {
      writeJsonError(res, reqMsg.id, jsonrpc.INVALID_REQUEST, 'unknown session');
      return;
    }
    session = found;
  }

  const accept = stringHeader(req.headers.accept);
  const wantStream = accept.includes('text/event-stream');

  try {
    if (wantStream) {
      // SSE 流：本请求响应 + 后续 server 主动消息
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...(isInit ? { 'Mcp-Session-Id': session.id } : {}),
      });
      session.getStreams.add(res);
      req.on('close', () => { session.getStreams.delete(res); });
      const resp = await sessionStorage.run(session, () => host.handleRequest(reqMsg));
      if (resp) res.write(formatSseMessage(resp));
      // POST 的 SSE 流只承载本请求的响应：写完即结束，否则客户端会一直挂在
      // 流读取上（直至其 requestTimeout 超时）。server 主动消息走独立 GET 流。
      session.getStreams.delete(res);
      res.end();
    } else {
      // JSON 单条响应
      const resp = await sessionStorage.run(session, () => host.handleRequest(reqMsg));
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (isInit) headers['Mcp-Session-Id'] = session.id;
      res.writeHead(200, headers);
      res.end(JSON.stringify(resp));
    }
  } catch (err) {
    if (!res.headersSent) {
      writeJsonError(res, reqMsg.id, jsonrpc.INTERNAL_ERROR, errMessage(err));
    } else {
      try { res.end(); } catch { /* noop */ }
    }
  }
}

// ─── GET handler ──────────────────────────────────────────────

function handleGet(
  sessions: Map<string, Session>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string | undefined,
): void {
  const accept = stringHeader(req.headers.accept);
  if (!accept.includes('text/event-stream')) {
    res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET, POST, DELETE' });
    res.end('Accept must include text/event-stream');
    return;
  }
  if (!sessionId) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('missing Mcp-Session-Id');
    return;
  }
  const session = sessions.get(sessionId);
  if (!session) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('unknown session');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // 立即写一条注释行：既 flush 响应头（否则 client 要等到首个真实事件才拿到
  // headers，无法确认流已就绪），也不被 SSE 客户端当作事件解析
  res.write(': open\n\n');
  session.getStreams.add(res);
  // 30s 注释 keepalive（防中间代理超时）
  const pingTimer = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* noop */ }
  }, 30_000);
  // unref：keepalive 不应阻止进程退出
  pingTimer.unref?.();
  session.keepaliveTimers.add(pingTimer);
  req.on('close', () => {
    clearInterval(pingTimer);
    session.keepaliveTimers.delete(pingTimer);
    session.getStreams.delete(res);
  });
}

// ─── DELETE handler ───────────────────────────────────────────

function handleDelete(
  sessions: Map<string, Session>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string | undefined,
): void {
  if (!sessionId) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('missing Mcp-Session-Id');
    return;
  }
  const session = sessions.get(sessionId);
  if (session) {
    for (const t of session.keepaliveTimers) clearInterval(t);
    session.keepaliveTimers.clear();
    for (const stream of session.getStreams) {
      try { stream.end(); } catch { /* noop */ }
    }
    for (const p of session.outboundPending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('session deleted'));
    }
    sessions.delete(sessionId);
  }
  res.writeHead(204);
  res.end();
}

// ─── helpers ──────────────────────────────────────────────────

/** 所有 session 间共享的出站 id 空间；id 在 pending 表里有 session 隔离，无冲突 */
let nextOutboundId = 1;

function pickStream(session: Session): http.ServerResponse | undefined {
  for (const s of session.getStreams) return s;
  return undefined;
}

function resolveOutbound(session: Session, msg: jsonrpc.JsonRpcResponse): void {
  const id = typeof msg.id === 'number' ? msg.id : Number(msg.id);
  if (!Number.isFinite(id)) return;
  const p = session.outboundPending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  session.outboundPending.delete(id);
  if (jsonrpc.isErrorResponse(msg)) {
    const err = (msg as jsonrpc.JsonRpcErrorResponse).error;
    p.reject(new Error(`${err.message} (code=${err.code})`));
  } else {
    p.resolve((msg as jsonrpc.JsonRpcSuccessResponse).result);
  }
}

function formatSseMessage(msg: jsonrpc.JsonRpcMessage): string {
  return `event: message\ndata: ${jsonrpc.serialize(msg)}\n\n`;
}

function stringHeader(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function writeJsonError(
  res: http.ServerResponse,
  id: jsonrpc.JsonRpcId,
  code: number,
  message: string,
): void {
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(jsonrpc.createErrorResponse(id, code, message)));
}