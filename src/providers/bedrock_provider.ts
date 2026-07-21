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
  toolArgumentsObjectForReplay,
  ProviderContentBlock,
} from './base.js';
import { logger } from '../utils/logger.js';

const TEMPERATURE_UNSUPPORTED_MODEL_TOKENS = ['claude-opus-4-7'];
const ADAPTIVE_THINKING_ONLY_MODEL_TOKENS = ['claude-opus-4-7'];
const NOOP_TOOL_NAME = 'nanobot_noop';

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      key in merged &&
      typeof merged[key] === 'object' && merged[key] !== null &&
      typeof value === 'object' && value !== null &&
      !Array.isArray(merged[key]) && !Array.isArray(value)
    ) {
      merged[key] = deepMerge(merged[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

export interface BedrockProviderConfig {
  name: string;
  api_key?: string;
  base_url?: string;
  default_model?: string;
  region?: string;
  profile?: string;
  extra_body?: Record<string, unknown>;
}

export class BedrockProvider extends LLMProvider {
  name = 'bedrock';
  private config: BedrockProviderConfig;
  defaultModel: string;
  region: string;
  profile?: string;
  private extraBody: Record<string, unknown>;
  private client: unknown = null;

  constructor(config: BedrockProviderConfig) {
    super();
    this.config = config;
    this.name = config.name || 'bedrock';
    this.defaultModel = config.default_model || 'bedrock/global.anthropic.claude-opus-4-7';
    this.region = config.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
    this.profile = config.profile;
    this.extraBody = config.extra_body || {};
    this.client = null;
  }

  private async ensureClient(): Promise<unknown> {
    if (this.client) return this.client;

    try {
      // @ts-ignore - dynamic import for optional dependency
      const boto3Module = await import('@aws-sdk/client-bedrock-runtime');
      const { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand } = boto3Module;

      const clientConfig: Record<string, unknown> = {
        region: this.region,
      };

      if (this.config.base_url) {
        clientConfig.endpoint = this.config.base_url;
      }

      if (this.config.api_key) {
        clientConfig.credentials = {
          accessKeyId: this.config.api_key,
          secretAccessKey: '',
          sessionToken: '',
        };
      }

      this.client = {
        runtime: new BedrockRuntimeClient(clientConfig),
        ConverseCommand,
        ConverseStreamCommand,
      };
      return this.client;
    } catch (err) {
      logger.error({ err }, 'Failed to load AWS Bedrock SDK. Install @aws-sdk/client-bedrock-runtime.');
      throw new Error('AWS Bedrock provider requires @aws-sdk/client-bedrock-runtime');
    }
  }

  private static stripPrefix(model: string): string {
    if (model.startsWith('bedrock/')) {
      return model.slice('bedrock/'.length);
    }
    return model;
  }

  private static matchesModelToken(model: string, tokens: string[]): boolean {
    const modelLower = model.toLowerCase();
    return tokens.some(token => modelLower.includes(token));
  }

  private static supportsTemperature(model: string): boolean {
    return !BedrockProvider.matchesModelToken(model, TEMPERATURE_UNSUPPORTED_MODEL_TOKENS);
  }

  private static usesAdaptiveThinkingOnly(model: string): boolean {
    return BedrockProvider.matchesModelToken(model, ADAPTIVE_THINKING_ONLY_MODEL_TOKENS);
  }

  private static contentBlocks(content: unknown, forToolResult: boolean = false): Record<string, unknown>[] {
    if (typeof content === 'string' || content === null || content === undefined) {
      return [{ text: content || '(empty)' }];
    }
    if (!Array.isArray(content)) {
      if (forToolResult && typeof content === 'object' && content !== null) {
        return [{ json: content }];
      }
      return [{ text: String(content) }];
    }

    const blocks: Record<string, unknown>[] = [];
    const textBlockTypes = new Set(['text', 'input_text', 'output_text']);

    for (const item of content) {
      if (typeof item !== 'object' || item === null) {
        blocks.push({ text: String(item) });
        continue;
      }

      const itemObj = item as Record<string, unknown>;
      const itemType = itemObj.type as string | undefined;

      if ((itemType && textBlockTypes.has(itemType)) || 'text' in itemObj) {
        const text = itemObj.text;
        if (text) {
          blocks.push({ text: String(text) });
        }
        continue;
      }

      if (itemType === 'image_url') {
        const converted = BedrockProvider.imageUrlBlock(itemObj);
        if (converted) {
          blocks.push(converted);
        }
        continue;
      }

      let found = false;
      for (const key of ['text', 'image', 'document', 'video', 'json', 'searchResult']) {
        if (key in itemObj) {
          blocks.push({ [key]: itemObj[key] });
          found = true;
          break;
        }
      }
      if (!found) {
        blocks.push(forToolResult ? { json: itemObj } : { text: JSON.stringify(itemObj) });
      }
    }

    return blocks.length > 0 ? blocks : [{ text: '(empty)' }];
  }

  private static imageUrlBlock(block: Record<string, unknown>): Record<string, unknown> | null {
    const url = ((block.image_url as Record<string, unknown> | undefined) || {}).url as string || '';
    if (!url) return null;
    return { text: `(image URL: ${url})` };
  }

  private static systemBlocks(content: unknown): Record<string, unknown>[] {
    const blocks = BedrockProvider.contentBlocks(content);
    return blocks.filter(block => 'text' in block || 'cachePoint' in block || 'guardContent' in block);
  }

  private static toolResultBlock(msg: ProviderMessage): Record<string, unknown> {
    return {
      toolResult: {
        toolUseId: String(msg.tool_call_id || ''),
        content: BedrockProvider.contentBlocks(msg.content, true),
        status: 'success',
      },
    };
  }

  private static toolUseBlock(toolCall: Record<string, unknown>): Record<string, unknown> | null {
    const func = toolCall.function as Record<string, unknown> | undefined;
    if (!func) return null;
    const args = toolArgumentsObjectForReplay(func.arguments);
    return {
      toolUse: {
        toolUseId: String(toolCall.id || ''),
        name: String(func.name || ''),
        input: args,
      },
    };
  }

  private static reasoningBlock(block: Record<string, unknown>): Record<string, unknown> | null {
    if (!['thinking', 'reasoning', 'redacted_thinking'].includes(block.type as string)) {
      return null;
    }
    const text = (block.thinking as string | undefined) || (block.text as string | undefined);
    const signature = block.signature as string | undefined;
    if (text && signature) {
      return {
        reasoningContent: {
          reasoningText: { text: String(text), signature: String(signature) },
        },
      };
    }
    return null;
  }

  private static assistantBlocks(msg: ProviderMessage): Record<string, unknown>[] {
    const blocks: Record<string, unknown>[] = [];

    const thinkingBlocks = (msg as unknown as Record<string, unknown>).thinking_blocks as Record<string, unknown>[] | undefined;
    if (thinkingBlocks) {
      for (const thinking of thinkingBlocks) {
        if (typeof thinking === 'object' && thinking !== null) {
          const reasoning = BedrockProvider.reasoningBlock(thinking);
          if (reasoning) {
            blocks.push(reasoning);
          }
        }
      }
    }

    const content = msg.content;
    if (typeof content === 'string' && content) {
      blocks.push({ text: content });
    } else if (Array.isArray(content)) {
      blocks.push(...BedrockProvider.contentBlocks(content).filter(b => 'text' in b));
    }

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const toolCall of msg.tool_calls) {
        const block = BedrockProvider.toolUseBlock(toolCall as unknown as Record<string, unknown>);
        if (block) {
          blocks.push(block);
        }
      }
    }

    return blocks.length > 0 ? blocks : [{ text: '' }];
  }

  private static hasToolUse(msg: Record<string, unknown>): boolean {
    const content = msg.content;
    return Array.isArray(content) && content.some(block =>
      typeof block === 'object' && block !== null && 'toolUse' in block
    );
  }

  private static mergeConsecutive(messages: Record<string, unknown>[]): Record<string, unknown>[] {
    const merged: Record<string, unknown>[] = [];
    for (const msg of messages) {
      if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
        const prev = merged[merged.length - 1];
        let prevContent = prev.content;
        const curContent = msg.content || [];
        if (!Array.isArray(prevContent)) {
          prevContent = [{ text: String(prevContent) }];
          prev.content = prevContent;
        }
        if (Array.isArray(curContent)) {
          (prevContent as Record<string, unknown>[]).push(...curContent);
        } else {
          (prevContent as Record<string, unknown>[]).push({ text: String(curContent) });
        }
      } else {
        merged.push({ ...msg });
      }
    }

    let lastPopped: Record<string, unknown> | null = null;
    while (merged.length > 0 && merged[merged.length - 1].role === 'assistant') {
      lastPopped = merged.pop()!;
    }
    if (merged.length === 0 && lastPopped !== null && !BedrockProvider.hasToolUse(lastPopped)) {
      merged.push({ role: 'user', content: lastPopped.content || [{ text: '(empty)' }] });
    }
    if (merged.length > 0 && merged[0].role === 'assistant' && !BedrockProvider.hasToolUse(merged[0])) {
      merged.unshift({ role: 'user', content: [{ text: '(conversation continued)' }] });
    }
    return merged;
  }

  private convertMessages(messages: ProviderMessage[]): [Record<string, unknown>[], Record<string, unknown>[]] {
    const system: Record<string, unknown>[] = [];
    const converted: Record<string, unknown>[] = [];

    for (const msg of messages) {
      const role = msg.role;
      const content = msg.content;

      if (role === 'system') {
        system.push(...BedrockProvider.systemBlocks(content));
        continue;
      }
      if (role === 'tool') {
        const block = BedrockProvider.toolResultBlock(msg);
        if (converted.length > 0 && converted[converted.length - 1].role === 'user') {
          const prev = converted[converted.length - 1];
          if (!Array.isArray(prev.content)) {
            prev.content = [];
          }
          (prev.content as Record<string, unknown>[]).push(block);
        } else {
          converted.push({ role: 'user', content: [block] });
        }
        continue;
      }
      if (role === 'assistant') {
        converted.push({ role: 'assistant', content: BedrockProvider.assistantBlocks(msg) });
        continue;
      }
      if (role === 'user') {
        converted.push({ role: 'user', content: BedrockProvider.contentBlocks(content) });
      }
    }

    return [system, BedrockProvider.mergeConsecutive(converted)];
  }

  private static convertTools(tools: ProviderToolDefinition[] | null): Record<string, unknown>[] | null {
    if (!tools || tools.length === 0) return null;
    const result: Record<string, unknown>[] = [];
    for (const tool of tools) {
      const name = tool.name;
      if (!name) continue;
      const spec: Record<string, unknown> = {
        name,
        inputSchema: {
          json: tool.input_schema || { type: 'object', properties: {} },
        },
      };
      if (tool.description) {
        spec.description = String(tool.description);
      }
      result.push({ toolSpec: spec });
    }
    return result.length > 0 ? result : null;
  }

  private static containsToolBlocks(messages: Record<string, unknown>[]): boolean {
    for (const msg of messages) {
      const content = msg.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (typeof block === 'object' && block !== null && ('toolUse' in block || 'toolResult' in block)) {
          return true;
        }
      }
    }
    return false;
  }

  private static noopTool(): Record<string, unknown> {
    return {
      toolSpec: {
        name: NOOP_TOOL_NAME,
        description: 'Internal placeholder for Bedrock tool history validation.',
        inputSchema: { json: { type: 'object', properties: {} } },
      },
    };
  }

  private static convertToolChoice(toolChoice: string | Record<string, unknown> | null | undefined): Record<string, unknown> | null {
    if (toolChoice === null || toolChoice === undefined || toolChoice === 'auto') {
      return { auto: {} };
    }
    if (toolChoice === 'required') {
      return { any: {} };
    }
    if (toolChoice === 'none') {
      return null;
    }
    if (typeof toolChoice === 'object') {
      const name = ((toolChoice.function as Record<string, unknown> | undefined) || {}).name as string | undefined;
      if (name) {
        return { tool: { name: String(name) } };
      }
    }
    return { auto: {} };
  }

  private static adaptiveThinking(reasoningEffort: string | null | undefined): Record<string, unknown> | null {
    if (!reasoningEffort) return null;
    const effort = reasoningEffort.toLowerCase();
    if (effort === 'none') return null;
    const thinking: Record<string, unknown> = { type: 'adaptive' };
    if (effort !== 'adaptive') {
      thinking.effort = effort;
    }
    return thinking;
  }

  private buildKwargs(
    messages: ProviderMessage[],
    tools: ProviderToolDefinition[],
    runtime: LLMRuntime,
    options?: {
      temperature?: number;
      max_tokens?: number;
      reasoning_effort?: string | null;
    },
  ): Record<string, unknown> {
    const modelId = BedrockProvider.stripPrefix(runtime.model || this.defaultModel);
    const [system, bedrockMessages] = this.convertMessages(messages);
    const finalMessages = bedrockMessages.length > 0
      ? bedrockMessages
      : [{ role: 'user', content: [{ text: '(empty)' }] }];

    const kwargs: Record<string, unknown> = {
      modelId,
      messages: finalMessages,
      inferenceConfig: { maxTokens: Math.max(1, options?.max_tokens ?? runtime.max_tokens) },
    };

    if (system.length > 0) {
      kwargs.system = system;
    }
    if (BedrockProvider.supportsTemperature(modelId)) {
      (kwargs.inferenceConfig as Record<string, unknown>).temperature = options?.temperature ?? runtime.temperature;
    }

    let additional: Record<string, unknown> = {};
    if (BedrockProvider.usesAdaptiveThinkingOnly(modelId)) {
      const thinking = BedrockProvider.adaptiveThinking(options?.reasoning_effort ?? runtime.reasoning_effort);
      if (thinking) {
        additional.thinking = thinking;
      }
    }
    if (Object.keys(this.extraBody).length > 0) {
      additional = deepMerge(additional, this.extraBody);
    }
    if (Object.keys(additional).length > 0) {
      kwargs.additionalModelRequestFields = additional;
    }

    const bedrockTools = BedrockProvider.convertTools(tools);
    let toolConfig: Record<string, unknown> | null = null;
    if (bedrockTools) {
      toolConfig = { tools: bedrockTools };
      const choice = BedrockProvider.convertToolChoice('auto');
      if (choice) {
        toolConfig.toolChoice = choice;
      }
    } else if (BedrockProvider.containsToolBlocks(finalMessages)) {
      toolConfig = { tools: [BedrockProvider.noopTool()] };
    }

    if (toolConfig) {
      kwargs.toolConfig = toolConfig;
    }

    return kwargs;
  }

  private static finishReason(stopReason: string | null | undefined): string {
    const map: Record<string, string> = {
      end_turn: 'stop',
      tool_use: 'tool_calls',
      max_tokens: 'length',
    };
    return map[stopReason || ''] || stopReason || 'stop';
  }

  private static usage(usage: Record<string, unknown> | null | undefined): {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  } {
    if (!usage) {
      return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    }
    const prompt = Number(usage.inputTokens || 0);
    const completion = Number(usage.outputTokens || 0);
    const total = Number(usage.totalTokens || prompt + completion);
    const result: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      cache_read_tokens?: number;
      cache_write_tokens?: number;
    } = {
      input_tokens: prompt,
      output_tokens: completion,
      total_tokens: total,
    };
    const cacheRead = Number(usage.cacheReadInputTokens || 0);
    const cacheWrite = Number(usage.cacheWriteInputTokens || 0);
    if (cacheRead > 0) {
      result.cache_read_tokens = cacheRead;
    }
    if (cacheWrite > 0) {
      result.cache_write_tokens = cacheWrite;
    }
    return result;
  }

  private static parseResponse(response: Record<string, unknown>): LLMResponse {
    const contentParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: ToolCallRequest[] = [];
    const thinkingBlocks: Record<string, unknown>[] = [];
    const message = ((response.output as Record<string, unknown>)?.message as Record<string, unknown>) || {};

    const content = (message.content as Record<string, unknown>[] | undefined) || [];
    for (const block of content) {
      if (typeof block !== 'object') continue;
      if (typeof block.text === 'string') {
        contentParts.push(block.text);
      }
      const toolUse = block.toolUse as Record<string, unknown> | undefined;
      if (toolUse) {
        const args = toolUse.input || {};
        toolCalls.push({
          id: String(toolUse.toolUseId || ''),
          name: String(toolUse.name || ''),
          arguments: args,
        });
      }
    }

    return {
      content: contentParts.length > 0 ? contentParts.join('') : null,
      tool_calls: toolCalls,
      stop_reason: BedrockProvider.finishReason(response.stopReason as string | undefined),
      usage: BedrockProvider.usage(response.usage as Record<string, unknown> | undefined),
      model: response.modelId as string || '',
      raw: response,
      reasoning_content: reasoningParts.length > 0 ? reasoningParts.join('') : undefined,
    };
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
    try {
      const clientBundle = await this.ensureClient() as {
        runtime: { send: (cmd: unknown) => Promise<Record<string, unknown>> };
        ConverseCommand: new (params: Record<string, unknown>) => unknown;
      };
      const kwargs = this.buildKwargs(messages, tools, runtime, options);
      const command = new clientBundle.ConverseCommand(kwargs);
      const response = await clientBundle.runtime.send(command);
      return BedrockProvider.parseResponse(response);
    } catch (err) {
      logger.error({ err }, 'Bedrock provider request failed');
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
    const timeoutMs = resolveStreamIdleTimeoutS() * 1000;
    const contentParts: string[] = [];
    const reasoningParts: string[] = [];
    const thinkingBlocks: Record<string, unknown>[] = [];
    const toolBuffers = new Map<number, Record<string, unknown>>();
    const state: Record<string, unknown> = {};

    try {
      const clientBundle = await this.ensureClient() as {
        runtime: { send: (cmd: unknown) => Promise<Record<string, unknown>> };
        ConverseStreamCommand: new (params: Record<string, unknown>) => unknown;
      };
      const kwargs = this.buildKwargs(messages, tools, runtime, options);
      const command = new clientBundle.ConverseStreamCommand(kwargs);
      const response = await clientBundle.runtime.send(command);

      const stream = response.stream as AsyncIterable<Record<string, unknown>> | undefined;
      if (stream) {
        for await (const event of stream) {
          this.parseStreamEvent(
            event,
            contentParts,
            reasoningParts,
            thinkingBlocks,
            toolBuffers,
            state,
            onDelta,
          );
        }
      }

      return this.streamResult(contentParts, reasoningParts, thinkingBlocks, toolBuffers, state, runtime.model);
    } catch (err) {
      logger.error({ err }, 'Bedrock provider stream failed');
      throw err;
    }
  }

  private parseStreamEvent(
    event: Record<string, unknown>,
    contentParts: string[],
    reasoningParts: string[],
    thinkingBlocks: Record<string, unknown>[],
    toolBuffers: Map<number, Record<string, unknown>>,
    state: Record<string, unknown>,
    onDelta: StreamCallback,
  ): void {
    if ('contentBlockStart' in event) {
      const data = event.contentBlockStart as Record<string, unknown>;
      const idx = Number(data.contentBlockIndex || 0);
      const start = (data.start as Record<string, unknown>) || {};
      const toolUse = start.toolUse as Record<string, unknown> | undefined;
      if (toolUse) {
        toolBuffers.set(idx, {
          id: String(toolUse.toolUseId || ''),
          name: String(toolUse.name || ''),
          input: '',
        });
      }
    } else if ('contentBlockDelta' in event) {
      const data = event.contentBlockDelta as Record<string, unknown>;
      const idx = Number(data.contentBlockIndex || 0);
      const delta = (data.delta as Record<string, unknown>) || {};
      const text = delta.text;
      if (typeof text === 'string') {
        contentParts.push(text);
        onDelta({ text_delta: text });
      }
      const toolDelta = delta.toolUse as Record<string, unknown> | undefined;
      if (toolDelta) {
        const buf = toolBuffers.get(idx) || { id: '', name: '', input: '' };
        if (typeof toolDelta.input === 'string') {
          buf.input = (buf.input as string) + toolDelta.input;
          onDelta({
            tool_call_delta: {
              id: buf.id as string,
              name: buf.name as string,
              arguments_delta: toolDelta.input,
            },
          });
        }
        toolBuffers.set(idx, buf);
      }
    } else if ('contentBlockStop' in event) {
      const data = event.contentBlockStop as Record<string, unknown>;
      const idx = Number((data || {}).contentBlockIndex || 0);
    } else if ('messageStop' in event) {
      const data = event.messageStop as Record<string, unknown>;
      state.stop_reason = (data || {}).stopReason;
    } else if ('metadata' in event) {
      const metadata = event.metadata as Record<string, unknown> || {};
      if (typeof metadata.usage === 'object' && metadata.usage !== null) {
        state.usage = metadata.usage;
      }
    }
  }

  private streamResult(
    contentParts: string[],
    reasoningParts: string[],
    thinkingBlocks: Record<string, unknown>[],
    toolBuffers: Map<number, Record<string, unknown>>,
    state: Record<string, unknown>,
    model: string,
  ): StreamResult {
    const toolCalls: ToolCallRequest[] = [];
    for (const buf of toolBuffers.values()) {
      let args: unknown = {};
      if (buf.input) {
        args = parseToolArguments(buf.input as string);
      }
      toolCalls.push({
        id: (buf.id as string) || '',
        name: (buf.name as string) || '',
        arguments: args,
      });
    }
    return {
      content: contentParts.join(''),
      reasoning_content: reasoningParts.length > 0 ? reasoningParts.join('') : undefined,
      tool_calls: toolCalls,
      usage: BedrockProvider.usage(state.usage as Record<string, unknown> | undefined),
      stop_reason: BedrockProvider.finishReason(state.stop_reason as string | undefined),
      model,
    };
  }
}
