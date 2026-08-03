/**
 * packages/core - 核心类型与接口
 *
 * 定义整个 Agent 架构的"契约层"，
 * 所有实现包（runtime, transformer, extension 等）都依赖此包。
 *
 * Webpack 映射关系:
 *   Compiler         -> Runtime
 *   Entry            -> Request
 *   Module           -> ContextResource
 *   Dependency Graph -> TaskGraph
 *   Loader           -> ContextTransformer
 *   Plugin           -> Extension
 *   Loader Runner    -> Pipeline
 *   Bundle           -> Result
 *   tapable          -> Tapable
 */

// ─── 核心类型: 消息/内容/模型/工具 ─────────────────────────────────
export type {
  TextContent,
  ImageContent,
  ToolCallContent,
  ThinkingContent,
  ContentBlock,
  BaseMessage,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  SystemMessage,
  Message,
  Usage,
  Model,
  ToolResult,
  Tool,
  Context,
  StreamOptions,
  StreamEvent,
  StreamResult,
  StreamFn,
  AgentState,
  ThinkingLevel,
} from './types';
export {
  extractText,
  extractToolCalls,
  createTextContent,
  createEmptyUsage,
} from './types';

// ─── Tapable: 事件钩子系统 ─────────────────────────────────────────
export {
  SyncHook,
  AsyncSeriesHook,
  AsyncSeriesWaterfallHook,
  HookMap,
} from './tapable';
export type { Tap, TapType } from './tapable';

// ─── Runtime: 运行时接口 ──────────────────────────────────────────
export type { Runtime, Compilation, RuntimeOptions } from './runtime';

// ─── Request: 请求入口 ────────────────────────────────────────────
export { RequestBuilder, createRequest } from './request';
export type { Request, RequestType } from './request';

// ─── ContextResource: 上下文资源 ──────────────────────────────────
export {
  ContextResourceBuilder,
  createMessageResource,
  createToolCallResource,
  createToolResultResource,
} from './context-resource';
export type { ContextResource, ResourceType, ResourceRole } from './context-resource';

// ─── TaskGraph: 任务依赖图 ────────────────────────────────────────
export {
  TaskGraphImpl,
  TaskGraphBuilder,
  createTaskGraph,
} from './task-graph';
export type { TaskGraph, GraphNode } from './task-graph';

// ─── ContextTransformer: 上下文转换器 ─────────────────────────────
export { BaseTransformer } from './transformer';
export type { ContextTransformer, TransformContext, TransformRuntime, TransformerOptions } from './transformer';

// ─── Pipeline: 转换流水线 ─────────────────────────────────────────
export { PipelineImpl, createPipeline } from './pipeline';
export type { Pipeline } from './pipeline';

// ─── Extension: 扩展插件 ──────────────────────────────────────────
export { ExtensionManager, BaseExtension } from './extension';
export type { Extension, ExtensionContext, RuntimeHooks } from './extension';

// ─── Result: 运行结果 ─────────────────────────────────────────────
export { ResultBuilder, createResult, createErrorResult } from './result';
export type { Result, ResultChunk } from './result';

// ─── Session: 会话持久化契约 ──────────────────────────────────────
export { SESSION_VERSION } from './session';
export type {
  SessionModel,
  StoredSession,
  SessionStorage,
  FileSessionStorageOptions,
  MemorySessionStorageOptions,
} from './session';
