export type StreamEventType =
  | "run.started"
  | "text.delta"
  | "text.completed"
  | "reasoning.delta"
  | "reasoning.completed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "run.completed"
  | "run.failed";

export const STREAM_EVENT_RUN_STARTED: StreamEventType = "run.started";
export const STREAM_EVENT_TEXT_DELTA: StreamEventType = "text.delta";
export const STREAM_EVENT_TEXT_COMPLETED: StreamEventType = "text.completed";
export const STREAM_EVENT_REASONING_DELTA: StreamEventType = "reasoning.delta";
export const STREAM_EVENT_REASONING_COMPLETED: StreamEventType = "reasoning.completed";
export const STREAM_EVENT_TOOL_STARTED: StreamEventType = "tool.started";
export const STREAM_EVENT_TOOL_COMPLETED: StreamEventType = "tool.completed";
export const STREAM_EVENT_TOOL_FAILED: StreamEventType = "tool.failed";
export const STREAM_EVENT_RUN_COMPLETED: StreamEventType = "run.completed";
export const STREAM_EVENT_RUN_FAILED: StreamEventType = "run.failed";

export const STREAM_EVENT_TYPES: StreamEventType[] = [
  STREAM_EVENT_RUN_STARTED,
  STREAM_EVENT_TEXT_DELTA,
  STREAM_EVENT_TEXT_COMPLETED,
  STREAM_EVENT_REASONING_DELTA,
  STREAM_EVENT_REASONING_COMPLETED,
  STREAM_EVENT_TOOL_STARTED,
  STREAM_EVENT_TOOL_COMPLETED,
  STREAM_EVENT_TOOL_FAILED,
  STREAM_EVENT_RUN_COMPLETED,
  STREAM_EVENT_RUN_FAILED,
];

export interface RunResult {
  content: string;
  tools_used: string[];
  messages: Record<string, unknown>[];
  usage: Record<string, number>;
  stop_reason: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
}

export interface StreamEvent {
  type: StreamEventType;
  delta: string;
  content: string;
  result: RunResult | null;
  name: string | null;
  tool_call_id: string | null;
  arguments: Record<string, unknown> | null;
  iteration: number | null;
  resuming: boolean | null;
  usage: Record<string, number>;
  error: string | null;
  metadata: Record<string, unknown>;
}

export interface SessionSnapshot {
  key: string;
  messages: Record<string, unknown>[];
  metadata: Record<string, unknown>;
  created_at: string | null;
  updated_at: string | null;

  to_dict(): Record<string, unknown>;
}

export interface SessionInfo {
  key: string;
  created_at: string | null;
  updated_at: string | null;
  title: string;
  preview: string;
  path: string | null;

  to_dict(): Record<string, unknown>;
}