// ─── Agent 导出 ───────────────────────────────────────────────────

export { Agent, AgentHarness } from './agent';
export type {
  AgentMessage,
  AgentUserMessage,
  AgentAssistantMessage,
  AgentToolResultMessage,
  AgentSystemMessage,
  CustomAgentMessages,
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
  AgentState,
  AgentContext,
  AgentEvent,
  AgentStartEvent,
  AgentEndEvent,
  TurnStartEvent,
  TurnEndEvent,
  MessageStartEvent,
  MessageUpdateEvent,
  MessageEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
  ToolExecutionEndEvent,
  AgentEventListener,
  AgentOptions,
  AgentInitialState,
  ThinkingLevel,
  QueueMode,
} from './types';

// ─── 工具桩函数（被 kobot.ts 导入但未使用；保留以保持兼容性） ──

export function estimateTokens(text: string): number {
  // 粗略估算：每个 token 约 4 个字符
  return Math.ceil(text.length / 4);
}

export function estimateContextTokens(messages: { role: string; content: unknown }[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === 'object' && 'text' in block) {
          total += estimateTokens(String((block as { text: string }).text));
        }
      }
    }
    total += 4; // 每条消息的固定开销
  }
  return total;
}

export function shouldCompact(_messages: unknown[]): boolean {
  return false;
}

export async function generateSummary(_messages: unknown[]): Promise<string> {
  return '';
}
