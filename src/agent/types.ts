import type { TSchema, Static } from '@sinclair/typebox';
import type {
  Model,
  Context,
  Message,
  AssistantMessage,
  StreamEvent,
  SimpleStreamOptions,
  StreamResult,
  TextContent,
  ImageContent,
  ToolCallContent,
  ThinkingContent,
  Usage,
  ContentBlock,
} from '../ai/types';

// ─── 钩子相关类型（从旧 src/agent/types 合并）──────────────────────

export interface AgentHookContext {
  event: AgentEvent;
  signal: AbortSignal;
}

export interface AgentRunHookContext extends AgentHookContext {
  messages: AgentMessage[];
}

export interface AgentToolHookContext extends AgentHookContext {
  toolName: string;
  toolCallId: string;
  args: unknown;
  result?: unknown;
}

export interface StreamingEmitter {
  emit(event: AgentEvent): void;
}

export interface AgentHook {
  onStart?: (context: AgentRunHookContext) => Promise<void> | void;
  onMessage?: (context: AgentHookContext) => Promise<void> | void;
  onToolCall?: (context: AgentToolHookContext) => Promise<void> | void;
  onToolResult?: (context: AgentToolHookContext) => Promise<void> | void;
  onEnd?: (context: AgentRunHookContext) => Promise<void> | void;
}

// ─── 流式选项与运行结果类型 ──────────────────────────────────────

export interface StreamOptions {
  onStream?: (delta: string) => Promise<void>;
  onReasoning?: (delta: string) => Promise<void>;
  onToolStart?: (toolName: string, toolCallId: string) => void;
  onToolComplete?: (toolName: string, toolCallId: string, result: string) => void;
  onToolError?: (toolName: string, toolCallId: string, error: string) => void;
}

export interface RunResult {
  content: string;
  toolsUsed: string[];
  usage: Record<string, number>;
  stopReason: string;
  metadata: Record<string, unknown>;
  error?: string;
}

export interface SessionInfo {
  key: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSnapshot {
  key: string;
  messages: unknown[];
  metadata: Record<string, unknown>;
}

// ─── 思考模式与队列 ─────────────────────────────────────────────────

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type QueueMode = 'one-at-a-time' | 'all';

// ─── Agent 消息 ───────────────────────────────────────────────────

export interface AgentUserMessage {
  role: 'user';
  content: string | ContentBlock[];
  timestamp: number;
}

export interface AgentAssistantMessage extends AssistantMessage {}

export interface AgentToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: ContentBlock[];
  isError: boolean;
  timestamp: number;
}

export interface AgentSystemMessage {
  role: 'system';
  content: string;
  timestamp: number;
}

// 允许通过声明合并添加自定义消息类型
export interface CustomAgentMessages {}

type CustomMessage = CustomAgentMessages extends Record<string, infer T>
  ? T
  : { role: string; timestamp: number; [key: string]: unknown };

export type AgentMessage =
  | AgentUserMessage
  | AgentAssistantMessage
  | AgentToolResultMessage
  | AgentSystemMessage
  | CustomMessage;

// ─── Agent 工具 ───────────────────────────────────────────────────

export interface AgentToolResult<T = unknown> {
  content: ContentBlock[];
  details: T;
  usage?: Usage;
  addedToolNames?: string[];
  terminate?: boolean;
}

export type AgentToolUpdateCallback<T = unknown> = (partialResult: AgentToolResult<T>) => void;

export interface AgentTool<T extends TSchema = TSchema> {
  name: string;
  label?: string;
  description: string;
  parameters: T;
  executionMode?: 'sequential' | 'parallel';
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<unknown>,
  ) => Promise<AgentToolResult<unknown>>;
  prepareArguments?: (args: unknown) => unknown;
}

// ─── Agent 状态 ───────────────────────────────────────────────────

export interface AgentState {
  systemPrompt: string;
  model: Model;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool[];
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}

// ─── Agent 上下文 ─────────────────────────────────────────────────

export interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: AgentTool[];
}

// ─── Agent 事件 ───────────────────────────────────────────────────

export interface AgentStartEvent {
  type: 'agent_start';
}

export interface AgentEndEvent {
  type: 'agent_end';
  messages: AgentMessage[];
}

export interface TurnStartEvent {
  type: 'turn_start';
}

export interface TurnEndEvent {
  type: 'turn_end';
  message: AssistantMessage;
  toolResults: AgentToolResult[];
}

export interface MessageStartEvent {
  type: 'message_start';
  message: AgentMessage;
}

export interface MessageUpdateEvent {
  type: 'message_update';
  message: AgentMessage;
  assistantMessageEvent: StreamEvent;
}

export interface MessageEndEvent {
  type: 'message_end';
  message: AgentMessage;
}

export interface ToolExecutionStartEvent {
  type: 'tool_execution_start';
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolExecutionUpdateEvent {
  type: 'tool_execution_update';
  toolCallId: string;
  toolName: string;
  partialResult?: unknown;
}

export interface ToolExecutionEndEvent {
  type: 'tool_execution_end';
  toolCallId: string;
  toolName: string;
  result?: AgentToolResult;
  isError: boolean;
  args?: unknown;
}

export type AgentEvent =
  | AgentStartEvent
  | AgentEndEvent
  | TurnStartEvent
  | TurnEndEvent
  | MessageStartEvent
  | MessageUpdateEvent
  | MessageEndEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent;

// ─── 事件监听器 ────────────────────────────────────────────────────

export type AgentEventListener = (event: AgentEvent, signal?: AbortSignal) => void | Promise<void>;

// ─── Agent 选项 ───────────────────────────────────────────────────

export interface AgentInitialState {
  systemPrompt: string;
  model: Model;
  thinkingLevel?: ThinkingLevel;
  tools?: AgentTool[];
  messages?: AgentMessage[];
}

export interface AgentOptions {
  initialState: AgentInitialState;
  streamFn: (model: Model, context: Context, options?: SimpleStreamOptions) => StreamResult;
  convertToLlm?: (messages: AgentMessage[]) => Message[];
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  sessionId?: string;
  getApiKey?: (provider: string) => Promise<string | undefined>;
  toolExecution?: 'parallel' | 'sequential';
  beforeToolCall?: (context: {
    toolCall: ToolCallContent;
    args: unknown;
    context: AgentContext;
  }) => Promise<{ block?: boolean; reason?: string } | void>;
  afterToolCall?: (context: {
    toolCall: ToolCallContent;
    result: AgentToolResult;
    isError: boolean;
    context: AgentContext;
  }) => Promise<{ terminate?: boolean; details?: unknown } | void>;
  thinkingBudgets?: Partial<Record<ThinkingLevel, number>>;
}
