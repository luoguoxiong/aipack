/**
 * server/stdio-runner.ts - stdio 消息循环（Node only，无副作用）
 *
 * 驱动一个 McpServerHost 的 stdin/stdout 行分隔 JSON-RPC 循环。
 * 与 stdio-entry.ts 分离：本模块仅含可复用循环，无进程入口副作用，
 * 库用户可直接 import { runStdioServer } 程序化驱动自有 host。
 *
 * 职责：
 *  - stdin 逐行解析 JSON-RPC；非法行忽略
 *  - 入站请求/通知 → host.handleRequest → 有响应则写 stdout；通知 → 不回写
 *  - 入站响应 → 关联到本进程发起的出站请求 pending 表（支持 host.sampleLLM
 *    等服务端→客户端请求；M3 sampling）
 *  - host 经 options.onNotification 发出的主动通知由调用方负责落盘
 *  - host.sampleLLM 经自动注入的出站通道发请求并等待入站响应
 *  - stdin 关闭则 resolve（并拒绝所有 pending 出站请求）
 */

import readline from 'node:readline';
import * as jsonrpc from '../client/jsonrpc';
import type { McpServerHost } from './host';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_OUTBOUND_TIMEOUT_MS = 60_000;

export function runStdioServer(host: McpServerHost): Promise<void> {
  const writeMsg = (m: jsonrpc.JsonRpcMessage): void => {
    process.stdout.write(jsonrpc.serialize(m) + '\n');
  };

  // 出站请求关联：id 分配 + pending 表 + 超时
  let nextOutboundId = 1;
  const outboundPending = new Map<number, Pending>();

  const sendOutboundRequest = (method: string, params?: unknown): Promise<unknown> => {
    const id = nextOutboundId++;
    const req = jsonrpc.createRequest(id, method, params);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (outboundPending.delete(id)) {
          reject(new Error(`outbound request timeout: ${method} (id=${id})`));
        }
      }, DEFAULT_OUTBOUND_TIMEOUT_MS);
      outboundPending.set(id, { resolve, reject, timer });
      writeMsg(req);
    });
  };

  // 注入出站通道，使 host.sampleLLM 可用
  host.setOutboundRequest?.(sendOutboundRequest);

  const resolveOutbound = (m: jsonrpc.JsonRpcResponse): void => {
    const id = typeof m.id === 'number' ? m.id : Number(m.id);
    const p = outboundPending.get(id);
    if (!p) return; // 未知 id（可能是对我们未发起请求的响应，忽略）
    clearTimeout(p.timer);
    outboundPending.delete(id);
    if (jsonrpc.isErrorResponse(m)) {
      const err = (m as jsonrpc.JsonRpcErrorResponse).error;
      p.reject(new Error(`${err.message} (code=${err.code})`));
    } else {
      p.resolve((m as jsonrpc.JsonRpcSuccessResponse).result);
    }
  };

  const rejectAllOutbound = (err: Error): void => {
    for (const [, p] of outboundPending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    outboundPending.clear();
  };

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  return new Promise<void>((resolve) => {
    rl.on('line', (line: string) => {
      if (!line.trim()) return;
      const msg = jsonrpc.parseMessage(line);
      if (!msg) return;
      // 入站响应 → 关联出站 pending；其余交给 host
      if (jsonrpc.isResponse(msg)) {
        resolveOutbound(msg);
        return;
      }
      // 异步处理；响应写回 stdout（handleRequest 内部已 try/catch，不会 reject）
      void host.handleRequest(msg).then((resp) => {
        if (resp) writeMsg(resp);
      }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[mcp-stdio] handleRequest error: ${message}`);
      });
    });
    rl.on('close', () => {
      rejectAllOutbound(new Error('stdio stdin closed'));
      resolve();
    });
  });
}
