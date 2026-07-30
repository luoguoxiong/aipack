/**
 * L5 紧急压缩 - 极限有损压缩
 *
 * 当上下文即将溢出时执行，只保留：
 * 1. 最小化状态快照（仅含目标、当前错误、关键约束）
 * 2. 最后 N 条消息（由 config.recent_keep 控制，默认 2 条）
 * 3. 系统提示词
 * 4. 简短紧急过渡消息
 *
 * 这是最后一道防线，确保模型不会丢失全部上下文。
 */

import type { AgentMessage } from '../../agent';
import type { AgentState, L5EmergencyConfig } from '../types';
import { SnapshotBuilder } from '../state/snapshot-builder';
import { isStateSnapshot, isCustomMessage } from '../state/message-adapter';

/** L5 紧急结果 */
export interface L5EmergencyResult {
  messages: AgentMessage[];     // 压缩后的消息列表
  messagesBefore: number;       // 压缩前消息数
  messagesAfter: number;        // 压缩后消息数
}

/**
 * 执行 L5 紧急压缩
 *
 * 极限压缩策略，尽可能保留最关键信息。
 */
export function runL5Emergency(
  messages: AgentMessage[],
  state: AgentState,
  config: L5EmergencyConfig,
  systemPrompt?: string,
): L5EmergencyResult {
  const messagesBefore = messages.length;
  const builder = new SnapshotBuilder();

  // 1. 保留系统消息
  const systemMessages = messages.filter(m => (m.role as string) === 'system');

  // 2. 保留最后 N 条非 ACR 消息
  const nonSystemMessages = messages.filter(m => {
    if ((m.role as string) === 'system') return false;
    if (isStateSnapshot(m)) return false;
    if (isCustomMessage(m)) return false;
    if (m.role === 'compactionSummary') return false;
    return true;
  });

  const lastMessages = nonSystemMessages.slice(-config.recent_keep);

  // 3. 使用 SnapshotBuilder 的紧急模式构建最小化上下文
  const emergencyMessages = builder.buildEmergency(state, systemPrompt || '', lastMessages);

  // 4. 合并
  const result: AgentMessage[] = [
    ...systemMessages,
    ...emergencyMessages,
  ];

  return {
    messages: result,
    messagesBefore,
    messagesAfter: result.length,
  };
}
