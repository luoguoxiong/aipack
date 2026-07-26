/**
 * 工具配对 - 确保 tool_call 和 tool_result 总是成对出现
 *
 * 核心不变量：永远不要留下孤立的工具调用或结果。
 * 消息顺序不会被改变，只做过滤。
 */

import type { AgentMessage } from '../../agent/types';

/** 工具调用信息 */
interface ToolCallInfo {
  id: string;         // 调用 ID
  msgIndex: number;   // 消息索引
  toolName?: string;  // 工具名
}

/**
 * 从助手消息中提取工具调用列表
 * 支持 pi-agent-core 的 content 数组格式（type: "toolCall"）
 * 同时兼容旧格式（toolCalls / functionCall 字段）
 */
function extractToolCallsFromAssistant(msg: AgentMessage): Array<{ id: string; name?: string }> {
  const calls: Array<{ id: string; name?: string }> = [];

  // pi-agent-core 格式：工具调用在 content 数组中，type 为 "toolCall"
  if ('content' in msg && Array.isArray((msg as any).content)) {
    for (const block of (msg as any).content) {
      if (block.type === 'toolCall' && block.id) {
        calls.push({ id: block.id, name: block.name });
      }
    }
  }

  // 兼容旧格式：toolCalls 字段
  if (calls.length === 0) {
    const toolCalls = (msg as any).toolCalls || (msg as any).tool_calls;
    if (toolCalls && Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (tc.id) {
          calls.push({ id: tc.id, name: tc.name || tc.function?.name });
        }
      }
    }
  }

  // 兼容 functionCall 格式
  if (calls.length === 0) {
    const functionCall = (msg as any).functionCall || (msg as any).function_call;
    if (functionCall?.id) {
      calls.push({ id: functionCall.id, name: functionCall.name });
    }
  }

  return calls;
}

/**
 * 确保工具配对完整性
 *
 * 规则：
 * - 如果保留了一个 tool_call，就必须保留对应的 tool_result
 * - 如果保留了一个 tool_result，就必须保留对应的 tool_call
 * - 消息永远不会被重新排序 - 只过滤
 */
export function ensureToolPairing(messages: AgentMessage[]): AgentMessage[] {
  const callMap = new Map<string, ToolCallInfo>();
  const resultMap = new Map<string, number>(); // callId -> msgIndex
  const keep = new Set<number>();

  // 第一轮：构建调用和结果的映射
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    keep.add(i); // 初始时全部保留

    // 检查助手消息中的工具调用
    if (msg.role === 'assistant') {
      const toolCalls = extractToolCallsFromAssistant(msg);
      for (const tc of toolCalls) {
        if (tc.id) {
          callMap.set(tc.id, { id: tc.id, msgIndex: i, toolName: tc.name });
        }
      }
    }

    // 检查工具结果
    if (msg.role === 'toolResult') {
      const callId = (msg as any).toolCallId || (msg as any).tool_call_id;
      if (callId) {
        resultMap.set(callId, i);
      }
    }
  }

  // 第二轮：找出孤立的调用/结果
  for (const [callId, callInfo] of callMap) {
    const hasResult = resultMap.has(callId);
    if (!hasResult) {
      // 孤立的调用 - 移除它
      keep.delete(callInfo.msgIndex);
    }
  }

  for (const [callId, resultIdx] of resultMap) {
    const hasCall = callMap.has(callId);
    if (!hasCall) {
      // 孤立的结果 - 移除它
      keep.delete(resultIdx);
    }
  }

  // 过滤消息，保持顺序不变
  const result: AgentMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (keep.has(i)) {
      result.push(messages[i]);
    }
  }

  return result;
}

/**
 * 统计孤立的工具配对数（用于指标）
 */
export function countOrphanedPairs(messages: AgentMessage[]): {
  orphanedCalls: number;    // 孤立的调用数
  orphanedResults: number;  // 孤立的结果数
  fixed: number;            // 修复总数（两者之和）
} {
  const callIds = new Set<string>();
  const resultCallIds = new Set<string>();
  let orphanedCalls = 0;
  let orphanedResults = 0;

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const toolCalls = extractToolCallsFromAssistant(msg);
      for (const tc of toolCalls) {
        if (tc.id) callIds.add(tc.id);
      }
    }
    if (msg.role === 'toolResult') {
      const callId = (msg as any).toolCallId || (msg as any).tool_call_id;
      if (callId) resultCallIds.add(callId);
    }
  }

  for (const id of callIds) {
    if (!resultCallIds.has(id)) orphanedCalls++;
  }
  for (const id of resultCallIds) {
    if (!callIds.has(id)) orphanedResults++;
  }

  return {
    orphanedCalls,
    orphanedResults,
    fixed: orphanedCalls + orphanedResults,
  };
}

/**
 * 找到工具调用对应的结果消息
 */
export function findResultForCall(messages: AgentMessage[], callId: string): AgentMessage | null {
  for (const msg of messages) {
    if (msg.role === 'toolResult' && 
        ((msg as any).toolCallId === callId || (msg as any).tool_call_id === callId)) {
      return msg;
    }
  }
  return null;
}

/**
 * 找到工具结果对应的调用消息
 */
export function findCallForResult(messages: AgentMessage[], toolCallId: string): AgentMessage | null {
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const toolCalls = extractToolCallsFromAssistant(msg);
      for (const tc of toolCalls) {
        if (tc.id === toolCallId) return msg;
      }
    }
  }
  return null;
}
