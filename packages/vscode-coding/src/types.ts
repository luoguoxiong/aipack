/**
 * Webview 消息协议（扩展 ↔ Webview 前端）。
 *
 * WebviewInbound：前端 → 扩展（用户操作）
 * WebviewOutbound：扩展 → 前端（agent 流式事件 + 状态变更）
 */

import { extractText } from '@aipack-ai/agent';
import type { Message } from '@aipack-ai/agent';

// ─── 前端 → 扩展 ────────────────────────────────────────────────────

export type WebviewInbound =
  | { type: 'send'; text: string } // 用户发送消息
  | { type: 'stop' } // 停止当前 run
  | { type: 'clear' } // 清空历史
  | { type: 'ready' }; // 前端就绪，请求回灌历史

// ─── 扩展 → 前端 ────────────────────────────────────────────────────

export type WebviewOutbound =
  | { type: 'userMessage'; text: string } // 回显用户消息（前端也可自行渲染，这里显式推送便于统一）
  | { type: 'chunk'; chunkType: 'text' | 'thinking'; content: string } // 流式增量
  | { type: 'toolStart'; toolName: string; toolCallId?: string } // 工具调用开始
  | {
      type: 'toolEnd';
      toolName: string;
      toolCallId?: string;
      isError: boolean;
    } // 工具调用结束
  | { type: 'status'; running: boolean } // 运行状态变更
  | { type: 'error'; message: string } // 错误
  | { type: 'done' } // 本轮完成
  | { type: 'historyCleared' } // 历史已清空
  | { type: 'history'; messages: SerializedMessage[] }; // 回灌历史消息

/** 可序列化的消息（去掉 timestamp 等非必要字段，保留 role + content） */
export interface SerializedMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

/** 把 aipack Message[] 序列化为前端可渲染的形式 */
export function serializeMessages(messages: Message[]): SerializedMessage[] {
  const out: SerializedMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: extractText(m.content) });
    } else if (m.role === 'assistant') {
      const text = extractText(m.content);
      if (text) out.push({ role: 'assistant', content: text });
    } else if (m.role === 'toolResult') {
      // toolResult 映射到前端的 tool 角色
      out.push({ role: 'tool', content: extractText(m.content) });
    }
    // system 消息不回显
  }
  return out;
}
