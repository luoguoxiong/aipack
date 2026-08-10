/**
 * packages/cli - 编程式 API 入口
 *
 * 提供配置、环境、Runtime 工厂、聊天、一次性提问、回放、会话管理、重置等能力。
 */

export {
  loadConfig,
  getConfigDir,
  getConfigPath,
  generateSessionKey,
  resolveHome,
} from './src/config';
export type {
  AipackConfig,
  AipackConfigFile,
  AipackRuntimeConfig,
  CliOptions,
  SessionsConfig,
} from './src/config';
export type { RuntimeOptions } from '@aipack/agent';

export { loadEnvFile, saveEnvFile } from './src/env';

export {
  hasAnyApiKey,
  runSetupWizard,
} from './src/setup-wizard';
export type { SetupResult } from './src/setup-wizard';

export {
  createAipackRuntime,
  resolveAiModel,
  resolveModelForCli,
} from './src/runtime';
export type { Model, Runtime } from './src/runtime';

export { startChat } from './src/chat';

export { runOnce } from './src/run';
export type { RunResult } from './src/run';

export { replaySession } from './src/replay';
export type { ReplayResult, ReplayTurnResult } from './src/replay';

export { listSessions, clearSessions, deleteSession } from './src/sessions';

export { listModels, listConfiguredProviders } from './src/models';
export type { ModelEntry } from './src/models';

export {
  confirmAction,
  resetAll,
  resetConfig,
  resetLogs,
  resetSessions,
  resetMemory,
} from './src/reset';
export type { ResolvedPaths } from './src/reset';
