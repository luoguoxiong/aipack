import path from 'path';
import { Agent, AgentHarness } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Model, AssistantMessage, ImageContent, TextContent, Context, SimpleStreamOptions, Api } from "@earendil-works/pi-ai";
import { loadConfig, getConfigPath } from "./config/loader";
import { Config, defaultConfig } from "./config/schema";
import { createDefaultToolRegistry, ToolRegistry } from "./tools/registry";
import { setMemoryBaseDir } from "./tools/memory";
import { getWorkspacePath } from "./config/paths";
import { ContextBuilder } from "./agent/context";
import { SessionManager, createSessionManager } from "./storage/session-manager";
import type { MessageEntry, SessionTreeEntry } from "./storage/types";
import { logger, createLogger } from "./utils/logger";

export const STREAM_EVENT_RUN_STARTED = 'run_started';
export const STREAM_EVENT_RUN_COMPLETED = 'run_completed';
export const STREAM_EVENT_RUN_FAILED = 'run_failed';
export const STREAM_EVENT_TEXT_DELTA = 'text_delta';
export const STREAM_EVENT_TEXT_COMPLETED = 'text_completed';
export const STREAM_EVENT_REASONING_DELTA = 'reasoning_delta';
export const STREAM_EVENT_REASONING_COMPLETED = 'reasoning_completed';
export const STREAM_EVENT_TOOL_STARTED = 'tool_started';
export const STREAM_EVENT_TOOL_COMPLETED = 'tool_completed';
export const STREAM_EVENT_TOOL_FAILED = 'tool_failed';
export const STREAM_EVENT_FILE_EDIT = 'file_edit';
export const STREAM_EVENT_TYPES = [
  STREAM_EVENT_RUN_STARTED,
  STREAM_EVENT_RUN_COMPLETED,
  STREAM_EVENT_RUN_FAILED,
  STREAM_EVENT_TEXT_DELTA,
  STREAM_EVENT_TEXT_COMPLETED,
  STREAM_EVENT_REASONING_DELTA,
  STREAM_EVENT_REASONING_COMPLETED,
  STREAM_EVENT_TOOL_STARTED,
  STREAM_EVENT_TOOL_COMPLETED,
  STREAM_EVENT_TOOL_FAILED,
  STREAM_EVENT_FILE_EDIT,
] as const;

export type StreamEventType = typeof STREAM_EVENT_TYPES[number];

export interface FileEditEventData {
  edit_type: 'start' | 'end' | 'error';
  call_id: string;
  tool_name: string;
  file_path?: string;
  action?: string;
  error?: string;
}

export interface StreamEvent {
  type: StreamEventType;
  content?: string;
  error?: string;
  usage?: Record<string, number>;
  metadata?: Record<string, unknown>;
  result?: RunResult;
  tool_name?: string;
  tool_call_id?: string;
  file_edit?: FileEditEventData;
}

export interface RunResult {
  content: string;
  toolsUsed: string[];
  usage: Record<string, number>;
  stopReason: string;
  metadata: Record<string, unknown>;
  error?: string;
}

export interface SessionInfo {
  key: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionDetail {
  key: string;
  createdAt: string;
  updatedAt: string;
  entries: Array<{
    id: string;
    parentId: string | null;
    type: string;
    timestamp: string;
    provider?: string;
    modelId?: string;
    message?: { role: string; content?: string };
    toolName?: string;
    toolCallId?: string;
    input?: Record<string, unknown>;
    content?: string;
    isError?: boolean;
    usage?: {
      input?: number;
      output?: number;
      total?: number;
    };
  }>;
}

export interface SessionSnapshot {
  key: string;
  messages: unknown[];
  metadata: Record<string, unknown>;
}

export interface RunOptions {
  sessionKey?: string;
  channel?: string;
  chatId?: string;
  senderId?: string;
  media?: string[];
  ephemeral?: boolean;
  model?: string;
  modelPreset?: string;
}

export interface NanobotOptions {
  config?: Config;
  configPath?: string;
  workspace?: string;
  model?: string;
  modelPreset?: string;
}

const FILE_EDIT_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'delete_file',
  'rename_file',
  'create_directory',
  'remove_directory',
]);

function extractTextContent(content: AssistantMessage['content']): string {
  return content
    .filter((c): c is TextContent => c.type === 'text')
    .map(c => c.text)
    .join('');
}

export class Nanobot {
  private config: Config;
  private toolRegistry: ToolRegistry;
  private agent: Agent | null = null;
  private agents: Map<string, Agent> = new Map();
  private models: any;
  private sessionManager: SessionManager;

  private constructor(config: Config, toolRegistry: ToolRegistry, models: any) {
    this.config = config;
    this.toolRegistry = toolRegistry;
    this.models = models;
    this.sessionManager = createSessionManager({
      storageType: config.sessions?.storage === 'file' ? 'file' : 'memory',
      storagePath: config.sessions?.storage_path,
    });
  }

  static async fromConfig(options: NanobotOptions = {}): Promise<Nanobot> {
    logger.info({ options }, 'Initializing Nanobot from config');
    
    let config: Config;
    if (options.config) {
      config = options.config;
    } else {
      const configPath = options.configPath 
        ? path.resolve(options.configPath.replace('~', process.env.HOME || ''))
        : getConfigPath();
      logger.debug({ configPath }, 'Loading config');
      config = await loadConfig(configPath);
    }

    if (options.workspace) {
      config.agents.defaults.workspace = path.resolve(
        options.workspace.replace('~', process.env.HOME || ''),
      );
    }
    if (options.model) {
      config.agents.defaults.model_preset = undefined;
      config.agents.defaults.model = options.model;
      config.agents.defaults.provider = 'auto';
    } else if (options.modelPreset) {
      config.agents.defaults.model_preset = options.modelPreset;
    }

    // 使用配置初始化日志记录器
    if (config.logging) {
      createLogger(config.logging);
    }

    logger.debug({ model: config.agents.defaults.model, provider: config.agents.defaults.provider }, 'Model configuration');
    
    const toolRegistry = createDefaultToolRegistry();
    if (config.memory.base_dir) {
      setMemoryBaseDir(getWorkspacePath(config.memory.base_dir));
    }

    const models = builtinModels();
    logger.info({ modelCount: models.getModels().length }, 'Loaded models');

    return new Nanobot(config, toolRegistry, models);
  }

  private resolveModel(modelName?: string, modelPreset?: string): Model<any> {
    const defaults = this.config.agents.defaults;
    const resolvedModelName = modelName || defaults.model;
    const resolvedProvider = defaults.provider || 'auto';
    
    let model: Model<any> | undefined;
    try {
      const allModels: Model<any>[] = this.models.getModels();
      
      // 先尝试在配置的提供商中精确匹配
      if (resolvedProvider !== 'auto') {
        model = allModels.find((m: Model<any>) => m.id === resolvedModelName && m.provider === resolvedProvider);
      }
      
      // 如果未匹配到配置的提供商，尝试在 openai 提供商中精确匹配（最常见）
      if (!model) {
        model = allModels.find((m: Model<any>) => m.id === resolvedModelName && m.provider === 'openai');
      }
      
      // 如果仍未匹配，查找任意提供商中 ID 匹配的模型
      if (!model) {
        model = allModels.find((m: Model<any>) => m.id === resolvedModelName);
      }
      
      // 如果未精确匹配，尝试从配置的提供商中获取模型
      if (!model && resolvedProvider !== 'auto') {
        const providerModels = allModels.filter((m: Model<any>) => m.provider === resolvedProvider);
        if (providerModels.length > 0) {
          model = providerModels[0];
        }
      }
      
      // 如果仍未匹配，尝试查找任意 openai 模型
      if (!model) {
        const openaiModels = allModels.filter((m: Model<any>) => m.provider === 'openai');
        if (openaiModels.length > 0) {
          model = openaiModels[0];
        }
      }
      
      // 如果仍未匹配，使用第一个模型作为回退
      if (!model && allModels.length > 0) {
        model = allModels[0];
      }
      
      if (!model) {
        throw new Error('No models available');
      }
    } catch {
      model = {
        id: resolvedModelName,
        name: resolvedModelName,
        api: 'unknown',
        provider: resolvedProvider === 'auto' ? 'openai' : resolvedProvider,
        baseUrl: '',
        reasoning: false,
        input: [],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: defaults.context_window_tokens,
        maxTokens: defaults.max_tokens,
      };
    }

    return model!;
  }

  private async getOrCreateAgent(sessionKey: string): Promise<Agent> {
    if (this.agents.has(sessionKey)) {
      return this.agents.get(sessionKey)!;
    }

    const tools = this.toolRegistry.getAgentTools();
    const contextBuilder = ContextBuilder.create(this.config);
    const systemPrompt = contextBuilder.buildSystemPrompt();

    // 加载已保存的会话以恢复状态
    const savedSession = await this.sessionManager.loadSession(sessionKey);
    let model = this.resolveModel();
    let messages: AgentMessage[] = [];

    if (savedSession && savedSession.entries.length > 0) {
      // 恢复消息
      messages = savedSession.entries
        .filter((entry: SessionTreeEntry): entry is MessageEntry => entry.type === 'message')
        .map((entry: MessageEntry) => entry.message);

      // 恢复上次使用的模型
      const lastModelChange = [...savedSession.entries]
        .reverse()
        .find(entry => entry.type === 'model_change' || 
                      (entry.type === 'message' && entry.message.role === 'assistant' && entry.message.provider));
      
      if (lastModelChange) {
        let restoredProvider: string | undefined;
        let restoredModelId: string | undefined;
        
        if (lastModelChange.type === 'model_change') {
          restoredProvider = lastModelChange.provider;
          restoredModelId = lastModelChange.modelId;
        } else if (lastModelChange.type === 'message' && lastModelChange.message.role === 'assistant') {
          const msg = lastModelChange.message;
          if (msg.provider && msg.model) {
            restoredProvider = msg.provider;
            restoredModelId = msg.model;
          }
        }
        
        if (restoredProvider && restoredModelId) {
          try {
            const restoredModel = this.models.getModel(restoredModelId, restoredProvider);
            if (restoredModel) {
              model = restoredModel;
            }
          } catch {
            // 如果模型未找到，使用回退
            model = {
              id: restoredModelId,
              name: restoredModelId,
              api: 'unknown',
              provider: restoredProvider,
              baseUrl: '',
              reasoning: false,
              input: [],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: this.config.agents?.defaults?.context_window_tokens || 200000,
              maxTokens: this.config.agents?.defaults?.max_tokens || 8192,
            };
          }
        }
      }
    }

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        thinkingLevel: 'off',
        tools,
        messages,
      },
      streamFn: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
        return this.models.streamSimple(model, context, options);
      },
    });

    this.agents.set(sessionKey, agent);
    return agent;
  }

  async run(message: string, options: RunOptions = {}): Promise<RunResult> {
    const sessionKey = options.sessionKey || 'sdk:default';
    const sessionStorage = this.sessionManager.getSessionStorage(sessionKey);
    
    const traceId = await sessionStorage.createEntryId();
    const parentId = await sessionStorage.getLeafId();
    
    logger.info({ sessionKey, traceId, parentId, message: message.substring(0, 50) }, 'Running message');

    const agent = await this.getOrCreateAgent(sessionKey);
    const model = agent.state.model;

    const toolsUsed: string[] = [];
    let finalContent = '';
    let stopReason = 'completed';
    let error: string | undefined;

    // 存储模型信息
    if (model) {
      await sessionStorage.appendEntry({
        type: 'model_change',
        id: await sessionStorage.createEntryId(),
        parentId,
        timestamp: new Date().toISOString(),
        provider: model.provider,
        modelId: model.id,
      });
    }

    const unsubscribe = agent.subscribe(async (event) => {
      switch (event.type) {
        case 'agent_start':
          logger.info({ sessionKey, traceId }, '[AGENT_START] Agent run started');
          break;
        case 'agent_end':
          logger.info({ sessionKey, traceId, messageCount: event.messages.length }, '[AGENT_END] Agent run completed');
          break;
        case 'turn_start':
          logger.debug({ sessionKey, traceId }, '[TURN_START] Turn started');
          break;
        case 'turn_end':
          const turnMsg = event.message as AssistantMessage;
          logger.debug({ sessionKey, traceId, stopReason: turnMsg.stopReason, toolResultCount: event.toolResults.length }, '[TURN_END] Turn completed');
          break;
        case 'message_start':
          logger.debug({ sessionKey, traceId, role: event.message.role }, '[MESSAGE_START] Message started');
          break;
        case 'message_update':
          break;
        case 'message_end':
          const msg = event.message as AssistantMessage;
          logger.debug({ sessionKey, traceId, role: event.message.role, stopReason: msg.stopReason }, '[MESSAGE_END] Message completed');
          
          // 存储消息条目
          await sessionStorage.appendEntry({
            type: 'message',
            id: await sessionStorage.createEntryId(),
            parentId: await sessionStorage.getLeafId(),
            timestamp: new Date().toISOString(),
            message: event.message,
          });
          
          if (event.message.role === 'assistant') {
            finalContent = extractTextContent(msg.content);
            stopReason = msg.stopReason || 'completed';
            error = msg.errorMessage;
            
            // 存储 token 用量
            if (msg.usage) {
              await sessionStorage.appendEntry({
                type: 'token_usage',
                id: await sessionStorage.createEntryId(),
                parentId: await sessionStorage.getLeafId(),
                timestamp: new Date().toISOString(),
                usage: msg.usage,
              });
            }
          }
          break;
        case 'tool_execution_start':
          logger.info({ sessionKey, traceId, toolName: event.toolName, toolCallId: event.toolCallId, args: event.args }, '[TOOL_START] Tool execution started');
          
          // 存储工具调用条目
          await sessionStorage.appendEntry({
            type: 'tool_call',
            id: await sessionStorage.createEntryId(),
            parentId: await sessionStorage.getLeafId(),
            timestamp: new Date().toISOString(),
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.args || {},
          });
          
          if (!toolsUsed.includes(event.toolName)) {
            toolsUsed.push(event.toolName);
          }
          break;
        case 'tool_execution_update':
          logger.debug({ sessionKey, traceId, toolName: event.toolName, toolCallId: event.toolCallId }, '[TOOL_UPDATE] Tool execution in progress');
          break;
        case 'tool_execution_end':
          logger.info({ sessionKey, traceId, toolName: event.toolName, toolCallId: event.toolCallId, success: !event.isError }, '[TOOL_END] Tool execution completed');
          
          // 存储工具结果条目
          const resultContent = event.result?.content?.filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('') || '';
          await sessionStorage.appendEntry({
            type: 'tool_result',
            id: await sessionStorage.createEntryId(),
            parentId: await sessionStorage.getLeafId(),
            timestamp: new Date().toISOString(),
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: (event as any).args || {},
            content: resultContent,
            isError: event.isError,
            usage: event.result?.usage,
          });
          break;
      }
    });

    try {
      await agent.prompt(message);
    } catch (err) {
      error = (err as Error).message;
      stopReason = 'error';
    } finally {
      unsubscribe();
    }

    return {
      content: finalContent,
      toolsUsed,
      usage: {},
      stopReason,
      metadata: {
        traceId,
        parentId,
        model: model ? { provider: model.provider, modelId: model.id } : null,
      },
      error,
    };
  }

  async *stream(
    message: string,
    options: RunOptions = {},
  ): AsyncGenerator<StreamEvent> {
    const sessionKey = options.sessionKey || 'sdk:default';
    const sessionStorage = this.sessionManager.getSessionStorage(sessionKey);
    const agent = await this.getOrCreateAgent(sessionKey);
    const model = agent.state.model;

    // 存储模型信息
    if (model) {
      await sessionStorage.appendEntry({
        type: 'model_change',
        id: await sessionStorage.createEntryId(),
        parentId: await sessionStorage.getLeafId(),
        timestamp: new Date().toISOString(),
        provider: model.provider,
        modelId: model.id,
      });
    }

    yield {
      type: STREAM_EVENT_RUN_STARTED,
      metadata: {
        session_key: sessionKey,
        channel: options.channel || 'cli',
        chat_id: options.chatId || 'direct',
        sender_id: options.senderId || 'user',
      },
    };

    const toolsUsed: string[] = [];
    let finalContent = '';
    let stopReason = 'completed';
    let error: string | undefined;

    const eventQueue: StreamEvent[] = [];
    let resolveNext: ((value: StreamEvent) => void) | null = null;

    const pushEvent = (event: StreamEvent): void => {
      if (resolveNext) {
        resolveNext(event);
        resolveNext = null;
      } else {
        eventQueue.push(event);
      }
    };

    const unsubscribe = agent.subscribe(async (event) => {
      switch (event.type) {
        case 'agent_start':
          logger.info({ sessionKey }, '[AGENT_START] Agent stream started');
          break;
        case 'agent_end':
          logger.info({ sessionKey, messageCount: event.messages.length }, '[AGENT_END] Agent stream completed');
          pushEvent({
            type: error ? STREAM_EVENT_RUN_FAILED : STREAM_EVENT_RUN_COMPLETED,
            content: finalContent,
            error,
            result: {
              content: finalContent,
              toolsUsed,
              usage: {},
              stopReason,
              metadata: {},
              error,
            },
          });
          break;
        case 'turn_start':
          logger.debug({ sessionKey }, '[TURN_START] Turn started');
          break;
        case 'turn_end':
          const turnMsg = event.message as AssistantMessage;
          logger.debug({ sessionKey, stopReason: turnMsg.stopReason, toolResultCount: event.toolResults.length }, '[TURN_END] Turn completed');
          break;
        case 'message_start':
          logger.debug({ sessionKey, role: event.message.role }, '[MESSAGE_START] Message started');
          if (event.message.role === 'assistant') {
            finalContent = '';
          }
          break;

        case 'message_update':
          logger.debug({ sessionKey }, '[MESSAGE_UPDATE] Message updated');
          if (event.message.role === 'assistant') {
            const msg = event.message as AssistantMessage;
            const textContent = extractTextContent(msg.content);
            const delta = textContent.slice(finalContent.length);
            if (delta) {
              finalContent = textContent;
              pushEvent({ type: STREAM_EVENT_TEXT_DELTA, content: delta });
            }
          }
          break;

        case 'message_end':
          logger.debug({ sessionKey, role: event.message.role }, '[MESSAGE_END] Message completed');
          
          // 存储消息条目
          await sessionStorage.appendEntry({
            type: 'message',
            id: await sessionStorage.createEntryId(),
            parentId: await sessionStorage.getLeafId(),
            timestamp: new Date().toISOString(),
            message: event.message,
          });
          
          if (event.message.role === 'assistant') {
            const msg = event.message as AssistantMessage;
            finalContent = extractTextContent(msg.content);
            stopReason = msg.stopReason || 'completed';
            error = msg.errorMessage;
            pushEvent({ type: STREAM_EVENT_TEXT_COMPLETED, content: finalContent });
            
            // 存储 token 用量
            if (msg.usage) {
              await sessionStorage.appendEntry({
                type: 'token_usage',
                id: await sessionStorage.createEntryId(),
                parentId: await sessionStorage.getLeafId(),
                timestamp: new Date().toISOString(),
                usage: msg.usage,
              });
            }
          }
          break;

        case 'tool_execution_start':
          logger.info({ sessionKey, toolName: event.toolName, toolCallId: event.toolCallId }, '[TOOL_START] Tool execution started');
          
          // 存储工具调用条目
          await sessionStorage.appendEntry({
            type: 'tool_call',
            id: await sessionStorage.createEntryId(),
            parentId: await sessionStorage.getLeafId(),
            timestamp: new Date().toISOString(),
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.args || {},
          });
          
          if (!toolsUsed.includes(event.toolName)) {
            toolsUsed.push(event.toolName);
          }
          pushEvent({
            type: STREAM_EVENT_TOOL_STARTED,
            tool_name: event.toolName,
            tool_call_id: event.toolCallId,
          });

          if (FILE_EDIT_TOOLS.has(event.toolName)) {
            const args = event.args as Record<string, unknown>;
            const filePath = args.file_path || args.path || args.file;
            pushEvent({
              type: STREAM_EVENT_FILE_EDIT,
              file_edit: {
                edit_type: 'start',
                call_id: event.toolCallId,
                tool_name: event.toolName,
                file_path: typeof filePath === 'string' ? filePath : undefined,
                action: event.toolName,
              },
            });
          }
          break;

        case 'tool_execution_update':
          logger.debug({ sessionKey, toolName: event.toolName, toolCallId: event.toolCallId }, '[TOOL_UPDATE] Tool execution in progress');
          break;

        case 'tool_execution_end':
          logger.info({ sessionKey, toolName: event.toolName, toolCallId: event.toolCallId, success: !event.isError }, '[TOOL_END] Tool execution completed');
          
          // 存储工具结果条目
          const resultContent = event.result?.content?.filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('') || '';
          await sessionStorage.appendEntry({
            type: 'tool_result',
            id: await sessionStorage.createEntryId(),
            parentId: await sessionStorage.getLeafId(),
            timestamp: new Date().toISOString(),
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: (event as any).args || {},
            content: resultContent,
            isError: event.isError,
            usage: event.result?.usage,
          });
          
          pushEvent({
            type: event.isError ? STREAM_EVENT_TOOL_FAILED : STREAM_EVENT_TOOL_COMPLETED,
            tool_name: event.toolName,
            tool_call_id: event.toolCallId,
            content: event.result?.content?.filter((c: { type: string }): c is TextContent => c.type === 'text').map((c: TextContent) => c.text).join(''),
          });

          if (FILE_EDIT_TOOLS.has(event.toolName)) {
            const storedArgs = (event as any).args;
            const args = storedArgs as Record<string, unknown>;
            const filePath = args?.file_path || args?.path;
            pushEvent({
              type: STREAM_EVENT_FILE_EDIT,
              file_edit: {
                edit_type: event.isError ? 'error' : 'end',
                call_id: event.toolCallId,
                tool_name: event.toolName,
                file_path: typeof filePath === 'string' ? filePath : undefined,
                action: event.toolName,
                error: event.isError ? event.result?.content?.filter((c: { type: string }): c is TextContent => c.type === 'text').map((c: TextContent) => c.text).join('') : undefined,
              },
            });
          }
          break;
      }
    });

    try {
      const runPromise = agent.prompt(message);

      while (true) {
        if (eventQueue.length > 0) {
          const event = eventQueue.shift()!;
          yield event;
          if (event.type === STREAM_EVENT_RUN_COMPLETED || event.type === STREAM_EVENT_RUN_FAILED) {
            break;
          }
        } else {
          const event = await new Promise<StreamEvent>((resolve) => {
            resolveNext = resolve;
          });
          yield event;
          if (event.type === STREAM_EVENT_RUN_COMPLETED || event.type === STREAM_EVENT_RUN_FAILED) {
            break;
          }
        }
      }

      await runPromise;

      if (!options.ephemeral) {
        await this.sessionManager.saveSession(sessionKey, agent.state.messages, {});
      }
    } catch (err) {
      error = (err as Error).message;
      stopReason = 'error';
      
      pushEvent({
        type: STREAM_EVENT_RUN_FAILED,
        content: finalContent,
        error,
        result: {
          content: finalContent,
          toolsUsed,
          usage: {},
          stopReason,
          metadata: {},
          error,
        },
      });
      
      if (!options.ephemeral) {
        await this.sessionManager.saveSession(sessionKey, agent.state.messages, {});
      }
    } finally {
      unsubscribe();
    }
  }

  async getSessionInfo(sessionKey: string): Promise<SessionInfo | null> {
    const storedInfo = await this.sessionManager.getSessionInfo(sessionKey);
    if (storedInfo) {
      return storedInfo;
    }
    
    const agent = this.agents.get(sessionKey);
    if (!agent) return null;

    const messages = agent.state.messages;
    return {
      key: sessionKey,
      messageCount: messages.length,
      createdAt: '',
      updatedAt: '',
    };
  }

  async getSessionDetail(sessionKey: string): Promise<SessionDetail | null> {
    const session = await this.sessionManager.loadSession(sessionKey);
    if (!session) return null;

    const entries = session.entries.map((entry: SessionTreeEntry) => {
      const base = {
        id: entry.id,
        parentId: entry.parentId,
        type: entry.type,
        timestamp: entry.timestamp,
      };

      switch (entry.type) {
        case 'model_change':
          return { ...base, provider: entry.provider, modelId: entry.modelId };
        case 'message': {
          const msg = entry.message as unknown as { role: string; content?: string | Array<{ type: string; text?: string }> };
          let content: string | undefined;
          if (typeof msg.content === 'string') {
            content = msg.content;
          } else if (Array.isArray(msg.content)) {
            content = msg.content.map((c: { text?: string }) => c.text).filter(Boolean).join('\n') || undefined;
          }
          return {
            ...base,
            message: {
              role: msg.role,
              content,
            },
          };
        }
        case 'tool_call':
          return { ...base, toolName: entry.toolName, toolCallId: entry.toolCallId, input: entry.input };
        case 'tool_result':
          return { ...base, toolName: entry.toolName, toolCallId: entry.toolCallId, input: entry.input, content: entry.content, isError: entry.isError, usage: entry.usage };
        case 'token_usage':
          return { ...base, usage: entry.usage };
        default:
          return base;
      }
    });

    return {
      key: session.key,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      entries,
    };
  }

  async listSessions(): Promise<string[]> {
    const storedSessions = await this.sessionManager.listSessions();
    const agentSessions = Array.from(this.agents.keys());
    return [...new Set([...storedSessions, ...agentSessions])];
  }

  async deleteSession(sessionKey: string): Promise<boolean> {
    this.agents.delete(sessionKey);
    return this.sessionManager.deleteSession(sessionKey);
  }

  get tools(): string[] {
    return this.toolRegistry.list();
  }

  get config_(): Config {
    return this.config;
  }

  async close(): Promise<void> {
    this.agents.clear();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export { Agent, AgentHarness };
export { builtinModels };
