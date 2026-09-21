/**
 * stdio-transport.ts - stdio 传输层（Node only）
 *
 * child_process.spawn 拉起外部 MCP Server，stdin/stdout 行分隔 JSON-RPC。
 * stderr 缓冲供诊断；stdio 之外默认 ignore，防止污染 JSON-RPC 通道。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  serialize,
  parseMessage,
  type JsonRpcMessage,
} from './jsonrpc';

export interface McpTransport {
  send(message: JsonRpcMessage): void;
  onMessage(handler: (msg: JsonRpcMessage) => void): void;
  onError(handler: (err: Error) => void): void;
  /** 是否已退出 / 不可用 */
  isClosed(): boolean;
  close(): Promise<void>;
  /** 握手前启动（HTTP legacy SSE 需先开 GET 流取 endpoint；stdio / streamable 可缺省） */
  start?(): Promise<void>;
  /** 握手后注入协商版本（HTTP 后续请求头用；stdio 可缺省） */
  setProtocolVersion?(version: string): void;
}

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export class StdioMcpTransport implements McpTransport {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private messageHandler?: (msg: JsonRpcMessage) => void;
  private errorHandler?: (err: Error) => void;
  private closed = false;
  private closePromise?: Promise<void>;
  private stderrBuf = '';

  constructor(opts: StdioTransportOptions) {
    this.proc = spawn(opts.command, opts.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(opts.env ?? {}) },
      cwd: opts.cwd,
    });
    this.proc.stdout?.setEncoding('utf8');
    this.proc.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    this.proc.stderr?.setEncoding('utf8');
    this.proc.stderr?.on('data', (chunk: string) => {
      this.stderrBuf += chunk;
      // 防止 stderr 无限增长
      if (this.stderrBuf.length > 64 * 1024) {
        this.stderrBuf = this.stderrBuf.slice(-32 * 1024);
      }
    });
    this.proc.on('error', (err) => this.fail(err));
    this.proc.on('exit', (code, signal) => {
      this.closed = true;
      if (!this.closePromise) {
        this.fail(new Error(`MCP server exited (code=${code}, signal=${signal})${this.stderrBuf ? `\nstderr: ${this.stderrBuf.trim()}` : ''}`));
      }
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = parseMessage(line);
      if (msg && this.messageHandler) this.messageHandler(msg);
    }
  }

  private fail(err: Error): void {
    this.closed = true;
    if (this.errorHandler) this.errorHandler(err);
  }

  send(message: JsonRpcMessage): void {
    if (this.closed || !this.proc?.stdin?.writable) {
      this.fail(new Error('MCP transport closed (cannot send)'));
      return;
    }
    this.proc.stdin.write(serialize(message) + '\n');
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
    if (this.closePromise) return this.closePromise;
    if (this.closed) return;
    this.closePromise = new Promise<void>((resolve) => {
      const proc = this.proc;
      if (!proc) return resolve();
      const onExit = () => resolve();
      proc.once('exit', onExit);
      // 给 server 优雅退出窗口，强杀兜底
      proc.stdin?.end();
      const killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* noop */ }
      }, 2000);
      // 不论结果都 resolve（close 不应抛）
      const guard = setTimeout(() => { resolve(); }, 5000);
      // exit 触发后清理
      proc.once('exit', () => {
        clearTimeout(killTimer);
        clearTimeout(guard);
        resolve();
      });
    });
    this.closed = true;
    return this.closePromise;
  }
}
