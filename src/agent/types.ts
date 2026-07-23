import type {
  AgentEvent,
  AgentContext,
  AgentMessage,
  AgentTool,
  AgentState,
  ThinkingLevel,
  QueueMode,
} from "@earendil-works/pi-agent-core";
import type { Model, ImageContent } from "@earendil-works/pi-ai";
import type { Config } from "../config/schema";

export type {
  AgentEvent,
  AgentContext,
  AgentMessage,
  AgentTool,
  AgentState,
  ThinkingLevel,
  QueueMode,
};

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

export interface AgentOptions {
  config: Config;
  model?: Model<any>;
  systemPrompt?: string;
  tools?: AgentTool[];
  hooks?: AgentHook[];
  sessionId?: string;
}

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
