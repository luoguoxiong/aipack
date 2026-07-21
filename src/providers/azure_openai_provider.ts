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

export interface AzureOpenAIProviderConfig {
  name: string;
  api_key?: string;
  base_url: string;
  default_model?: string;
  extra_headers?: Record<string, string>;
}

export class AzureOpenAIProvider extends LLMProvider {
  name = 'azure_openai';
  private client: AxiosInstance;
  private config: AzureOpenAIProviderConfig;
  defaultModel: string;

  constructor(config: AzureOpenAIProviderConfig) {
    super();
    this.config = config;
    this.name = config.name || 'azure_openai';
    this.defaultModel = config.default_model || 'gpt-5.2-chat';

    if (!config.base_url) {
      throw new Error('Azure OpenAI base_url is required');
    }

    const baseUrl = config.base_url.replace(/\/+$/, '') + '/';
    const endpoint = `${baseUrl}openai/v1`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...config.extra_headers,
    };

    if (config.api_key) {
      headers['api-key'] = config.api_key;
    }

    this.client = axios.create({
      baseURL: endpoint,
      headers,
    });
  }

  private static supportsTemperature(
    deploymentName: string,
    reasoningEffort: string | null | undefined,
  ): boolean {
    if (reasoningEffort && reasoningEffort.toLowerCase() !== 'none') {
      return false;
    }
    const name = deploymentName.toLowerCase();
    return !['gpt-5', 'o1', 'o3', 'o4'].some(token => name.includes(token));
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
    const deployment = runtime.model || this.defaultModel;
    const [instructions, inputItems] = convertMessages(messages as unknown as Record<string, unknown>[]);

    const body: Record<string, unknown> = {
      model: deployment,
      instructions: instructions || null,
      input: inputItems,
      max_output_tokens: Math.max(1, options?.max_tokens ?? runtime.max_tokens),
      store: false,
      stream: false,
    };

    if (AzureOpenAIProvider.supportsTemperature(deployment, options?.reasoning_effort ?? runtime.reasoning_effort)) {
      body.temperature = options?.temperature ?? runtime.temperature;
    }

    const reasoningEffort = options?.reasoning_effort ?? runtime.reasoning_effort;
    if (reasoningEffort && reasoningEffort.toLowerCase() !== 'none') {
      body.reasoning = { effort: reasoningEffort };
      body.include = ['reasoning.encrypted_content'];
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
        model: runtime.model,
        raw: response.data,
        reasoning_content: parsed.reasoning_content,
      };
    } catch (err) {
      logger.error({ err }, 'Azure OpenAI provider request failed');
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
      logger.error({ err }, 'Azure OpenAI provider stream failed');
      throw err;
    }
  }
}
