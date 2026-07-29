// 重新导出 TypeBox，用于 schema 定义
export { Type, type Static, type TSchema } from '@sinclair/typebox';

// ─── API 标识符 ───────────────────────────────────────────────

export type Api =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'
  | 'mistral-conversations'
  | 'bedrock-converse-stream'
  | string;

// ─── 内容块 ───────────────────────────────────────────────

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  data: string; // base64 编码
  mimeType: string;
}

export interface ToolCallContent {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
}

export type ContentBlock = TextContent | ImageContent | ToolCallContent | ThinkingContent;

// ─── 用量与费用 ──────────────────────────────────────────────────

export interface Usage {
  input: number;
  output: number;
  total: number;
  totalTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost: {
    input: number;
    output: number;
    total: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

// ─── 消息 ─────────────────────────────────────────────────────

export interface UserMessage {
  role: 'user';
  content: string | ContentBlock[];
  timestamp: number;
}

export interface AssistantMessage {
  role: 'assistant';
  content: ContentBlock[];
  stopReason: string; // 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'
  usage: Usage;
  model?: string;
  provider?: string;
  errorMessage?: string;
  responseId?: string;
}

export interface ToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: ContentBlock[];
  isError: boolean;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// ─── 上下文 ──────────────────────────────────────────────────────

export interface Tool {
  name: string;
  description: string;
  parameters: import('@sinclair/typebox').TSchema;
}

export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}

// ─── 模型 ────────────────────────────────────────────────────────

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Model<TApi extends Api = Api> {
  id: string;
  name: string;
  api: TApi;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: string[]; // ['text'] | ['text', 'image']
  output?: string[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, string | null>;
}

// ─── 流事件 ────────────────────────────────────────────────

export interface StreamStartEvent {
  type: 'start';
  partial: AssistantMessage;
}

export interface TextStartEvent {
  type: 'text_start';
  contentIndex: number;
}

export interface TextDeltaEvent {
  type: 'text_delta';
  delta: string;
  contentIndex: number;
}

export interface TextEndEvent {
  type: 'text_end';
  content: string;
  contentIndex: number;
}

export interface ThinkingStartEvent {
  type: 'thinking_start';
  contentIndex: number;
}

export interface ThinkingDeltaEvent {
  type: 'thinking_delta';
  delta: string;
  contentIndex: number;
}

export interface ThinkingEndEvent {
  type: 'thinking_end';
  content: string;
  contentIndex: number;
}

export interface ToolCallStartEvent {
  type: 'toolcall_start';
  contentIndex: number;
}

export interface ToolCallDeltaEvent {
  type: 'toolcall_delta';
  delta: string;
  partial: AssistantMessage;
  contentIndex: number;
}

export interface ToolCallEndEvent {
  type: 'toolcall_end';
  toolCall: ToolCallContent;
  contentIndex: number;
}

export interface DoneEvent {
  type: 'done';
  reason: string; // 'stop' | 'length' | 'toolUse'
  message: AssistantMessage;
}

export interface ErrorEvent {
  type: 'error';
  reason: 'error' | 'aborted';
  error: AssistantMessage;
}

export type StreamEvent =
  | StreamStartEvent
  | TextStartEvent
  | TextDeltaEvent
  | TextEndEvent
  | ThinkingStartEvent
  | ThinkingDeltaEvent
  | ThinkingEndEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | ToolCallEndEvent
  | DoneEvent
  | ErrorEvent;

// ─── 流选项 ────────────────────────────────────────────────

export type ReasoningLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface SimpleStreamOptions {
  signal?: AbortSignal;
  apiKey?: string;
  reasoning?: ReasoningLevel;
  maxTokens?: number;
  temperature?: number;
  sessionId?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  onPayload?: (payload: unknown) => void;
  onResponse?: (response: unknown) => void;
}

// 提供者特定 API 的扩展选项
export interface StreamOptions extends SimpleStreamOptions {
  thinkingEnabled?: boolean;
  thinkingBudgetTokens?: number;
  reasoningEffort?: string;
  reasoningSummary?: string;
  cacheRetention?: string;
}

// ─── 流结果 ─────────────────────────────────────────────────

export interface StreamResult extends AsyncIterable<StreamEvent> {
  result(): Promise<AssistantMessage>;
}

// ─── 提供者 ──────────────────────────────────────────────────────

export interface Provider {
  id: string;
  name: string;
  models: Model[];
  auth: {
    apiKey?: {
      name: string;
      resolve: () => Promise<{ auth: { apiKey?: string; headers?: Record<string, string>; baseUrl?: string; source?: string } }>;
    };
  };
  stream?: (model: Model, context: Context, options?: StreamOptions) => StreamResult;
  streamSimple?: (model: Model, context: Context, options?: SimpleStreamOptions) => StreamResult;
}

// ─── 认证解析 ────────────────────────────────────────────────

export interface ResolvedAuth {
  apiKey?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
  source?: string;
}

// ─── 图片生成 ──────────────────────────────────────────────

export interface ImagesModel {
  id: string;
  name: string;
  provider: string;
  api: string;
  input: string[]; // ['text'] | ['text', 'image']
  output: string[]; // ['image'] | ['image', 'text']
}

export interface ImageInputBlock {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ImageOutputBlock {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface AssistantImages {
  output: ImageOutputBlock[];
  stopReason: string;
  responseId?: string;
  usage?: Usage;
}

export interface ImagesGenerateOptions {
  signal?: AbortSignal;
  apiKey?: string;
  headers?: Record<string, string>;
  size?: string;
  quality?: string;
}

export interface ImagesProvider {
  id: string;
  name: string;
  models: ImagesModel[];
  generateImages?: (model: ImagesModel, input: ImageInputBlock[], options?: ImagesGenerateOptions) => Promise<AssistantImages>;
}

// ─── 凭证存储 ──────────────────────────────────────────────

export interface CredentialStore {
  read(providerId: string): Promise<unknown | undefined>;
  list(): Promise<Array<{ providerId: string; type: string }>>;
  modify(providerId: string, fn: (credential: unknown) => Promise<unknown>): Promise<void>;
  delete(providerId: string): Promise<void>;
}

// ─── 模型集合 ──────────────────────────────────────────────

export interface ModelsOptions {
  credentials?: CredentialStore;
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────

export function hasApi<T extends Api>(model: Model, api: T): model is Model<T> {
  return model.api === api;
}

export function createEmptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    total: 0,
    cost: { input: 0, output: 0, total: 0 },
  };
}

export function createEmptyAssistantMessage(): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    stopReason: 'stop',
    usage: createEmptyUsage(),
  };
}
