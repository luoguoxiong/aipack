/**
 * 消息适配器 - 消息类型的兼容层
 *
 * 提供处理各种形状的 AgentMessage 的工具函数，
 * 统一处理消息内容的读取和写入。
 */

import type { AgentMessage } from '../../agent/types';

/**
 * 从任意 AgentMessage 获取文本内容
 * 处理多种消息格式：普通文本、数组内容、摘要、bash 执行等
 */
export function getMessageContent(message: AgentMessage): string {
  // 处理有 'content' 字段的消息
  if ('content' in message) {
    const content = message.content;
    if (typeof content === 'string') {
      return content;
    }
    // 数组内容（文本/图片块）
    if (Array.isArray(content)) {
      return content
        .filter(part => typeof part === 'object' && 'text' in part)
        .map(part => (part as { text: string }).text)
        .join('\n');
    }
  }
  
  // 处理有 'summary' 字段的消息（压缩/分支摘要）
  if ('summary' in message && typeof message.summary === 'string') {
    return message.summary;
  }
  
  // 处理 bash 执行消息
  if (message.role === 'bashExecution') {
    const parts: string[] = [];
    if ('command' in message && typeof message.command === 'string') {
      parts.push(`$ ${message.command}`);
    }
    if ('output' in message && typeof message.output === 'string') {
      parts.push(message.output);
    }
    return parts.join('\n');
  }
  
  return '';
}

/**
 * 设置消息的文本内容
 * 仅对可写入内容的消息类型有效
 */
export function setMessageContent(message: AgentMessage, newContent: string): void {
  if ('content' in message) {
    (message as any).content = newContent;
  } else if ('summary' in message) {
    (message as any).summary = newContent;
  }
}

/**
 * 创建系统状态快照消息（使用自定义消息类型）
 * 用于在上下文中注入 Agent 状态
 */
export function createStateSnapshotMessage(content: string): AgentMessage {
  return {
    role: 'custom',
    customType: 'acr_state_snapshot',
    content,
    display: false,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

/**
 * 创建压缩过渡/摘要消息
 * 用于告知模型上下文已被压缩
 */
export function createCompactionMessage(
  summary: string,
  tokensBefore: number,
): AgentMessage {
  return {
    role: 'compactionSummary',
    summary,
    tokensBefore,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

/**
 * 创建工具摘要消息
 * 用于存储工具输出的结构化摘要
 */
export function createToolDigestMessage(content: string): AgentMessage {
  return {
    role: 'custom',
    customType: 'acr_tool_digest',
    content,
    display: false,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

/**
 * 检查消息是否是系统类自定义消息（我们注入的类型）
 * @param customType 可选，指定具体类型
 */
export function isCustomMessage(message: AgentMessage, customType?: string): boolean {
  if (message.role !== 'custom') return false;
  if (!('customType' in message)) return false;
  if (customType) {
    return (message as any).customType === customType;
  }
  return true;
}

/**
 * 检查消息是否是状态快照
 */
export function isStateSnapshot(message: AgentMessage): boolean {
  return isCustomMessage(message, 'acr_state_snapshot');
}

/**
 * 检查消息是否是工具摘要
 */
export function isToolDigest(message: AgentMessage): boolean {
  return isCustomMessage(message, 'acr_tool_digest');
}

/**
 * 检查消息是否是压缩摘要
 */
export function isCompactionSummary(message: AgentMessage): boolean {
  return message.role === 'compactionSummary';
}

/**
 * 安全估算消息的 token 数（适用于所有消息类型）
 * 使用启发式方法区分中英文：
 * - 中文字符按 ~1.5 字符/token
 * - 英文字符按 ~4 字符/token
 * - 数字/空格/标点按 ~3 字符/token
 */
export function estimateMessageTokens(message: AgentMessage): number {
  const content = getMessageContent(message);
  if (!content) return 0;

  let chineseChars = 0;
  let otherChars = 0;

  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    // CJK 统一表意文字范围
    if ((code >= 0x4E00 && code <= 0x9FFF) ||
        (code >= 0x3400 && code <= 0x4DBF) ||
        (code >= 0xF900 && code <= 0xFAFF) ||
        (code >= 0x2E80 && code <= 0x2EFF)) {
      chineseChars++;
    } else {
      otherChars++;
    }
  }

  // 中文 ~1.5 字符/token, 英文/其他 ~4 字符/token
  const estimated = Math.ceil(chineseChars / 1.5) + Math.ceil(otherChars / 4);
  return Math.max(1, estimated);
}

/**
 * 查找消息中已有的状态快照（返回索引，找不到返回 -1）
 */
export function findStateSnapshotIndex(messages: AgentMessage[]): number {
  return messages.findIndex(isStateSnapshot);
}

/**
 * 移除所有已有的状态快照
 */
export function removeStateSnapshots(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter(m => !isStateSnapshot(m));
}

/**
 * 移除所有已有的工具摘要
 */
export function removeToolDigests(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter(m => !isToolDigest(m));
}
