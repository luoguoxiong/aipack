import path from 'path';
import { AgentLoop, AgentHook } from './agent/index.js';
import type { ProcessDirectResult } from './agent/index.js';
import { loadConfig, getConfigPath } from './config/loader.js';
import { Config, defaultConfig } from './config/schema.js';

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
  hooks?: AgentHook[];
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

export class Nanobot {
  private loop: AgentLoop;
  private config: Config;

  constructor(loop: AgentLoop, config?: Config) {
    this.loop = loop;
    this.config = config || defaultConfig();
  }

  static async fromConfig(options: NanobotOptions = {}): Promise<Nanobot> {
    let config: Config;
    if (options.config) {
      config = options.config;
    } else {
      const configPath = options.configPath 
        ? path.resolve(options.configPath.replace('~', process.env.HOME || ''))
        : getConfigPath();
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

    const loop = AgentLoop.fromConfig(config);
    return new Nanobot(loop, config);
  }

  async run(message: string, options: RunOptions = {}): Promise<RunResult> {
    const result = await this.loop.processDirect(message, {
      sessionKey: options.sessionKey || 'sdk:default',
      channel: options.channel || 'cli',
      chatId: options.chatId || 'direct',
      senderId: options.senderId || 'user',
      media: options.media,
      ephemeral: options.ephemeral,
      model: options.model,
      modelPreset: options.modelPreset,
    });

    return {
      content: result.content || '',
      toolsUsed: result.toolsUsed,
      usage: result.usage,
      stopReason: result.stopReason,
      metadata: {},
      error: result.error,
    };
  }

  async *stream(
    message: string,
    options: RunOptions = {},
  ): AsyncGenerator<StreamEvent> {
    const eventQueue: StreamEvent[] = [];
    let resolveNext: ((value: StreamEvent) => void) | null = null;
    let done = false;

    const sessionKey = options.sessionKey || 'sdk:default';
    const channel = options.channel || 'cli';
    const chatId = options.chatId || 'direct';
    const senderId = options.senderId || 'user';

    const pushEvent = (event: StreamEvent): void => {
      if (resolveNext) {
        resolveNext(event);
        resolveNext = null;
      } else {
        eventQueue.push(event);
      }
    };

    const onStream = async (delta: string): Promise<void> => {
      pushEvent({ type: STREAM_EVENT_TEXT_DELTA, content: delta });
    };

    const onReasoning = async (delta: string): Promise<void> => {
      pushEvent({ type: STREAM_EVENT_REASONING_DELTA, content: delta });
    };

    const onFileEdit = async (event: import('./agent/runner.js').FileEditEvent): Promise<void> => {
      pushEvent({
        type: STREAM_EVENT_FILE_EDIT,
        file_edit: {
          edit_type: event.type === 'file_edit_start' ? 'start' : event.type === 'file_edit_end' ? 'end' : 'error',
          call_id: event.call_id,
          tool_name: event.tool_name,
          file_path: event.file_path,
          action: event.action,
          error: event.error,
        },
      });
    };

    yield {
      type: STREAM_EVENT_RUN_STARTED,
      metadata: {
        session_key: sessionKey,
        channel,
        chat_id: chatId,
        sender_id: senderId,
      },
    };

    // Run processDirect in the background; yield events as they arrive
    const runPromise = this.loop.processDirect(message, {
      sessionKey,
      channel,
      chatId,
      senderId,
      media: options.media,
      ephemeral: options.ephemeral,
      onStream,
      onReasoning,
      onFileEdit,
      model: options.model,
      modelPreset: options.modelPreset,
    }).then((result) => {
      pushEvent({
        type: STREAM_EVENT_RUN_COMPLETED,
        content: result.content || '',
        result: {
          content: result.content || '',
          toolsUsed: result.toolsUsed,
          usage: result.usage,
          stopReason: result.stopReason,
          metadata: {},
          error: result.error,
        },
        usage: result.usage,
        metadata: {},
      });
    }).catch((err) => {
      pushEvent({
        type: STREAM_EVENT_RUN_FAILED,
        error: (err as Error).message,
        metadata: { exception_type: (err as Error).name },
      });
    });

    // Yield events from the queue until processDirect completes
    while (!done) {
      if (eventQueue.length > 0) {
        const event = eventQueue.shift()!;
        if (event.type === STREAM_EVENT_RUN_COMPLETED || event.type === STREAM_EVENT_RUN_FAILED) {
          done = true;
          yield event;
          if (event.type === STREAM_EVENT_RUN_FAILED) {
            throw new Error(event.error || 'Run failed');
          }
          break;
        }
        yield event;
      } else {
        // Wait for the next event
        const event = await new Promise<StreamEvent>((resolve) => {
          resolveNext = resolve;
        });
        if (event.type === STREAM_EVENT_RUN_COMPLETED || event.type === STREAM_EVENT_RUN_FAILED) {
          done = true;
          yield event;
          if (event.type === STREAM_EVENT_RUN_FAILED) {
            throw new Error(event.error || 'Run failed');
          }
          break;
        }
        yield event;
      }
    }

    // Ensure the background promise has settled
    await runPromise.catch(() => {});
  }

  async getSessionInfo(sessionKey: string): Promise<SessionInfo | null> {
    const session = await this.loop.getSessionManager().getSession(sessionKey);
    if (!session) return null;
    return {
      key: session.key,
      messageCount: session.messages.length,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
    };
  }

  async listSessions(): Promise<string[]> {
    return this.loop.getSessionManager().listSessions();
  }

  async deleteSession(sessionKey: string): Promise<boolean> {
    return this.loop.getSessionManager().deleteSession(sessionKey);
  }

  get tools(): string[] {
    return this.loop.getToolRegistry().list();
  }

  get config_(): Config {
    return this.config;
  }

  getSessionManager() {
    return this.loop.getSessionManager();
  }

  async close(): Promise<void> {
    this.loop.stop();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export { AgentLoop, ProcessDirectResult };
