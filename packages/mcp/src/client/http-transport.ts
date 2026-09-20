/**
 * http-transport.ts - Streamable HTTP + legacy SSE 传输层（Node only）
 *
 * MCP 2025-06-18 Streamable HTTP：
 *  - POST JSON-RPC 到 endpoint；请求头 Accept: application/json, text/event-stream
 *  - initialize 响应头 Mcp-Session-Id → 会话标识，后续请求携带
 *  - 后续请求携带 MCP-Protocol-Version 头
 *  - 响应可能是 application/json（单条 JSON-RPC）或 text/event-stream（SSE 流，
 *    内含本请求的响应 + 可能的 server 主动消息），或 202 Accepted（响应经 GET 流投递）
 *  - GET 长连（Accept: text/event-stream）接收 server 主动消息（ping / list_changed）
 *
 * legacy SSE（type: 'sse'）：GET endpoint → server 发 endpoint 事件给出 POST URL →
 * 后续 POST 到该 URL；消息双向经 SSE 流。降级实现，兼容旧 server。
 *
 * 零依赖：Node 18+ 全局 fetch + 手写 SSE 解析。
 */

import type { McpTransport } from './stdio-transport';
import {
  parseMessage,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from './jsonrpc';

export interface HttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
  /** 单次 POST fetch 超时（默认 60s）；client 侧 pending timer 独立兜底 */
  requestTimeoutMs?: number;
  /** legacy SSE 模式（type: 'sse' 时为 true） */
  legacySse?: boolean;
}

const ACCEPT = 'application/json, text/event-stream';

export class HttpMcpTransport implements McpTransport {
  private url: string;
  private baseHeaders: Record<string, string>;
  private requestTimeoutMs: number;
  private legacySse: boolean;
  private messageHandler?: (msg: JsonRpcMessage) => void;
  private errorHandler?: (err: Error) => void;
  private sessionId?: string;
  private protocolVersion?: string;
  private closed = false;
  private getController?: AbortController;
  private postEndpoint?: string; // legacy SSE: POST URL from `endpoint` event

  constructor(opts: HttpTransportOptions) {
    this.url = opts.url;
    this.baseHeaders = { ...(opts.headers ?? {}) };
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.legacySse = opts.legacySse === true;
  }

  // ─── McpTransport 接口 ───────────────────────────────────────

  send(message: JsonRpcMessage): void {
    if (this.closed) {
      this.fail(new Error('HTTP transport closed'));
      return;
    }
    // 请求：POST 并投递响应
    if ((message as JsonRpcRequest).method !== undefined && (message as JsonRpcRequest).id !== undefined) {
      void this.postRequest(message as JsonRpcRequest);
      return;
    }
    // 通知 / 响应：POST，忽略响应体（202 或空）
    void this.postNotification(message);
  }

  onMessage(handler: (msg: JsonRpcMessage) => void): void {
    this.messageHandler = handler;
  }

  onError(handler: (err: Error) => void): void {
    this.errorHandler = handler;
  }

  isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;
    try { this.getController?.abort(); } catch { /* noop */ }
  }

  /** 握手前启动：legacy SSE 需先开 GET 流取 POST endpoint；Streamable HTTP 无需 */
  async start(): Promise<void> {
    if (this.legacySse) await this.startLegacySse();
  }

  // ─── POST ────────────────────────────────────────────────────

  private buildHeaders(isStream: boolean): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: isStream ? ACCEPT : 'application/json',
      ...this.baseHeaders,
    };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    if (this.protocolVersion) h['MCP-Protocol-Version'] = this.protocolVersion;
    return h;
  }

  private async postRequest(req: JsonRpcRequest): Promise<void> {
    const isInit = req.method === 'initialize';
    const postUrl = this.postEndpoint ?? this.url;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.requestTimeoutMs);
    try {
      const res = await fetch(postUrl, {
        method: 'POST',
        headers: this.buildHeaders(true),
        body: JSON.stringify(req),
        signal: ac.signal,
      });
      // 会话标识（initialize 响应头）
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;

      if (res.status === 202) {
        // 响应将经 GET 流投递；确保 GET 流已启动
        this.ensureGetStream();
        return;
      }
      if (!res.ok) {
        this.fail(new Error(`HTTP ${res.status}: ${await safeText(res)}`));
        return;
      }
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('text/event-stream')) {
        // SSE 流：投递所有事件（含本请求响应 + server 主动消息）
        await this.consumeSse(res, (m) => this.deliver(m));
        if (isInit) this.captureProtocolVersionFromInit(req);
        this.ensureGetStream();
      } else {
        // JSON 单条响应
        const msg = parseMessage(await safeText(res));
        if (msg) {
          this.deliver(msg);
          if (isInit) this.captureProtocolVersion(msg);
        }
        if (isInit) this.ensureGetStream();
      }
    } catch (err) {
      if (!this.closed) this.fail(err instanceof Error ? err : new Error(String(err)));
    } finally {
      clearTimeout(timer);
    }
  }

  private async postNotification(message: JsonRpcMessage): Promise<void> {
    const postUrl = this.postEndpoint ?? this.url;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.requestTimeoutMs);
    try {
      await fetch(postUrl, {
        method: 'POST',
        headers: this.buildHeaders(false),
        body: JSON.stringify(message),
        signal: ac.signal,
      });
    } catch (err) {
      // 通知失败不致命（cancelled / initialized），仅告警
      if (!this.closed) this.errorHandler?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      clearTimeout(timer);
    }
  }

  /** 从 initialize JSON 响应提取 protocolVersion，用于后续请求头 */
  private captureProtocolVersion(msg: JsonRpcMessage): void {
    const r = (msg as { result?: { protocolVersion?: string } }).result;
    if (r && typeof r.protocolVersion === 'string') this.protocolVersion = r.protocolVersion;
  }

  /** SSE 响应路径下 initialize 的版本捕获：响应已通过 deliver 投递，此处仅兜底（无法从流元数据拿） */
  private captureProtocolVersionFromInit(_req: JsonRpcRequest): void {
    // SSE 模式下 protocolVersion 在已 deliver 的 initialize 响应 result 中；
    // 由 McpClient.connect() 解析后经 setProtocolVersion 设置（见下）
  }

  /** 由 McpClient 在握手后注入协商版本，供后续请求头使用 */
  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  // ─── GET 长连（server 主动消息）──────────────────────────────

  private getStreamStarted = false;
  private ensureGetStream(): void {
    if (this.getStreamStarted || this.closed) return;
    this.getStreamStarted = true;
    this.getController = new AbortController();
    void this.runGetStream();
  }

  private async runGetStream(): Promise<void> {
    const getUrl = this.url;
    while (!this.closed) {
      const ac = this.getController!;
      try {
        const res = await fetch(getUrl, {
          method: 'GET',
          headers: { Accept: 'text/event-stream', ...this.baseHeaders, ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}) },
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          // 旧 server 不支持 GET 流 → 静默退出（不致命，主动消息将缺失）
          return;
        }
        await this.consumeSse(res, (m) => this.deliver(m));
        // 流自然结束 → 重连（简单退避）
        if (this.closed) return;
        await new Promise((r) => setTimeout(r, 1000));
      } catch (err) {
        if (this.closed) return;
        // abort 或网络错误 → 退避后重试
        void err;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  // ─── legacy SSE ──────────────────────────────────────────────

  /** legacy SSE：GET endpoint 流，首事件 `endpoint` 给出 POST URL */
  async startLegacySse(): Promise<void> {
    this.getController = new AbortController();
    try {
      const res = await fetch(this.url, {
        method: 'GET',
        headers: { Accept: 'text/event-stream', ...this.baseHeaders },
        signal: this.getController.signal,
      });
      if (!res.ok || !res.body) {
        this.fail(new Error(`legacy SSE GET failed: HTTP ${res.status}`));
        return;
      }
      await this.consumeSse(res, (m) => {
        // legacy: `endpoint` 事件给出 POST URL；JSON 消息直接投递
        this.deliver(m);
      });
    } catch (err) {
      if (!this.closed) this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ─── SSE 解析 ────────────────────────────────────────────────

  private async consumeSse(
    res: Response,
    onMessage: (msg: JsonRpcMessage) => void,
  ): Promise<void> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const { event, data } = parseSseEvent(rawEvent);
          // legacy SSE：`endpoint` 事件给出 POST URL
          if (this.legacySse && event === 'endpoint' && data) {
            this.postEndpoint = new URL(data, this.url).href;
            continue;
          }
          if (data) {
            const msg = parseMessage(data);
            if (msg) onMessage(msg);
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* noop */ }
    }
  }

  // ─── 投递 / 失败 ─────────────────────────────────────────────

  private deliver(msg: JsonRpcMessage): void {
    if (this.messageHandler) this.messageHandler(msg);
  }

  private fail(err: Error): void {
    this.closed = true;
    if (this.errorHandler) this.errorHandler(err);
  }
}

// ─── 辅助 ─────────────────────────────────────────────────────

function parseSseEvent(raw: string): { event: string; data: string } {
  let event = '';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  return { event, data: dataLines.join('\n') };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** 按 config 工厂：http / sse → HttpMcpTransport（legacy） */
export function createHttpTransport(opts: HttpTransportOptions): McpTransport {
  return new HttpMcpTransport(opts);
}
