import type { AgentMessage } from "../pi/agent";
import type { Usage } from "../pi/ai";

export interface SessionTreeEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface MessageEntry extends SessionTreeEntryBase {
  type: "message";
  message: AgentMessage;
}

export interface ModelChangeEntry extends SessionTreeEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface ToolCallEntry extends SessionTreeEntryBase {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolResultEntry extends SessionTreeEntryBase {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content: string;
  isError: boolean;
  usage?: Usage;
}

export interface TokenUsageEntry extends SessionTreeEntryBase {
  type: "token_usage";
  usage: Usage;
}

export type SessionTreeEntry =
  | MessageEntry
  | ModelChangeEntry
  | ToolCallEntry
  | ToolResultEntry
  | TokenUsageEntry;

export interface SessionContext {
  messages: AgentMessage[];
  model: { provider: string; modelId: string } | null;
}

export interface SessionMetadata {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionStorage<TMetadata extends SessionMetadata = SessionMetadata> {
  getMetadata(): Promise<TMetadata>;
  getLeafId(): Promise<string | null>;
  setLeafId(leafId: string | null): Promise<void>;
  createEntryId(): Promise<string>;
  appendEntry(entry: SessionTreeEntry): Promise<void>;
  getEntry(id: string): Promise<SessionTreeEntry | undefined>;
  findEntries<TType extends SessionTreeEntry["type"]>(
    type: TType,
  ): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>>;
  getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]>;
  getEntries(): Promise<SessionTreeEntry[]>;
}

export interface StorageAdapter {
  loadSession(key: string): Promise<SessionData | null>;
  saveSession(session: SessionData): Promise<void>;
  deleteSession(key: string): Promise<boolean>;
  listSessions(): Promise<string[]>;
  getAllSessions(): Promise<SessionData[]>;
}

export interface FileStorageOptions {
  baseDir: string;
  maxAge?: number;
}

export interface MemoryStorageOptions {
  maxAge?: number;
}

export interface SessionData {
  key: string;
  entries: SessionTreeEntry[];
  leafId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
