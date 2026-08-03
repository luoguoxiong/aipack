/**
 * Runtime - 运行时核心接口
 *
 * 灵感来自 webpack 的 Compiler。
 * Runtime 是整个 Agent 系统的核心调度器，负责：
 * 1. 接收 Request（Entry）
 * 2. 构建 TaskGraph（Dependency Graph）
 * 3. 通过 Pipeline（Loader Runner）执行 Transformer（Loader）
 * 4. 触发 Extension（Plugin）钩子
 * 5. 产出 Result（Bundle）
 *
 * Webpack 映射: Compiler
 */

import type { Model, Tool, StreamFn, Message } from './types';
import type { Request } from './request';
import type { Result, ResultChunk } from './result';
import type { ContextResource } from './context-resource';
import type { TaskGraph } from './task-graph';
import type { Pipeline } from './pipeline';
import type { ExtensionManager, RuntimeHooks } from './extension';
import type { SessionStorage } from './session';

// ─── Compilation - 单次编译上下文 ──────────────────────────────────

export interface Compilation {
  /** 当前请求 */
  readonly request: Request;
  /** 任务图 */
  readonly graph: TaskGraph;
  /** 流水线 */
  readonly pipeline: Pipeline;
  /** 当前编译产生的资源 */
  resources: ContextResource[];
  /** 消息列表 */
  messages: Message[];
  /** 编译是否完成 */
  completed: boolean;
  /** 编译错误 */
  readonly error?: Error;
}

// ─── Runtime 接口 ─────────────────────────────────────────────────

export interface Runtime {
  /** 运行时配置 */
  readonly config: Record<string, unknown>;
  /** 扩展管理器 */
  readonly extensions: ExtensionManager;
  /** 钩子集合 */
  readonly hooks: RuntimeHooks;

  /** 执行请求（同步返回结果） */
  run(request: Request): Promise<Result>;

  /** 执行请求（流式返回） */
  stream(request: Request): AsyncGenerator<ResultChunk>;

  /** 创建编译上下文 */
  createCompilation(request: Request): Compilation;

  /** 注册工具 */
  registerTool(tool: Tool): this;

  /** 批量注册工具 */
  registerTools(tools: Tool[]): this;

  /** 设置模型 */
  setModel(model: Model): this;

  /** 设置系统提示词 */
  setSystemPrompt(prompt: string): this;

  /** 设置流式函数（模型提供者） */
  setStreamFn(fn: StreamFn): this;

  /** 注册扩展 */
  registerExtension(extension: import('./extension').Extension): this;

  /** 注册转换器 */
  useTransformer(transformer: import('./transformer').ContextTransformer): this;

  /** 获取消息列表 */
  getMessages(sessionKey?: string): Message[];

  /** 终止指定会话的运行 */
  abort(sessionKey?: string): void;

  /** 检查会话是否正在运行 */
  isBusy(sessionKey?: string): boolean;

  /** 等待会话空闲 */
  waitForIdle(sessionKey?: string): Promise<void>;

  /** 清除会话消息（仅内存，不影响已持久化数据） */
  clearSession(sessionKey?: string): void;

  /** 列出所有会话 key（内存 + 存储） */
  listSessions(): Promise<string[]>;

  /** 删除指定会话（内存 + 存储），返回是否删除成功 */
  deleteSession(sessionKey?: string): Promise<boolean>;

  /** 关闭运行时，释放资源 */
  close(): Promise<void>;
}

// ─── Runtime 选项 ─────────────────────────────────────────────────

export interface RuntimeOptions {
  /** 配置对象 */
  config?: Record<string, unknown>;
  /** 工作区路径 */
  workspace?: string;
  /** 系统提示词 */
  systemPrompt?: string;
  /** 模型 */
  model?: Model;
  /** 流式函数（模型提供者） */
  streamFn?: StreamFn;
  /** 初始工具列表 */
  tools?: Tool[];
  /** 预注册的扩展 */
  extensions?: import('./extension').Extension[];
  /** 预注册的转换器 */
  transformers?: import('./transformer').ContextTransformer[];
  /** 自定义 Pipeline */
  pipeline?: Pipeline;
  /** 会话存储适配器（可选，启用后会话自动持久化到存储） */
  sessionStorage?: SessionStorage;
}
