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
