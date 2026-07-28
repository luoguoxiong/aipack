/**
 * L4 快照重写 - 重度有损压缩
 *
 * 基于 Agent State 快照 + 保留少量最近消息 + 工具摘要
 * 重建整个上下文窗口。
 *
 * 适用于上下文严重膨胀时的深度压缩。
 */

import type { AgentMessage } from '../../agent/types';
import type { AgentState, L4SnapshotConfig, ToolDigest } from '../types';
import { SnapshotBuilder } from '../state/snapshot-builder';
import {
  isStateSnapshot,
  isCustomMessage,
} from '../state/message-adapter';

/** L4 快照结果 */
export interface L4SnapshotResult {
  messages: AgentMessage[];     // 重建后的消息列表
  messagesBefore: number;       // 处理前消息数
  messagesAfter: number;        // 处理后消息数
  stateVersion: number;         // 状态版本号
}

/**
 * 执行 L4 快照重写压缩
 *
 * 完全重建上下文，只保留：
 * 1. State Snapshot（基于当前的 AgentState）
 * 2. 最近 N 条消息（由 config.recent_keep 控制）
 * 3. 工具摘要（用于保留工具执行的关键信息）
 * 4. 系统提示词消息（保留）
 */
export function runL4Snapshot(
  messages: AgentMessage[],
  state: AgentState,
  config: L4SnapshotConfig,
  toolDigests: ToolDigest[],
  systemPrompt?: string,
): L4SnapshotResult {
  const messagesBefore = messages.length;
  const builder = new SnapshotBuilder();

  // 1. 收集要保留的最近消息（关键的非 ACR 消息）
  const recentMessages = messages.filter(m => {
    if (isStateSnapshot(m)) return false;
    if (isCustomMessage(m)) return false;
    if (m.role === 'compactionSummary') return false;
    return true;
  }).slice(-config.recent_keep);

  // 2. 保留系统提示词
  const systemMessages = messages.filter(
    m => (m.role as string) === 'system' && !isStateSnapshot(m),
  );

  // 3. 使用 SnapshotBuilder 重建上下文
  const rebuildMessages = builder.build({
    level: 'snapshot',
    systemPrompt: systemPrompt || '',
    recentMessages,
    toolDigests,
    state,
  });

  // 4. 合并：系统消息 + 重建的消息（包含状态快照 + 最近消息 + 工具摘要 + 过渡消息）
  const result: AgentMessage[] = [
    ...systemMessages,
    ...rebuildMessages,
  ];

  return {
    messages: result,
    messagesBefore,
    messagesAfter: result.length,
    stateVersion: state.metadata.snapshotVersion,
  };
}
