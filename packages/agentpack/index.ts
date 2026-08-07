/**
 * packages - Agent 框架入口
 *
 * 独立框架，不依赖 src/。
 * 所有功能通过 Transformer、Extension 等机制扩展。
 */

// ─── 核心契约层 ───────────────────────────────────────────────────
export * from './core';

// ─── Runtime: 编排层 ──────────────────────────────────────────────
export { AgentRuntime, createRuntime } from './runtime';

// ─── Request: 请求入口 ────────────────────────────────────────────
export {
  validateRequest,
  normalizeRequest,
} from './request';

// ─── ContextResource: 上下文资源 ──────────────────────────────────
export {
  messageToResource,
  messagesToResources,
  resourceToMessage,
  resourcesToMessages,
  extractToolCallsFromResource,
  extractTextFromResource,
} from './context-resource';

// ─── TaskGraph: 任务依赖图 ────────────────────────────────────────
export {
  buildTaskGraph,
  graphToMessages,
  analyzeToolChains,
  findOrphanedToolCalls,
  getGraphStats,
} from './task-graph';

// ─── ContextTransformer: 上下文转换器 ─────────────────────────────
export {
  ToolPairingTransformer,
  StateSnapshotTransformer,
  TruncationTransformer,
  TokenBudgetTransformer,
  SystemMessageCleanerTransformer,
  ensureToolPairing,
  createDefaultTransformers,
} from './transformer';

// ─── Pipeline: 转换流水线 ────────────────────────────────────────
export {
  createDefaultPipeline,
  PipelineRunner,
  createPipelineRunner,
} from './pipeline';

// ─── Extension: 扩展插件 ─────────────────────────────────────────
export {
  LoggingExtension,
  EventCaptureExtension,
  RequestInterceptorExtension,
  ResultPostProcessorExtension,
  SharedStateExtension,
  createDefaultExtensions,
  createExtensionManager,
  createToolHookExtension,
} from './extension';

// ─── Result: 运行结果 ────────────────────────────────────────────
export {
  buildResultFromMessages,
  buildResultFromAssistantMessage,
  buildResultWithResources,
  ResultAggregator,
  ResultBuilder,
  createResult,
  createErrorResult,
} from './result';

// ─── Session: 会话存储实现 ────────────────────────────────────────
export {
  MemorySessionStorage,
  createMemorySessionStorage,
  FileSessionStorage,
  createFileSessionStorage,
} from './session';

// ─── AI 模型层(从 ./ai 选择性重导出,便于单包消费)─────────────────
// 完整 AI surface 见 'agentpack/ai' 子路径;此处仅重导出消费者常用、且不与
// core 同名冲突的符号,外加 Model as AiModel 别名。
export {
  getBuiltinModel,
  getBuiltinModels,
  getBuiltinProviders,
  getEnvApiKey,
  hasProviderConfigured,
  BUILTIN_PROVIDERS,
} from './ai';
export type { Model as AiModel } from './ai';

// ─── AI 适配器(模型层 ↔ 框架核心 胶水)────────────────────────────
export { adaptAiModel, createStreamFnFromAi } from './adapters/ai';
