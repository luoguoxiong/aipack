/**
 * L1 清理 - 无损清理
 *
 * 功能：
 * - 消息去重
 * - 移除空消息/无意义消息
 * - 通过 ToolDigestor 对工具输出做预摘要
 *
 * 这是最基础的压缩级别，不会丢失任何有价值的信息。
 */

import type { AgentMessage } from '../../agent/types';
import type { L1CleanConfig, ToolDigest } from '../types';
import { ToolDigestor } from '../tool';
import { getMessageContent, isToolDigest, isStateSnapshot } from '../state/message-adapter';

/** L1 清理结果 */
export interface L1CleanResult {
  messages: AgentMessage[];     // 清理后的消息列表
  digests: ToolDigest[];        // 生成的工具摘要
  duplicatesRemoved: number;    // 移除的重复消息数
  emptyRemoved: number;         // 移除的空消息数
  digestedCount: number;        // 生成的摘要数
}

/**
 * 执行 L1 清理
 * 对消息列表进行去重、移除空消息、生成工具摘要
 */
export function runL1Clean(
  messages: AgentMessage[],
  config: L1CleanConfig,
  digestor: ToolDigestor,
): L1CleanResult {
  let result: AgentMessage[] = [];
  const digests: ToolDigest[] = [];
  const seenHashes = new Map<string, number>();
  let duplicatesRemoved = 0;
  let emptyRemoved = 0;
  let digestedCount = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const content = getMessageContent(msg);

    // 1. 跳过空消息
    if (config.remove_empty && isEmptyMessage(msg, content)) {
      emptyRemoved++;
      continue;
    }

    // 2. 去重
    if (config.deduplicate) {
      const isDuplicate = checkDuplicate(msg, content, seenHashes, config);
      if (isDuplicate) {
        duplicatesRemoved++;
        continue;
      }
    }

    // 3. 生成工具输出摘要（但暂时保留原消息）
    // 摘要先收集起来，原消息可以在 L2+ 中被替换
    if (config.digest_tool_outputs && msg.role === 'toolResult' && content.length > 0) {
      const toolName = (msg as any).toolName || (msg as any).name || extractToolName(msg);
      const isError = !!(msg as any).isError || content.includes('Error') || content.includes('error');
      
      if (digestor.needsDigest(content)) {
        const digest = digestor.digest(toolName, content, isError);
        digests.push(digest);
        digestedCount++;
      }
    }

    result.push(msg);
  }

  return {
    messages: result,
    digests,
    duplicatesRemoved,
    emptyRemoved,
    digestedCount,
  };
}

/**
 * 检查消息是否为空或无意义
 */
function isEmptyMessage(msg: AgentMessage, content: string): boolean {
  if (!content || content.trim().length === 0) return true;
  
  // 只有空白或非常短的消息
  const trimmed = content.trim();
  if (trimmed.length < 3) return true;
  
  // 常见的无意义输出模式
  const trivialPatterns = [
    /^(ok|done|success|完成|好的|收到|yes|no)[.!?\s]*$/i,
    /^[\s\n\r]*$/,
  ];
  
  for (const pattern of trivialPatterns) {
    if (pattern.test(trimmed)) return true;
  }
  
  return false;
}

/**
 * 检查消息是否是重复的
 * 基于内容哈希进行去重
 */
function checkDuplicate(
  msg: AgentMessage,
  content: string,
  seenHashes: Map<string, number>,
  config: L1CleanConfig,
): boolean {
  // 自定义系统消息（状态快照等）不去重
  if (isStateSnapshot(msg) || isToolDigest(msg)) return false;
  
  // 用户消息：仅在明确允许时去重
  if (msg.role === 'user' && !config.deduplicate_user_messages) return false;
  
  // 助手消息：根据配置决定是否去重
  if (msg.role === 'assistant' && !config.deduplicate_assistant_messages) return false;
  
  // 工具结果：根据配置决定是否去重
  if (msg.role === 'toolResult' && !config.deduplicate_tool_results) return false;
  
  // 基于内容的哈希
  const hash = hashContent(content);
  if (seenHashes.has(hash)) {
    // 如果消息间隔太远（超过 20 条），则不去重
    // 只对连续或接近连续的重复消息去重
    const lastSeen = seenHashes.get(hash)!;
    const currentIndex = seenHashes.size; // 近似值
    if (currentIndex - lastSeen < 20) {
      return true;
    }
  }
  
  seenHashes.set(hash, seenHashes.size);
  return false;
}

/**
 * 简单的内容哈希函数
 * 用于去重检测
 */
function hashContent(str: string): string {
  // 使用简单哈希进行去重
  let hash = 0;
  const sample = str.slice(0, 500) + str.slice(-200); // 取样开头和结尾
  for (let i = 0; i < sample.length; i++) {
    const char = sample.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

/**
 * 从消息中提取工具名
 */
function extractToolName(msg: AgentMessage): string {
  // 尝试从消息中提取工具名
  const toolCallId = (msg as any).toolCallId;
  if (toolCallId) {
    // 如果有 tool call ID，可以查找对应的调用，但暂时返回通用值
    return 'tool';
  }
  return 'unknown';
}

// 导出辅助函数供直接使用
export { isEmptyMessage, hashContent };
