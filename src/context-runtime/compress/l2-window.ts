/**
 * L2 窗口 - 基于锚点的窗口化策略
 *
 * 保留锚点消息 + 最近 N 条消息，
 * 同时确保工具调用的配对完整性。
 *
 * 锚点消息包括：目标、约束、关键决策、当前错误等高价值消息。
 */

import type { AgentMessage } from '../../agent';
import type { L2WindowConfig, MessageTag } from '../types';
import { ensureToolPairing } from './pairing';
import { getMessageContent, isStateSnapshot, isCustomMessage } from '../state/message-adapter';

/** L2 窗口处理结果 */
export interface L2WindowResult {
  messages: AgentMessage[];     // 处理后的消息列表
  anchorsFound: number;         // 找到的锚点数
  recentKept: number;           // 保留的最近消息数
  messagesBefore: number;       // 处理前消息数
  messagesAfter: number;        // 处理后消息数
}

/**
 * 执行 L2 窗口压缩
 * 保留锚点消息 + 滑动窗口内的最近消息
 */
export function runL2Window(
  messages: AgentMessage[],
  config: L2WindowConfig,
): L2WindowResult {
  const messagesBefore = messages.length;
  const keepIndices = new Set<number>();
  let anchorsFound = 0;

  // 1. 始终保留开头的消息 - 系统提示词和初始目标
  // 保留开头的状态快照和自定义系统消息
  for (let i = 0; i < Math.min(5, messages.length); i++) {
    if (isStateSnapshot(messages[i]) || isCustomMessage(messages[i])) {
      keepIndices.add(i);
      anchorsFound++;
    } else if (i === 0 || messages[i].role === 'user') {
      // 保留第一条用户消息（原始目标）
      keepIndices.add(i);
      anchorsFound++;
      break;
    }
  }

  // 2. 识别锚点消息
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (isAnchorMessage(msg, config)) {
      keepIndices.add(i);
      anchorsFound++;
    }
  }

  // 3. 始终保留最近 N 条消息（滑动窗口）
  const recentCount = config.recent_messages_to_keep;
  const startRecent = Math.max(0, messages.length - recentCount);
  for (let i = startRecent; i < messages.length; i++) {
    keepIndices.add(i);
  }
  const recentKept = Math.min(recentCount, messages.length);

  // 4. 构建结果并确保工具配对
  let result = messages.filter((_, i) => keepIndices.has(i));

  // 5. 关键：确保工具配对完整性
  if (config.ensure_tool_pairing) {
    result = ensureToolPairing(result);
  }

  return {
    messages: result,
    anchorsFound,
    recentKept,
    messagesBefore,
    messagesAfter: result.length,
  };
}

/**
 * 判断消息是否是锚点消息
 * 锚点消息是高价值的，需要始终保留
 */
function isAnchorMessage(msg: AgentMessage, config: L2WindowConfig): boolean {
  const content = getMessageContent(msg);

  // 状态快照是锚点（始终保留）
  if (isStateSnapshot(msg)) {
    return true;
  }

  // 自定义消息（除了我们的工具摘要）是锚点
  if (isCustomMessage(msg)) {
    if (content.startsWith('[系统]')) {
      return false;
    }
    return true;
  }

  // 压缩摘要也是锚点
  if (msg.role === 'compactionSummary') {
    return true;
  }

  // 检查锚点角色
  if (config.anchor_roles.includes(msg.role as any)) {
    return true;
  }

  // 基于内容检查锚点标签
  const tagPatterns: Record<MessageTag, RegExp> = {
    goal: /^(目标|goal|objective|任务|我需要|我想|请|帮我)/i,
    constraint: /(不要|禁止|不能|必须|一定要|需要|注意|constraint|must not|must|should|do not)/i,
    key_decision: /(决定|决策|就这么办|decision|decided|chose|我确认|同意)/i,
    current_error: /(error|Error|错误|失败|FAIL|bug|问题|issue|exception)/i,
    state_change: /(成功|success|创建|修改|完成|created|modified|done|fixed|resolved|已)/i,
    success_result: /(成功|success|passed|fixed|resolved|完成|✓|✅)/i,
    failed_attempt: /(失败|failed|不行|试过|attempted|tried)/i,
    temporary_output: /^$/,
    duplicate: /^$/,
  };

  for (const tag of config.anchor_tags) {
    const pattern = tagPatterns[tag];
    if (pattern && pattern.test(content) && content.length > 5 && content.length < 500) {
      return true;
    }
  }

  return false;
}

/**
 * 简单的消息打标函数（P0 基于规则）
 * 给消息打上语义标签
 */
export function tagMessage(msg: AgentMessage): MessageTag[] {
  const tags: MessageTag[] = [];
  const content = getMessageContent(msg);

  if (msg.role === 'user') {
    if (/^(目标|goal|objective|任务|我需要|我想|请|帮我)/i.test(content)) {
      tags.push('goal');
    }
    if (/(不要|禁止|不能|必须|一定要|需要|注意)/i.test(content)) {
      tags.push('constraint');
    }
  }

  if (msg.role === 'toolResult') {
    if (/(error|Error|错误|失败|FAIL|exception)/i.test(content)) {
      tags.push('current_error');
    } else if (/(成功|success|passed|fixed|created|modified|✓)/i.test(content)) {
      tags.push('success_result');
      tags.push('state_change');
    }
  }

  if (/(决定|决策|decision|decided|我确认)/i.test(content)) {
    tags.push('key_decision');
  }

  return tags;
}
