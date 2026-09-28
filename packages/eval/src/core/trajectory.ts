/**
 * packages/eval/src/core/trajectory.ts - 工具调用轨迹提取
 *
 * Result.toolsUsed 只有去重的工具名；完整轨迹（名称 / 参数 / 顺序 /
 * isError）从 runtime.getMessages() 返回的会话消息重建：
 *   - assistant 消息的 toolCall 块 → 调用记录（按消息顺序）
 *   - toolResult 消息 → 按 toolCallId 回填 isError
 */

import type { Message, ToolCallContent } from '@aipack-ai/agent';
import type { ToolCallRecord } from './types';

export function extractTrajectory(messages: Message[]): ToolCallRecord[] {
  const records: ToolCallRecord[] = [];
  const errorById = new Map<string, boolean>();

  for (const msg of messages) {
    if (msg.role === 'toolResult') {
      const toolMsg = msg as {
        role: 'toolResult';
        toolCallId: string;
        isError: boolean;
      };
      errorById.set(toolMsg.toolCallId, toolMsg.isError);
    }
  }

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type !== 'toolCall') continue;
      const call = block as ToolCallContent;
      records.push({
        id: call.id,
        name: call.name,
        args: call.arguments,
        isError: errorById.get(call.id),
      });
    }
  }

  return records;
}

/** 统计 assistant 轮数（对话深度，不含 toolResult 消息） */
export function countTurns(messages: Message[]): number {
  return messages.filter((m) => m.role === 'assistant').length;
}
