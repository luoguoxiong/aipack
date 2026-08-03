/**
 * packages - Webpack 架构风格的 Agent 框架入口
 *
 * 独立框架，不依赖 src/。
 * 所有功能通过 Loader、Plugin 等机制扩展。
 *
 *   Webpack          -> Agent
 *   ─────────────────────────────────
 *   Compiler         -> Runtime             (packages/runtime)
 *   Entry            -> Request             (packages/request)
 *   Module           -> ContextResource     (packages/context-resource)
 *   Dependency Graph -> TaskGraph           (packages/task-graph)
 *   Loader           -> ContextTransformer  (packages/transformer)
 *   Plugin           -> Extension           (packages/extension)
 *   Loader Runner    -> Pipeline            (packages/pipeline)
 *   Bundle           -> Result              (packages/result)
 *   tapable          -> Tapable             (packages/core/tapable)
 */

// ─── 核心契约层 ───────────────────────────────────────────────────
export * from './core';

// ─── Runtime: 编排层（Compiler） ──────────────────────────────────
export { AgentRuntime, createRuntime } from './runtime';

// ─── Request: 请求入口（Entry） ───────────────────────────────────
export {
  validateRequest,
  normalizeRequest,
} from './request';

// ─── ContextResource: 上下文资源（Module） ────────────────────────
export {
  messageToResource,
  messagesToResources,
  resourceToMessage,
  resourcesToMessages,
  extractToolCallsFromResource,
  extractTextFromResource,
} from './context-resource';

// ─── TaskGraph: 任务依赖图（Dependency Graph） ────────────────────
export {
  buildTaskGraph,
  graphToMessages,
  analyzeToolChains,
  findOrphanedToolCalls,
  getGraphStats,
} from './task-graph';

// ─── ContextTransformer: 上下文转换器（Loader） ───────────────────
export {
  ToolPairingTransformer,
  StateSnapshotTransformer,
  TruncationTransformer,
  SystemMessageCleanerTransformer,
  ensureToolPairing,
  createDefaultTransformers,
} from './transformer';

// ─── Pipeline: 转换流水线（Loader Runner） ────────────────────────
export {
  createDefaultPipeline,
  PipelineRunner,
  createPipelineRunner,
} from './pipeline';

// ─── Extension: 扩展插件（Plugin） ────────────────────────────────
export {
  LoggingExtension,
  EventCaptureExtension,
  RequestInterceptorExtension,
  ResultPostProcessorExtension,
  SharedStateExtension,
  createDefaultExtensions,
  createExtensionManager,
} from './extension';

// ─── Result: 运行结果（Bundle） ───────────────────────────────────
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
