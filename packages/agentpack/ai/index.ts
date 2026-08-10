// ─── 重新导出 TypeBox ───────────────────────────────────────────
export { Type, type Static, type TSchema } from '@sinclair/typebox';

// ─── 类型 ────────────────────────────────────────────────────────
export type {
  Api,
  ContentBlock,
  TextContent,
  ImageContent,
  ToolCallContent,
  ThinkingContent,
  Usage,
  ModelCost,
  Model,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  Message,
  Tool,
  Context,
  StreamEvent,
  StreamStartEvent,
  TextStartEvent,
  TextDeltaEvent,
  TextEndEvent,
  ThinkingStartEvent,
  ThinkingDeltaEvent,
  ThinkingEndEvent,
  ToolCallStartEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  DoneEvent,
  ErrorEvent,
  StreamResult,
  SimpleStreamOptions,
  StreamOptions,
  ReasoningLevel,
  Provider,
  ResolvedAuth,
  ModelsOptions,
  CredentialStore,
  ImagesModel,
  ImagesProvider,
  ImageInputBlock,
  ImageOutputBlock,
  AssistantImages,
  ImagesGenerateOptions,
} from './types';

// ─── 函数 ───────────────────────────────────────────────────
export { hasApi, createEmptyUsage, createEmptyAssistantMessage } from './types';

// ─── Models 类 ──────────────────────────────────────────────────────
export { Models, createModels } from './models';

// ─── 图片生成 ────────────────────────────────────────────
export { ImagesModels, createImagesModels } from './images';

// ─── 内置提供者 ──────────────────────────────────────────
export {
  builtinModels,
  builtinProviders,
  builtinImagesModels,
  getBuiltinModel,
  getBuiltinModels,
  getBuiltinProviders,
} from './providers-all';

// ─── 目录 ─────────────────────────────────────────────────────
export { BUILTIN_MODELS, BUILTIN_IMAGES_MODELS, BUILTIN_PROVIDERS, getEnvApiKey, hasProviderConfigured } from './catalog';

// ─── 流式实现（供适配器直接复用） ──────────────────────────────
export { streamOpenAI } from './stream-openai';
export { streamAnthropic } from './stream-anthropic';

// ─── 统一凭证解析 ─────────────────────────────────────────────
export {
  envKeyName,
  resolveApiKey,
  resolveApiKeyFromEnv,
  EnvCredentialStore,
  createEnvCredentialStore,
} from './credentials';

// ─── 统一错误分类 ─────────────────────────────────────────────
export {
  AgentError,
  AgentErrorCategory,
  isAgentError,
  isRetryableCategory,
  classifyHttpStatus,
  classifyErrorMessage,
  classifyError,
  isContextOverflowError,
  categoryLabel,
  formatCategoryError,
  formatHttpError,
} from './errors';
export type { AgentErrorOptions } from './errors';
