export { Nanobot } from './nanobot.js';
export type {
  RunResult,
  RunOptions,
  NanobotOptions,
  StreamEvent,
  StreamEventType,
  SessionInfo,
  SessionSnapshot,
} from './nanobot.js';
export {
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
  STREAM_EVENT_TYPES,
} from './nanobot.js';

export { AgentLoop, AgentRunner, ContextBuilder } from './agent/index.js';
export { ToolRegistry, createDefaultToolRegistry } from './agent/tools/index.js';
export { MessageBus, createMessageBus } from './bus/index.js';
export { ChannelManager, registerChannel, CliChannel, WebSocketChannel } from './channels/index.js';
export { SessionManager, SessionStore } from './session/index.js';
export {
  LLMProvider,
  OpenAICompatProvider,
  ProviderFactoryService,
  registerProvider,
} from './providers/index.js';
export { loadConfig, saveConfig, defaultConfig } from './config/index.js';
export type { Config, AgentDefaults, ProviderConfig } from './config/index.js';

export const __version__ = '0.2.2';
export const __logo__ = '🐈';
