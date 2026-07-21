import crypto from 'crypto';
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
import axios, { AxiosInstance } from 'axios';

const TOKEN_URL = 'https://api.github.com/';
const GITHUB_COPILOT_VSCODE_CLIENT_ID = 'Iv1.b507a08c82ec276f';

export interface GitHubCopilotProviderConfig {
  name: string;
  api_key?: string;
  base_url?: string;
  default_model?: string;
  token_file?: string;
  extra_headers?: Record<string, string>;
}

function randomHex(numBytes: number): string {
  return crypto.randomBytes(numBytes).toString('hex');
}

function b64urlencode(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generateCodeVerifier(): string {
  return b64urlencode(randomHex(32));
}

function generateCodeChallenge(verifier: string): string {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return b64urlencode(hash);
}

export class GitHubCopilotProvider extends LLMProvider {
  name = 'github_copilot';
  private client: AxiosInstance;
  private config: GitHubCopilotProviderConfig;
  defaultModel: string;
  private token: string | null = null;
  private tokenExpiry: number | null = null;

  constructor(config: GitHubCopilotProviderConfig) {
    super();
    this.config = config;
    this.name = config.name || 'github_copilot';
    this.defaultModel = config.default_model || 'gpt-5.2-chat';
    this.client = axios.create({
      baseURL: config.base_url || 'https://api.githubcopilot.com',
      headers: {
        'Content-Type': 'application/json',
        'GitHub-Api-Version': '2025-01-01',
        ...config.extra_headers,
      },
    });

    if (config.api_key) {
      this.token = config.api_key;
    }
  }

  private async ensureToken(): Promise<string> {
    if (this.token && (this.tokenExpiry === null || Date.now() < this.tokenExpiry)) {
      return this.token;
    }
    await this.authenticate();
    return this.token!;
  }

  private async authenticate(): Promise<void> {
    try {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = randomHex(16);

      const authorizeUrl = `https://github.com/login/device/code?client_id=${GITHUB_COPILOT_VSCODE_CLIENT_ID}&scope=read:user%20user:email&code_challenge=${codeChallenge}&code_challenge_method=S256&state=${state}`;
      
      logger.info('Opening GitHub Copilot authorization URL in browser...');
      logger.info(`If browser does not open, visit: ${authorizeUrl}`);

      const { exec } = await import('child_process');
      new Promise<void>((resolve, reject) => {
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        exec(`${opener} "${authorizeUrl}"`, (err) => {
          if (err) {
            logger.warn({ err }, 'Failed to open browser');
          }
          resolve();
        });
      });

      const deviceCode = await this.pollForDeviceCode(codeVerifier, state);
      const { accessToken, expiresIn } = await this.pollForAccessToken(deviceCode, codeVerifier);

      this.token = accessToken;
      if (expiresIn) {
        this.tokenExpiry = Date.now() + expiresIn * 1000;
      }

      logger.info('GitHub Copilot authentication successful');
    } catch (err) {
      logger.error({ err }, 'GitHub Copilot authentication failed');
      throw err;
    }
  }

  private async pollForDeviceCode(codeVerifier: string, state: string): Promise<string> {
    throw new Error('Device code flow not fully implemented. Please provide an API token via api_key config.');
  }

  private async pollForAccessToken(deviceCode: string, codeVerifier: string): Promise<{ accessToken: string; expiresIn: number }> {
    throw new Error('Device code flow not fully implemented. Please provide an API token via api_key config.');
  }

  private convertMessage(msg: ProviderMessage): Record<string, unknown> {
    const role = msg.role;
    const content = msg.content;

    if (role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: msg.tool_call_id || '',
        content: typeof content === 'string' ? content : JSON.stringify(content),
      };
    }

    if (role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      return {
        role: 'assistant',
        content: typeof content === 'string' ? content : '',
        tool_calls: msg.tool_calls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
          },
        })),
      };
    }

    return {
      role,
      content: typeof content === 'string' ? content : JSON.stringify(content),
    };
  }

  private convertTools(tools: ProviderToolDefinition[]): Record<string, unknown>[] {
    return tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  private parseResponse(data: Record<string, unknown>): LLMResponse {
    const choices = (data.choices as Record<string, unknown>[] | undefined) || [];
    const first = choices[0] || {};
    const message = (first.message as Record<string, unknown>) || {};
    const content = message.content as string | null | undefined;
    const toolCallsData = message.tool_calls as Record<string, unknown>[] | undefined;

    const toolCalls: ToolCallRequest[] = [];
    if (toolCallsData) {
      for (const tc of toolCallsData) {
        const func = tc.function as Record<string, unknown> || {};
        toolCalls.push({
          id: String(tc.id || ''),
          name: String(func.name || ''),
          arguments: parseToolArguments(String(func.arguments || '{}')),
        });
      }
    }

    const usage = (data.usage as Record<string, number> | undefined) || {};
    const inputTokens = usage.prompt_tokens || 0;
    const outputTokens = usage.completion_tokens || 0;

    return {
      content: content ?? null,
      tool_calls: toolCalls,
      stop_reason: (first.finish_reason as string) || 'stop',
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
      model: data.model as string || '',
      raw: data,
    };
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
    const body: Record<string, unknown> = {
      model: runtime.model || this.defaultModel,
      messages: messages.map(m => this.convertMessage(m)),
      temperature: options?.temperature ?? runtime.temperature,
      max_tokens: Math.max(1, options?.max_tokens ?? runtime.max_tokens),
    };

    if (tools.length > 0) {
      body.tools = this.convertTools(tools);
    }

    const reasoningEffort = options?.reasoning_effort ?? runtime.reasoning_effort;
    if (reasoningEffort && reasoningEffort.toLowerCase() !== 'none') {
      body.reasoning_effort = reasoningEffort;
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
    const token = await this.ensureToken();
    const body = this.buildBody(messages, tools, runtime, options);

    try {
      const response = await this.client.post('/chat/completions', body, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      return this.parseResponse(response.data);
    } catch (err) {
      logger.error({ err }, 'GitHub Copilot provider request failed');
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
    const token = await this.ensureToken();
    const body = {
      ...this.buildBody(messages, tools, runtime, options),
      stream: true,
    };

    const timeoutMs = resolveStreamIdleTimeoutS() * 1000;
    let content = '';
    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();
    let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    let stopReason = 'stop';
    let model = runtime.model;

    try {
      const response = await this.client.post('/chat/completions', body, {
        responseType: 'stream',
        timeout: timeoutMs,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'text/event-stream',
        },
      });

      const stream = response.data as NodeJS.ReadableStream;
      let buffer = '';

      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => {
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
              model = parsed.model || model;

              const choices = parsed.choices as Record<string, unknown>[] | undefined;
              if (!choices || choices.length === 0) continue;

              const delta = (choices[0].delta as Record<string, unknown>) || {};
              if (typeof delta.content === 'string') {
                content += delta.content;
                onDelta({ text_delta: delta.content });
              }

              const reasoningContent = (delta.reasoning_content as string) || (delta.reasoning as unknown as { summary?: string } | undefined)?.summary;
              if (reasoningContent) {
                onDelta({ reasoning_delta: reasoningContent });
              }

              const toolCallDeltas = delta.tool_calls as Record<string, unknown>[] | undefined;
              if (toolCallDeltas) {
                for (const tcDelta of toolCallDeltas) {
                  const index = Number(tcDelta.index || 0);
                  const existing = toolCallBuffers.get(index) || { id: '', name: '', arguments: '' };
                  if (tcDelta.id) existing.id = String(tcDelta.id);
                  const func = tcDelta.function as Record<string, unknown> | undefined;
                  if (func?.name) existing.name = String(func.name);
                  if (func?.arguments) existing.arguments += String(func.arguments);
                  toolCallBuffers.set(index, existing);

                  onDelta({
                    tool_call_delta: {
                      id: existing.id,
                      name: existing.name,
                      arguments_delta: String(func?.arguments || ''),
                    },
                  });
                }
              }

              if (choices[0].finish_reason) {
                stopReason = String(choices[0].finish_reason);
              }

              if (parsed.usage) {
                const u = parsed.usage as Record<string, number>;
                usage = {
                  input_tokens: u.prompt_tokens || 0,
                  output_tokens: u.completion_tokens || 0,
                  total_tokens: u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0),
                };
              }
            } catch (parseErr) {
              logger.warn({ err: parseErr }, 'Failed to parse SSE data');
            }
          }
        });

        stream.on('end', () => resolve());
        stream.on('error', (err) => reject(err));
      });

      const finalToolCalls: ToolCallRequest[] = [];
      for (let i = 0; i < toolCallBuffers.size; i++) {
        const tc = toolCallBuffers.get(i);
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
        tool_calls: finalToolCalls,
        usage,
        stop_reason: stopReason,
        model,
      };
    } catch (err) {
      logger.error({ err }, 'GitHub Copilot provider stream failed');
      throw err;
    }
  }
}
