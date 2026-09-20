/**
 * server/stdio-runner.ts - stdio 消息循环（Node only，无副作用）
 *
 * 驱动一个 McpServerHost 的 stdin/stdout 行分隔 JSON-RPC 循环。
 * 与 stdio-entry.ts 分离：本模块仅含可复用循环，无进程入口副作用，
 * 库用户可直接 import { runStdioServer } 程序化驱动自有 host。
 *
 * - stdin 逐行解析 JSON-RPC；非法行忽略
 * - 请求 → host.handleRequest → 有响应则写 stdout；通知 → 不回写
 * - host 经 options.onNotification 发出的主动通知由调用方负责落盘
 * - stdin 关闭则 resolve
 */

import readline from 'node:readline';
import * as jsonrpc from '../client/jsonrpc';
import type { McpServerHost } from './host';

export function runStdioServer(host: McpServerHost): Promise<void> {
  const writeMsg = (m: jsonrpc.JsonRpcMessage): void => {
    process.stdout.write(jsonrpc.serialize(m) + '\n');
  };

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  return new Promise<void>((resolve) => {
    rl.on('line', (line: string) => {
      if (!line.trim()) return;
      const msg = jsonrpc.parseMessage(line);
      if (!msg) return;
      // 异步处理；响应写回 stdout（handleRequest 内部已 try/catch，不会 reject）
      void host.handleRequest(msg).then((resp) => {
        if (resp) writeMsg(resp);
      }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[mcp-stdio] handleRequest error: ${message}`);
      });
    });
    rl.on('close', () => resolve());
  });
}
