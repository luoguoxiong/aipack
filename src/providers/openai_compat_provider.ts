import axios, { AxiosInstance } from 'axios';
import {
  LLMProvider,
  LLMResponse,
  LLMRuntime,
  ProviderMessage,
  ProviderToolDefinition,
  StreamCallback,
  StreamResult,
  ToolCallRequest,
  parseToolArguments,
  resolveStreamIdleTimeoutS,
} from './base.js';
import { logger } from '../utils/logger.js';

export interface OpenAICompatProviderConfig {
  name: string;
  api_key?: string;
  base_url: string;
  model?: string;
  extra_headers?: Record<string, string>;
  extra_query?: Record<string, string>;
  extra_body?: Record<string, unknown>;
}

export class OpenAICompatProvider extends LLMProvider {
  name = 'openai_compat';
  private client: AxiosInstance;
  private config: OpenAICompatProviderConfig;

  constructor(config: OpenAICompatProviderConfig) {
    super();
    this.config = config;
    this.name = config.name || 'openai_compat';
    this.client = axios.create({
      baseURL: config.base_url,
      headers: {
        'Content-Type': 'application/json',
        ...(config.api_key ? { 'Authorization': `Bearer ${config.api_key}` } : {}),
        ...config.extra_headers,
      },
      params: config.extra_query,
    });
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
    const body = this.buildRequestBody(messages, tools, runtime, options);

    try {
      const response = await this.client.post('/chat/completions', body);
      return this.parseResponse(response.data);
    } catch (err) {
      logger.error({ err }, 'OpenAI compat provider request failed');
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
      ...this.buildRequestBody(messages, tools, runtime, options),
      stream: true,
    };

    const timeoutMs = resolveStreamIdleTimeoutS() * 1000;
    let content = '';
    let reasoningContent = '';
    const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
    let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    let stopReason = '';
    let model = runtime.model;

    try {
      const response = await this.client.post('/chat/completions', body, {
        responseType: 'stream',
        timeout: timeoutMs,
      });

      const stream = response.data as NodeJS.ReadableStream;
      let buffer = '';

      await new Promise<void>((resolve, reject) => {
        stream.on('data', async (chunk: Buffer) => {
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;

            const data = trimmed.slice(6);
            if (data === '[DONE]') {
              resolve();
              return;
            }

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;

              if (parsed.usage) {
                usage = {
                  input_tokens: parsed.usage.prompt_tokens || 0,
                  output_tokens: parsed.usage.completion_tokens || 0,
                  total_tokens: parsed.usage.total_tokens || 0,
                };
              }

              if (parsed.model) {
                model = parsed.model;
              }

              if (parsed.choices?.[0]?.finish_reason) {
                stopReason = parsed.choices[0].finish_reason;
              }

              if (delta) {
                if (delta.content) {
                  content += delta.content;
                  await onDelta({ text_delta: delta.content });
                }

                if (delta.reasoning_content) {
                  reasoningContent += delta.reasoning_content;
                  await onDelta({ reasoning_delta: delta.reasoning_content });
                }

                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;

                    if (!toolCalls.has(idx)) {
                      toolCalls.set(idx, {
                        id: tc.id || '',
                        name: tc.function?.name || '',
                        arguments: '',
                      });
                    }

                    const existing = toolCalls.get(idx)!;
                    if (tc.id) existing.id = tc.id;
                    if (tc.function?.name) existing.name = tc.function.name;
                    if (tc.function?.arguments) {
                      existing.arguments += tc.function.arguments;
                    }

                    await onDelta({
                      tool_call_delta: {
                        id: existing.id,
                        name: tc.function?.name,
                        arguments_delta: tc.function?.arguments,
                      },
                    });
                  }
                }
              }
            } catch (parseErr) {
              logger.warn({ err: parseErr, data }, 'Failed to parse SSE data');
            }
          }
        });

        stream.on('end', () => resolve());
        stream.on('error', (err) => reject(err));
      });

      const finalToolCalls: ToolCallRequest[] = [];
      for (let i = 0; i < toolCalls.size; i++) {
        const tc = toolCalls.get(i);
        if (tc) {
          finalToolCalls.push({
            id: tc.id,
            name: tc.name,
            arguments: parseToolArguments(tc.arguments),
          });
        }
      }

      return {
        content,
        reasoning_content: reasoningContent || undefined,
        tool_calls: finalToolCalls,
        usage,
        stop_reason: stopReason,
        model,
      };
    } catch (err) {
      logger.error({ err }, 'OpenAI compat provider stream failed');
      throw err;
    }
  }

  private buildRequestBody(
    messages: ProviderMessage[],
    tools: ProviderToolDefinition[],
    runtime: LLMRuntime,
    options?: {
      temperature?: number;
      max_tokens?: number;
      reasoning_effort?: string | null;
    },
  ): Record<string, unknown> {
    // Strip provider prefix from model name (e.g. "deepseek/deepseek-chat" -> "deepseek-chat")
    const model = runtime.model.includes('/')
      ? runtime.model.split('/').slice(1).join('/')
      : runtime.model;
    const body: Record<string, unknown> = {
      model,
      messages: messages.map(m => this.convertMessage(m)),
      temperature: options?.temperature ?? runtime.temperature,
      max_tokens: options?.max_tokens ?? runtime.max_tokens,
      ...this.config.extra_body,
    };

    if (tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }));
    }

    if (options?.reasoning_effort) {
      body.reasoning_effort = options.reasoning_effort;
    }

    return body;
  }

  private convertMessage(msg: ProviderMessage): Record<string, unknown> {
    const result: Record<string, unknown> = {
      role: msg.role,
    };

    if (msg.role === 'tool') {
      result.tool_call_id = msg.tool_call_id;
      result.content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      return result;
    }

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      result.tool_calls = msg.tool_calls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: typeof tc.arguments === 'string'
            ? tc.arguments
            : JSON.stringify(tc.arguments),
        },
      }));
    }

    if (Array.isArray(msg.content)) {
      result.content = msg.content;
    } else {
      result.content = msg.content;
    }

    return result;
  }

  private parseResponse(data: Record<string, unknown>): LLMResponse {
    const choice = (data.choices as Record<string, unknown>[])?.[0];
    const message = choice?.message as Record<string, unknown> | undefined;
    const usage = data.usage as Record<string, number> | undefined;

    const toolCalls: ToolCallRequest[] = [];
    if (message?.tool_calls && Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls as Record<string, unknown>[]) {
        const func = tc.function as Record<string, unknown> | undefined;
        toolCalls.push({
          id: tc.id as string,
          name: func?.name as string,
          arguments: parseToolArguments(func?.arguments),
        });
      }
    }

    return {
      content: (message?.content as string) ?? null,
      reasoning_content: message?.reasoning_content as string | undefined,
      tool_calls: toolCalls,
      usage: {
        input_tokens: usage?.prompt_tokens || 0,
        output_tokens: usage?.completion_tokens || 0,
        total_tokens: usage?.total_tokens || 0,
      },
      stop_reason: (choice?.finish_reason as string) || '',
      model: data.model as string,
      raw: data,
    };
  }
}
