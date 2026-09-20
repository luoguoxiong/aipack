/**
 * mcp-client.ts - MCP 客户端会话层（Node only）
 *
 * 职责：
 *  - 持有一个传输层实例（M1: stdio）
 *  - JSON-RPC 请求/响应关联（id 分配 + 超时 + pending 表）
 *  - initialize 握手 + notifications/initialized
 *  - tools/list 分页拉全
 *  - tools/call（带 AbortSignal → notifications/cancelled）
 *  - 处理入站三类消息：响应（关联 pending）、请求（ping → 回 {}）、
 *    通知（tools/list_changed → 回调；notifications/initialized → 标记）
 *  - 惰性重连、dispose 关闭传输层
 *
 * 不含多 server 管理 / 工具注册——那是 McpRegistry 的职责。
 */

import type { McpTransport } from './stdio-transport';
import { StdioMcpTransport } from './stdio-transport';
import { HttpMcpTransport } from './http-transport';
import type { McpTransportConfig } from '../types';
import * as jsonrpc from './jsonrpc';
import {
  createInitializeRequest,
  createInitializedNotification,
  createListToolsRequest,
  createCallToolRequest,
  createPingRequest,
  createCancelledNotification,
  parseInitializeResult,
  parseToolListResponse,
  parseToolCallResult,
  errorResponseToCallResult,
  negotiateProtocol,
  MCP_PROTOCOL_VERSION,
  MCP_BASELINE_VERSION,
  isListChangedNotification,
  type McpClientInfo,
  type McpToolInfo,
  type McpToolCallResult,
  type McpInitializeResult,
  type McpServerCapabilities,
} from './protocol';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface McpClientOptions {
  transport: McpTransport;
  clientInfo: McpClientInfo;
  requestTimeoutMs?: number;
}

export interface CallToolOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * McpClient 的最小接口契约。registry 依赖此接口（而非具体类），
 * 便于注入测试替身（避免子进程）。
 */
export interface McpClientLike {
  connect(): Promise<McpInitializeResult>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: unknown, opts?: CallToolOptions): Promise<McpToolCallResult>;
  setOnListChanged(cb: () => void): void;
  isInitialized(): boolean;
  isDisposed(): boolean;
  dispose(): Promise<void>;
}

export class McpClient implements McpClientLike {
  private transport: McpTransport;
  private clientInfo: McpClientInfo;
  private requestTimeoutMs: number;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private initialized = false;
  private initResult?: McpInitializeResult;
  private capabilities?: McpServerCapabilities;
  private disposed = false;
  private onListChanged?: () => void;

  constructor(opts: McpClientOptions) {
    this.transport = opts.transport;
    this.clientInfo = opts.clientInfo;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.transport.onMessage((m) => this.handleMessage(m));
    this.transport.onError((err) => this.failAll(err));
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  getCapabilities(): McpServerCapabilities | undefined {
    return this.capabilities;
  }

  setOnListChanged(cb: () => void): void {
    this.onListChanged = cb;
  }

  // ─── 请求 / 通知原语 ───────────────────────────────────────

  private sendRequest(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('McpClient disposed'));
    const id = this.nextId++;
    const req = jsonrpc.createRequest(id, method, params);
    const timeout = timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`MCP request timeout: ${method} (id=${id}, ${timeout}ms)`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send(req);
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    if (this.disposed) return;
    this.transport.send(jsonrpc.createNotification(method, params));
  }

  // ─── 握手 ──────────────────────────────────────────────────

  async connect(): Promise<McpInitializeResult> {
    if (this.initialized) return this.initResult!;
    // 握手前启动传输层（HTTP legacy SSE 需先开 GET 流取 endpoint）
    await this.transport.start?.();
    const raw = await this.sendRequest('initialize', undefined).catch((err) => {
      throw new Error(`initialize failed: ${err.message}`);
    });
    // sendRequest 返回的是 result 字段（响应被 handleMessage 拆解后 resolve(result)）
    const init = parseInitializeResult(raw);
    const neg = negotiateProtocol(MCP_PROTOCOL_VERSION, init.protocolVersion);
    if (!neg.ok) {
      throw new Error(
        `protocol mismatch: client=${MCP_PROTOCOL_VERSION}, server=${init.protocolVersion}, baseline=${MCP_BASELINE_VERSION}`,
      );
    }
    this.initResult = init;
    this.capabilities = init.capabilities;
    // 注入协商版本（HTTP 后续请求头携带 MCP-Protocol-Version）
    if (neg.version) this.transport.setProtocolVersion?.(neg.version);
    this.sendNotification('notifications/initialized');
    this.initialized = true;
    return init;
  }

  // ─── 工具 ──────────────────────────────────────────────────

  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    // 防御性上限：避免恶意 server 死循环
    for (let i = 0; i < 100; i++) {
      const raw = await this.sendRequest('tools/list', cursor ? { cursor } : undefined);
      const page = parseToolListResponse(raw);
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: unknown, opts: CallToolOptions = {}): Promise<McpToolCallResult> {
    if (this.disposed) return errorResponseToCallResult('McpClient disposed');

    const id = this.nextId++;
    const req = createCallToolRequest(id, name, args);
    const timeout = opts.timeoutMs ?? this.requestTimeoutMs;

    const onAbort = () => {
      this.transport.send(createCancelledNotification(id, 'client aborted'));
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        // 立即取消，不等响应
        onAbort();
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    try {
      const raw = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error(`tools/call timeout: ${name} (id=${id}, ${timeout}ms)`));
        }, timeout);
        this.pending.set(id, { resolve, reject, timer });
        this.transport.send(req);
      });
      return parseToolCallResult(raw);
    } finally {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    }
  }

  async ping(): Promise<void> {
    await this.sendRequest('ping');
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(new Error('McpClient disposed'));
    await this.transport.close().catch(() => {});
  }

  // ─── 入站消息分发 ──────────────────────────────────────────

  private handleMessage(m: jsonrpc.JsonRpcMessage): void {
    if (jsonrpc.isResponse(m)) {
      this.onResponse(m);
      return;
    }
    if (jsonrpc.isRequest(m)) {
      this.onServerRequest(m);
      return;
    }
    // notification
    if (isListChangedNotification(m as { method?: string })) {
      this.onListChanged?.();
    }
    // notifications/initialized 等：无需处理
  }

  private onResponse(m: jsonrpc.JsonRpcResponse): void {
    const id = typeof m.id === 'number' ? m.id : Number(m.id);
    const p = this.pending.get(id);
    if (!p) return; // 超时或已取消
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (jsonrpc.isErrorResponse(m)) {
      const err = (m as jsonrpc.JsonRpcErrorResponse).error;
      p.reject(new Error(`${err.message} (code=${err.code})`));
    } else {
      p.resolve((m as jsonrpc.JsonRpcSuccessResponse).result);
    }
  }

  private onServerRequest(m: jsonrpc.JsonRpcRequest): void {
    // 至少应答 ping，否则官方 SDK server 会断连；未知方法回 -32601
    if (m.method === 'ping') {
      this.transport.send(jsonrpc.createSuccessResponse(m.id, {}));
      return;
    }
    this.transport.send(
      jsonrpc.createErrorResponse(m.id, jsonrpc.METHOD_NOT_FOUND, `method not found: ${m.method}`),
    );
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

// ─── 传输工厂 ──────────────────────────────────────────────────

/**
 * 按 McpTransportConfig 创建传输层。stdio → spawn 子进程；
 * http → Streamable HTTP；sse → legacy SSE（HttpMcpTransport legacySse）。
 */
export function createTransportFromConfig(cfg: McpTransportConfig): McpTransport {
  if (cfg.type === 'stdio') {
    return new StdioMcpTransport(cfg);
  }
  if (cfg.type === 'http') {
    return new HttpMcpTransport({ url: cfg.url, headers: cfg.headers });
  }
  if (cfg.type === 'sse') {
    return new HttpMcpTransport({ url: cfg.url, headers: cfg.headers, legacySse: true });
  }
  throw new Error(`unknown transport type: ${(cfg as { type: string }).type}`);
}
