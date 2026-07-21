import { logger } from '../utils/logger.js';
import { generateId, generateTurnId } from '../utils/helpers.js';
import { MessageBus, InboundMessage, OutboundMessage } from '../bus/queue.js';
import { SessionManager, SessionMessage } from '../session/manager.js';
import { ToolRegistry, createDefaultToolRegistry } from './tools/registry.js';
import { AgentRunner, AgentRunResult, FileEditCallback } from './runner.js';
import { ContextBuilder } from './context.js';
import { ProviderFactoryService } from '../providers/factory.js';
import { LLMRuntime, ProviderMessage, ProviderContentBlock, ToolCallRequest } from '../providers/base.js';
import { Config } from '../config/schema.js';
import { getWorkspacePath } from '../config/paths.js';

export interface AgentLoopOptions {
  config: Config;
  bus?: MessageBus;
  sessionManager?: SessionManager;
  toolRegistry?: ToolRegistry;
  providerFactory?: ProviderFactoryService;
}

export interface ProcessDirectOptions {
  sessionKey?: string;
  channel?: string;
  chatId?: string;
  senderId?: string;
  media?: string[];
  ephemeral?: boolean;
  onStream?: (delta: string) => Promise<void>;
  onReasoning?: (delta: string) => Promise<void>;
  onStreamEnd?: () => Promise<void>;
  onFileEdit?: FileEditCallback;
  model?: string;
  modelPreset?: string;
}

export interface ProcessDirectResult {
  content: string | null;
  messages: ProviderMessage[];
  toolsUsed: string[];
  usage: Record<string, number>;
  stopReason: string;
  error?: string;
}

export class AgentLoop {
  private config: Config;
  private bus: MessageBus;
  private sessionManager: SessionManager;
  private toolRegistry: ToolRegistry;
  private providerFactory: ProviderFactoryService;
  private runner: AgentRunner;
  private running = false;

  constructor(options: AgentLoopOptions) {
    this.config = options.config;
    this.bus = options.bus || new MessageBus();
    this.sessionManager = options.sessionManager || new SessionManager();
    this.toolRegistry = options.toolRegistry || createDefaultToolRegistry();
    this.providerFactory = options.providerFactory || new ProviderFactoryService(
      options.config.providers.items || [],
    );
    this.runner = new AgentRunner();
  }

  static fromConfig(config: Config): AgentLoop {
    return new AgentLoop({ config });
  }

  getBus(): MessageBus {
    return this.bus;
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  getLLMRuntime(override?: { model?: string; modelPreset?: string }): LLMRuntime {
    const defaults = this.config.agents.defaults;
    const model = override?.model || defaults.model;
    const provider = override?.model ? 'auto' : defaults.provider;
    const modelPreset = override?.modelPreset || defaults.model_preset || undefined;

    let resolvedModel = model;
    let resolvedProvider = provider;
    let maxTokens = defaults.max_tokens;
    let contextWindowTokens = defaults.context_window_tokens;
    let temperature = defaults.temperature;
    let reasoningEffort = defaults.reasoning_effort;

    if (modelPreset && this.config.agents.model_presets[modelPreset]) {
      const preset = this.config.agents.model_presets[modelPreset];
      resolvedModel = preset.model;
      resolvedProvider = preset.provider;
      maxTokens = preset.max_tokens;
      contextWindowTokens = preset.context_window_tokens;
      temperature = preset.temperature;
      reasoningEffort = preset.reasoning_effort;
    }

    return {
      model: resolvedModel,
      provider: resolvedProvider,
      max_tokens: maxTokens,
      context_window_tokens: contextWindowTokens,
      temperature,
      reasoning_effort: reasoningEffort,
      model_preset: modelPreset || null,
    };
  }

  async processDirect(
    message: string,
    options: ProcessDirectOptions = {},
  ): Promise<ProcessDirectResult> {
    const sessionKey = options.sessionKey || 'sdk:default';
    const channel = options.channel || 'cli';
    const chatId = options.chatId || 'direct';
    const senderId = options.senderId || 'user';
    const ephemeral = options.ephemeral || false;

    const runtime = this.getLLMRuntime({ 
      model: options.model, 
      modelPreset: options.modelPreset,
    });
    const provider = this.providerFactory.resolveProvider(runtime);

    const workspace = getWorkspacePath(this.config.agents.defaults.workspace);

    const history = await this.sessionManager.getMessages(sessionKey);
    const historyProviderMessages = this.sessionMessagesToProviderMessages(history);

    const userMessage: ProviderMessage = {
      role: 'user',
      content: message,
    };

    const allMessages = [...historyProviderMessages, userMessage];

    const contextBuilder = new ContextBuilder({
      timezone: this.config.agents.defaults.timezone,
      botName: this.config.agents.defaults.bot_name,
      botIcon: this.config.agents.defaults.bot_icon,
      workspace,
      channel,
    });

    const systemWithContext = contextBuilder.buildSystemPrompt();
    const messagesWithSystem: ProviderMessage[] = [
      { role: 'system', content: systemWithContext },
      ...allMessages,
    ];

    const result = await this.runner.run({
      initialMessages: messagesWithSystem,
      tools: this.toolRegistry,
      runtime,
      provider,
      maxIterations: this.config.agents.defaults.max_tool_iterations,
      maxToolResultChars: this.config.agents.defaults.max_tool_result_chars,
      workspace,
      sessionKey,
      channel,
      chatId,
      senderId,
      stream: !!options.onStream,
      onStream: options.onStream,
      onReasoning: options.onReasoning,
      onFileEdit: options.onFileEdit,
    });

    if (!ephemeral) {
      // allMessages = [...history, userMessage]; messagesWithSystem = [system, ...allMessages]
      // result.messages extends messagesWithSystem with assistant responses.
      // Starting at allMessages.length skips system+history but includes the userMessage
      // and all new assistant messages (avoids duplicating the user message).
      const newHistory: Omit<SessionMessage, 'timestamp'>[] = [];

      for (let i = allMessages.length; i < result.messages.length; i++) {
        const msg = result.messages[i];
        newHistory.push({
          role: msg.role,
          content: msg.content,
          tool_calls: msg.tool_calls,
          tool_call_id: msg.tool_call_id,
          name: msg.name,
        });
      }

      try {
        await this.sessionManager.addMessages(sessionKey, newHistory);
      } catch (err) {
        logger.error({ err, sessionKey }, 'Failed to persist session');
      }
    }

    if (options.onStreamEnd) {
      await options.onStreamEnd();
    }

    return {
      content: result.finalContent,
      messages: result.messages,
      toolsUsed: result.toolsUsed,
      usage: result.usage,
      stopReason: result.stopReason,
      error: result.error,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.bus.onInboundMessage(async (msg) => {
      await this.handleInboundMessage(msg);
    });

    logger.info('Agent loop started');
  }

  stop(): void {
    this.running = false;
    logger.info('Agent loop stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  private async handleInboundMessage(msg: InboundMessage): Promise<void> {
    logger.debug({ channel: msg.channel, chat_id: msg.chat_id }, 'Handling inbound message');

    const sessionKey = msg.session_key || this.buildSessionKey(msg);
    const runtime = this.getLLMRuntime();
    const provider = this.providerFactory.resolveProvider(runtime);
    const workspace = getWorkspacePath(this.config.agents.defaults.workspace);

    let responseText = '';
    let streamBuffer = '';

    const onStream = async (delta: string): Promise<void> => {
      streamBuffer += delta;
      this.bus.publish({
        type: 'stream_delta',
        payload: {
          channel: msg.channel,
          chat_id: msg.chat_id,
          text_delta: delta,
        },
      });
    };

    const result = await this.processDirect(msg.text, {
      sessionKey,
      channel: msg.channel,
      chatId: msg.chat_id,
      senderId: msg.sender_id,
      media: msg.media,
      onStream,
    });

    responseText = result.content || '[No response]';

    const outbound: OutboundMessage = {
      id: generateId('msg_'),
      channel: msg.channel,
      chat_id: msg.chat_id,
      text: responseText,
      timestamp: new Date().toISOString(),
      reply_to: msg.id,
    };

    this.bus.publish({
      type: 'outbound_message',
      payload: outbound,
    });

    this.bus.publish({
      type: 'stream_end',
      payload: {
        channel: msg.channel,
        chat_id: msg.chat_id,
        final_text: responseText,
      },
    });
  }

  private buildSessionKey(msg: InboundMessage): string {
    if (this.config.agents.defaults.unified_session) {
      return 'unified:default';
    }
    return `${msg.channel}:${msg.chat_id}`;
  }

  private sessionMessagesToProviderMessages(messages: SessionMessage[]): ProviderMessage[] {
    return messages.map(msg => {
      const providerMsg: ProviderMessage = {
        role: msg.role,
        content: msg.content as string | ProviderContentBlock[],
      };
      if (msg.tool_calls) {
        providerMsg.tool_calls = msg.tool_calls as ToolCallRequest[];
      }
      if (msg.tool_call_id) {
        providerMsg.tool_call_id = msg.tool_call_id;
      }
      if (msg.name) {
        providerMsg.name = msg.name;
      }
      return providerMsg;
    });
  }
}
