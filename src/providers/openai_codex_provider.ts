import {
  LLMProvider,
  LLMResponse,
  LLMRuntime,
  ProviderMessage,
  ProviderToolDefinition,
  StreamCallback,
  StreamResult,
  ToolCallRequest,
} from './base.js';
import { logger } from '../utils/logger.js';
import axios, { AxiosInstance } from 'axios';
import { convertMessages, convertTools } from './openai_responses/converters.js';
import { parseResponseOutput, consumeSseWithReasoning } from './openai_responses/parsing.js';

export interface OpenAICodexProviderConfig {
  name: string;
  api_key?: string;
  base_url?: string;
  default_model?: string;
  extra_headers?: Record<string, string>;
  api_type?: 'openai' | 'codex';
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-5.2-chat';

const TEMPERATURE_INCOMPATIBLE_MODELS = ['gpt-5', 'o1', 'o3', 'o4', 'codex'];

function supportsTemperature(model: string, reasoningEffort: string | null | undefined): boolean {
  if (reasoningEffort && reasoningEffort.toLowerCase() !== 'none') {
    return false;
  }
  const name = model.toLowerCase();
  return !TEMPERATURE_INCOMPATIBLE_MODELS.some(token => name.includes(token));
}

export class OpenAICodexProvider extends LLMProvider {
  name = 'openai_codex';
  private client: AxiosInstance;
  private config: OpenAICodexProviderConfig;
  defaultModel: string;

  constructor(config: OpenAICodexProviderConfig) {
    super();
    this.config = config;
    this.name = config.name || 'openai_codex';
    this.defaultModel = config.default_model || DEFAULT_MODEL;

    const baseURL = this.normalizeBaseUrl(config.base_url || DEFAULT_BASE_URL);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...config.extra_headers,
    };

    if (config.api_key) {
      headers['Authorization'] = `Bearer ${config.api_key}`;
    }

    this.client = axios.create({ baseURL, headers });
  }

  private normalizeBaseUrl(apiBase: string): string {
    let normalized = apiBase.replace(/\/+$/, '');
    if (normalized.endsWith('/v1')) {
      return normalized;
    }
    if (normalized.endsWith('/openai')) {
      return normalized + '/v1';
    }
    return normalized + '/v1';
  }

  private static stripPrefix(model: string): string {
    if (model.startsWith('openai-codex/')) {
      return model.slice('openai-codex/'.length);
    }
    if (model.startsWith('openai/')) {
      return model.slice('openai/'.length);
    }
    return model;
  }

  private buildBody(
    messages: ProviderMessage[],
    tools: ProviderToolDefinition[],
    runtime: LLMRuntime,
    options?: {
      temperature?: number;
      max_tokens?: number;
      reasoning_effort?: string | null;
    },
  ): Record<string, unknown> {
    const modelName = OpenAICodexProvider.stripPrefix(runtime.model || this.defaultModel);
    const [instructions, inputItems] = convertMessages(messages as unknown as Record<string, unknown>[]);

    const body: Record<string, unknown> = {
      model: modelName,
      instructions: instructions || null,
      input: inputItems,
      max_output_tokens: Math.max(1, options?.max_tokens ?? runtime.max_tokens),
      store: false,
      stream: false,
    };

    if (supportsTemperature(modelName, options?.reasoning_effort ?? runtime.reasoning_effort)) {
      body.temperature = options?.temperature ?? runtime.temperature;
    }

    const reasoningEffort = options?.reasoning_effort ?? runtime.reasoning_effort;
    if (reasoningEffort && reasoningEffort.toLowerCase() !== 'none') {
      body.reasoning = { effort: reasoningEffort };
    }

    if (tools.length > 0) {
      body.tools = convertTools(tools as unknown as Record<string, unknown>[]);
      body.tool_choice = 'auto';
    }

    return body;
  }

  async complete(
    messages: ProviderMessage[],
    tools: ProviderToolDefinition[],
    runtime: LLMRuntime,
    options?: {
      temperature?: number;
      max_tokens?: number;
      reasoning_effort?: string | null;
    },
  ): Promise<LLMResponse> {
    const body = this.buildBody(messages, tools, runtime, options);
    try {
      const response = await this.client.post('/responses', body);
      const parsed = parseResponseOutput(response.data);
      return {
        content: parsed.content,
        tool_calls: parsed.tool_calls as ToolCallRequest[],
        stop_reason: parsed.finish_reason,
        usage: parsed.usage,
        model: response.data.model || runtime.model,
        raw: response.data,
        reasoning_content: parsed.reasoning_content,
      };
    } catch (err) {
      logger.error({ err }, 'OpenAI codex provider request failed');
      throw err;
    }
  }

  async stream(
    messages: ProviderMessage[],
    tools: ProviderToolDefinition[],
    runtime: LLMRuntime,
    onDelta: StreamCallback,
    options?: {
      temperature?: number;
      max_tokens?: number;
      reasoning_effort?: string | null;
    },
  ): Promise<StreamResult> {
    const body = {
      ...this.buildBody(messages, tools, runtime, options),
      stream: true,
    };

    try {
      const response = await this.client.post('/responses', body, {
        responseType: 'stream',
        headers: {
          'Accept': 'text/event-stream',
        },
      });

      const stream = response.data as any;
      const [content, toolCalls, finishReason, usage, reasoningContent] = await consumeSseWithReasoning(
        stream,
        async (text) => {
          await onDelta({ text_delta: text });
        },
        async (delta) => {
          await onDelta({
            tool_call_delta: {
              id: String(delta.call_id || ''),
              name: delta.name as string | undefined,
              arguments_delta: delta.arguments_delta as string | undefined,
            },
          });
        },
        async (text) => {
          await onDelta({ reasoning_delta: text });
        },
      );

      return {
        content,
        reasoning_content: reasoningContent || undefined,
        tool_calls: toolCalls as ToolCallRequest[],
        usage,
        stop_reason: finishReason,
        model: runtime.model,
      };
    } catch (err) {
      logger.error({ err }, 'OpenAI codex provider stream failed');
      throw err;
    }
  }
}
