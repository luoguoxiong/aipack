export interface LLMRuntime {
  model: string;
  provider: string;
  max_tokens: number;
  context_window_tokens: number;
  temperature: number;
  reasoning_effort?: string | null;
  model_preset?: string | null;
  base_url?: string | null;
  api_key?: string | null;
  extra_headers?: Record<string, string>;
  extra_query?: Record<string, string>;
  extra_body?: Record<string, unknown>;
}

export interface GenerationSettings {
  temperature?: number;
  max_tokens?: number;
  reasoning_effort?: string | null;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: unknown;
  extra_content?: Record<string, unknown> | null;
  provider_specific_fields?: Record<string, unknown> | null;
  function_provider_specific_fields?: Record<string, unknown> | null;
}

export interface LLMResponse {
  content: string | null;
  reasoning_content?: string | null;
  tool_calls: ToolCallRequest[];
  usage: TokenUsage;
  stop_reason: string;
  model: string;
  raw?: unknown;
}

export interface StreamDelta {
  text_delta?: string;
  reasoning_delta?: string;
  tool_call_delta?: {
    id: string;
    name?: string;
    arguments_delta?: string;
  };
}

export interface StreamResult {
  content: string;
  reasoning_content?: string;
  tool_calls: ToolCallRequest[];
  usage: TokenUsage;
  stop_reason: string;
  model: string;
}

export type StreamCallback = (delta: StreamDelta) => Promise<void>;

export interface ProviderMessage {
  role: string;
  content: string | ProviderContentBlock[];
  tool_calls?: ToolCallRequest[];
  tool_call_id?: string;
  name?: string;
}

export interface ProviderContentBlock {
  type: string;
  text?: string;
  source?: {
    type: string;
    media_type: string;
    data: string;
  };
  [key: string]: unknown;
}

export interface ProviderToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export abstract class LLMProvider {
  abstract name: string;

  abstract complete(
    messages: ProviderMessage[],
    tools: ProviderToolDefinition[],
    runtime: LLMRuntime,
    options?: {
      temperature?: number;
      max_tokens?: number;
      reasoning_effort?: string | null;
    },
  ): Promise<LLMResponse>;

  abstract stream(
    messages: ProviderMessage[],
    tools: ProviderToolDefinition[],
    runtime: LLMRuntime,
    onDelta: StreamCallback,
    options?: {
      temperature?: number;
      max_tokens?: number;
      reasoning_effort?: string | null;
    },
  ): Promise<StreamResult>;
}

export const STREAM_IDLE_TIMEOUT_ENV = 'NANOBOT_STREAM_IDLE_TIMEOUT_S';
export const DEFAULT_STREAM_IDLE_TIMEOUT_S = 90.0;
export const MAX_STREAM_IDLE_TIMEOUT_S = 3600.0;

export function resolveStreamIdleTimeoutS(
  envValue?: string | null,
  defaultTimeout: number = DEFAULT_STREAM_IDLE_TIMEOUT_S,
  maximum: number = MAX_STREAM_IDLE_TIMEOUT_S,
): number {
  const raw = envValue ?? process.env[STREAM_IDLE_TIMEOUT_ENV];
  if (raw === undefined || raw === null || !raw.trim()) {
    return defaultTimeout;
  }
  try {
    const value = parseFloat(raw);
    if (isNaN(value)) {
      return defaultTimeout;
    }
    if (value <= 0) {
      return defaultTimeout;
    }
    if (value > maximum) {
      return maximum;
    }
    return value;
  } catch {
    return defaultTimeout;
  }
}

export function hasValidToolName(call: ToolCallRequest): boolean {
  return typeof call.name === 'string' && call.name.length > 0;
}

export function toolCallToOpenAI(call: ToolCallRequest): Record<string, unknown> {
  const argumentsStr = typeof call.arguments === 'string'
    ? call.arguments
    : JSON.stringify(call.arguments, null, 0);
  
  const toolCall: Record<string, unknown> = {
    id: call.id,
    type: 'function',
    function: {
      name: call.name,
      arguments: argumentsStr,
    },
  };
  
  if (call.extra_content) {
    toolCall.extra_content = call.extra_content;
  }
  if (call.provider_specific_fields) {
    toolCall.provider_specific_fields = call.provider_specific_fields;
  }
  if (call.function_provider_specific_fields) {
    (toolCall.function as Record<string, unknown>).provider_specific_fields = call.function_provider_specific_fields;
  }
  
  return toolCall;
}

export function parseToolArguments(arguments_: unknown): unknown {
  if (arguments_ === null || arguments_ === undefined) {
    return {};
  }
  if (typeof arguments_ !== 'string') {
    return arguments_;
  }
  
  const stripped = arguments_.trim();
  if (!stripped) {
    return {};
  }
  
  try {
    const parsed = JSON.parse(stripped);
    return parsed === null ? {} : parsed;
  } catch {
    return arguments_;
  }
}

export function toolArgumentsObjectForReplay(arguments_: unknown): Record<string, unknown> {
  if (arguments_ === null || arguments_ === undefined) {
    return {};
  }
  if (typeof arguments_ === 'object' && !Array.isArray(arguments_)) {
    return arguments_ as Record<string, unknown>;
  }
  if (typeof arguments_ !== 'string') {
    return {};
  }
  
  const stripped = arguments_.trim();
  if (!stripped) {
    return {};
  }
  
  try {
    const parsed = JSON.parse(stripped);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function toolArgumentsJsonForReplay(arguments_: unknown): string {
  return JSON.stringify(toolArgumentsObjectForReplay(arguments_));
}
