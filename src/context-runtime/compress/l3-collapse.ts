/**
 * L3 折叠 - 有损压缩
 *
 * 功能：
 * - 折叠连续失败尝试为一条摘要
 * - 合并重复的文件读取
 * - 移除同质的冗余工具调用模式
 *
 * 这是第一个有损压缩级别，会丢失部分细节。
 */

import type { AgentMessage } from '../../agent/types';
import type { L3CollapseConfig, ToolDigest } from '../types';
import { getMessageContent, isStateSnapshot, isCustomMessage, isCompactionSummary } from '../state/message-adapter';

/** L3 折叠结果 */
export interface L3CollapseResult {
  messages: AgentMessage[];         // 压缩后的消息列表
  attemptsFolded: number;           // 折叠的失败尝试组数
  readsMerged: number;              // 合并的重复读取组数
  messagesBefore: number;           // 处理前消息数
  messagesAfter: number;            // 处理后消息数
}

/**
 * 执行 L3 折叠压缩
 * 折叠失败尝试并合并重复文件读取
 */
export function runL3Collapse(
  messages: AgentMessage[],
  config: L3CollapseConfig,
): L3CollapseResult {
  const messagesBefore = messages.length;
  let attemptsFolded = 0;
  let readsMerged = 0;

  let result: AgentMessage[] = [];

  if (config.fold_failed_attempts) {
    const folded = foldFailedAttempts(messages, config);
    attemptsFolded = folded.folded;
    result = folded.messages;
  } else {
    result = [...messages];
  }

  if (config.merge_repeated_reads) {
    const merged = mergeRepeatedReads(result, config);
    readsMerged = merged.merged;
    result = merged.messages;
  }

  return {
    messages: result,
    attemptsFolded,
    readsMerged,
    messagesBefore,
    messagesAfter: result.length,
  };
}

/**
 * 检测一系列连续消息是否为"失败尝试"模式
 *
 * 失败尝试模式通常为：
 * 1. 助手发出工具调用
 * 2. 工具返回错误/空结果
 * 3. 助手再次尝试（可能用不同参数）
 * 4. 再次失败
 * ...
 * N. 助手换思路了（成功或出现不同的策略）
 */
function foldFailedAttempts(
  messages: AgentMessage[],
  config: L3CollapseConfig,
): { messages: AgentMessage[]; folded: number } {
  const result: AgentMessage[] = [];
  let i = 0;
  let folded = 0;

  while (i < messages.length) {
    // 查找连续失败尝试的起点
    const attemptStart = findFailedAttemptStart(messages, i);
    if (attemptStart === -1) {
      // 没有更多失败尝试，直接添加剩余消息
      result.push(...messages.slice(i));
      break;
    }

    // 把失败尝试之前的消息加入结果
    result.push(...messages.slice(i, attemptStart));

    // 从 attemptStart 开始找连续的失败尝试
    const { attemptMessages, attemptEnd, attemptCount } = collectFailedAttempts(
      messages, attemptStart, config,
    );

    if (attemptCount >= config.min_attempts_to_fold) {
      // 折叠：生成一条摘要替代这些消息
      const summary = buildFailedAttemptSummary(attemptMessages, attemptCount, config);
      result.push(summary);
      folded++;
      i = attemptEnd;
    } else {
      // 失败尝试次数不够，不折叠
      result.push(...messages.slice(attemptStart, attemptEnd));
      i = attemptEnd;
    }
  }

  return { messages: result, folded };
}

/**
 * 从当前位置开始，查找第一个失败尝试的起始位置
 * 失败尝试 = 工具调用后跟工具结果（且结果是失败的）
 */
function findFailedAttemptStart(messages: AgentMessage[], startIndex: number): number {
  for (let i = startIndex; i < messages.length - 1; i++) {
    const msg = messages[i];
    // 助手消息中可能包含工具调用
    if (msg.role === 'assistant') {
      const hasToolCall = hasToolCalls(msg);
      if (!hasToolCall) continue;

      // 检查下一条消息是否是失败的工具结果
      const nextMsg = messages[i + 1];
      if (nextMsg && nextMsg.role === 'toolResult') {
        const content = getMessageContent(nextMsg);
        if (isFailedResult(nextMsg, content)) {
          return i;
        }
      }
    }
  }
  return -1;
}

/**
 * 检查助手消息是否包含工具调用
 */
function hasToolCalls(msg: AgentMessage): boolean {
  // pi-agent-core 格式
  if ('content' in msg && Array.isArray((msg as any).content)) {
    for (const block of (msg as any).content) {
      if (block.type === 'toolCall') return true;
    }
  }
  // 旧格式
  if ((msg as any).toolCalls || (msg as any).tool_calls) return true;
  if ((msg as any).functionCall || (msg as any).function_call) return true;
  return false;
}

/**
 * 判断工具结果是否为失败
 */
function isFailedResult(msg: AgentMessage, content: string): boolean {
  if ((msg as any).isError) return true;
  if (content.includes('Error:') || content.includes('ERROR:')) return true;
  if (content.includes('Failed') || content.includes('FAILED')) return true;
  if (content.includes('exit code') && content.includes('1')) return true;
  // 空结果视为失败
  if (!content || content.trim().length === 0) return true;
  return false;
}

/**
 * 收集连续的失败尝试
 * 返回一组连续的失败尝试消息（成对的 tool_call + tool_result）
 */
function collectFailedAttempts(
  messages: AgentMessage[],
  startIndex: number,
  config: L3CollapseConfig,
): { attemptMessages: AgentMessage[]; attemptEnd: number; attemptCount: number } {
  const attemptMessages: AgentMessage[] = [];
  let i = startIndex;
  let attemptCount = 0;

  while (i < messages.length) {
    const msg = messages[i];

    // 如果是状态快照、自定义消息、压缩摘要，视为边界
    if (isStateSnapshot(msg) || (isCustomMessage(msg)) || isCompactionSummary(msg)) {
      break;
    }

    // 如果是用户消息，视为边界（用户介入）
    if (msg.role === 'user') {
      break;
    }

    // 如果助手消息->工具结果对，且结果是失败的
    if (msg.role === 'assistant' && hasToolCalls(msg)) {
      const nextIdx = i + 1;
      if (nextIdx < messages.length && messages[nextIdx].role === 'toolResult') {
        const content = getMessageContent(messages[nextIdx]);
        if (isFailedResult(messages[nextIdx], content)) {
          attemptMessages.push(msg, messages[nextIdx]);
          attemptCount++;
          i = nextIdx + 1;

          // 达到最大总结数时停止收集（但保留 space 给后续非失败消息）
          if (attemptCount >= config.min_attempts_to_fold * 2) break;
          continue;
        }
      }
    }

    // 如果助手消息成功（工具结果成功，或纯文本响应），说明失败尝试结束
    break;
  }

  return { attemptMessages, attemptEnd: i, attemptCount };
}

/**
 * 构建失败尝试摘要消息
 */
function buildFailedAttemptSummary(
  attemptMessages: AgentMessage[],
  attemptCount: number,
  config: L3CollapseConfig,
): AgentMessage {
  // 收集失败信息
  const summaries: string[] = [];
  for (let i = 0; i < attemptMessages.length && summaries.length < config.max_attempts_in_summary; i++) {
    const msg = attemptMessages[i];
    if (msg.role === 'toolResult') {
      const content = getMessageContent(msg);
      const toolName = (msg as any).toolName || (msg as any).name || 'tool';
      // 提取关键错误行
      const errorLines = content
        .split('\n')
        .filter(l => l.includes('Error') || l.includes('error') || l.includes('FAIL') || l.includes('fail'))
        .slice(0, 2);

      if (errorLines.length > 0) {
        summaries.push(`[${toolName}] ${errorLines.join('; ')}`);
      } else {
        // 没有明显的错误行，取第一行
        const firstLine = content.split('\n')[0]?.trim();
        if (firstLine && firstLine.length > 0 && firstLine.length < 150) {
          summaries.push(`[${toolName}] ${firstLine}`);
        }
      }
    }
  }

  // 去重
  const unique = [...new Set(summaries)];

  const lines: string[] = [
    `[系统] ${attemptCount} 次连续失败尝试已折叠为摘要。`,
    '',
    '失败的尝试：',
  ];

  for (let i = 0; i < Math.min(unique.length, config.max_attempts_in_summary); i++) {
    lines.push(`${i + 1}. ${unique[i]}`);
  }

  if (attemptCount > config.max_attempts_in_summary) {
    lines.push(`...以及另外 ${attemptCount - config.max_attempts_in_summary} 次尝试。`);
  }

  lines.push('');
  lines.push('请避免重复以上已失败的方法，换思路继续。');

  return {
    role: 'custom',
    customType: 'acr_failed_attempts_summary',
    content: lines.join('\n'),
    display: false,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

/**
 * 合并连续重复的文件读取操作
 *
 * 模式：当同一个文件被 Read 工具读取多次且结果相似时，
 * 只保留第一次或最后一次的读取结果。
 */
function mergeRepeatedReads(
  messages: AgentMessage[],
  config: L3CollapseConfig,
): { messages: AgentMessage[]; merged: number } {
  const result: AgentMessage[] = [];
  const readKeys: string[] = []; // 记录文件读取的 key
  let i = 0;
  let merged = 0;

  while (i < messages.length) {
    // 检查是否为连续的读操作
    if (messages[i].role === 'assistant' && hasToolCalls(messages[i])) {
      const readPattern = isReadPattern(messages, i);
      if (readPattern) {
        // 收集后续的读操作
        const { readMessages, readEnd, readCount } = collectReadOperations(messages, i, config);

        if (readCount >= config.min_reads_to_merge) {
          // 合并：只保留最后一次读取结果
          // 找到最后一次（非重复性质）读取
          const lastRead = readMessages[readMessages.length - 1];
          // 添加最后一次读取的工具结果和它前面的调用
          const lastCallIndex = findLastAssistantCall(messages, i, readEnd);
          if (lastCallIndex >= 0) {
            result.push(messages[lastCallIndex]);
            result.push(messages[lastCallIndex + 1]);
          }
          merged++;
          i = readEnd;
          continue;
        }
      }
    }

    result.push(messages[i]);
    i++;
  }

  return { messages: result, merged };
}

/**
 * 检查当前位置是否为一个读模式的开头
 */
function isReadPattern(messages: AgentMessage[], index: number): string | null {
  const msg = messages[index];
  if (msg.role !== 'assistant') return null;

  const toolNames = getToolNamesFromMessage(msg);
  for (const name of toolNames) {
    if (name.includes('read') || name.includes('Read') || name.includes('glob') || name.includes('Glob')) {
      return name;
    }
  }
  return null;
}

/**
 * 从助手消息中提取所有工具调用的名称
 */
function getToolNamesFromMessage(msg: AgentMessage): string[] {
  const names: string[] = [];

  if ('content' in msg && Array.isArray((msg as any).content)) {
    for (const block of (msg as any).content) {
      if (block.type === 'toolCall' && block.name) {
        names.push(block.name);
      }
    }
  }

  const toolCalls = (msg as any).toolCalls || (msg as any).tool_calls;
  if (toolCalls && Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      names.push(tc.name || tc.function?.name || '');
    }
  }

  return names;
}

/**
 * 收集连续的文件读取操作
 */
function collectReadOperations(
  messages: AgentMessage[],
  startIndex: number,
  config: L3CollapseConfig,
): { readMessages: AgentMessage[]; readEnd: number; readCount: number } {
  const readMessages: AgentMessage[] = [];
  let i = startIndex;
  let readCount = 0;

  while (i < messages.length - 1) {
    if (messages[i].role !== 'assistant') {
      // 跳过非助手消息（如自定义消息）
      if (messages[i].role === 'toolResult') {
        // 如果上一对是 read，这可能是 read 的结果
        if (readMessages.length > 0) {
          readMessages.push(messages[i]);
          i++;
          continue;
        }
      }
      break;
    }

    const next = i + 1;
    if (next >= messages.length) break;

    const isRead = isReadPattern(messages, i);
    if (!isRead) break;

    readMessages.push(messages[i], messages[next]);
    readCount++;
    i = next + 1;
  }

  return { readMessages, readEnd: i, readCount };
}

/**
 * 找到最后一次助手调用的索引
 */
function findLastAssistantCall(
  messages: AgentMessage[],
  startIndex: number,
  endIndex: number,
): number {
  for (let i = endIndex - 1; i >= startIndex; i--) {
    if (messages[i].role === 'assistant') {
      return i;
    }
  }
  return -1;
}
