/**
 * Runtime - 运行时核心接口
 *
 * Runtime 是整个 Agent 系统的核心调度器，负责：
 * 1. 接收 Request（请求入口）
 * 2. 构建 TaskGraph（任务依赖图）
 * 3. 按数组顺序链式执行 ContextTransformer（上下文转换）
 * 4. 触发 Extension（扩展插件）钩子
 * 5. 产出 Result（运行结果）
 */

import type { Model, Tool, StreamFn, Message, ThinkingLevel } from './types';
import type { Request } from './request';
import type { Result, ResultChunk } from './result';
import type { ContextResource } from './context-resource';
import type { TaskGraph } from './task-graph';
import type { ExtensionManager, RuntimeHooks } from './extension';
import type { SessionStorage } from './session';
import type { Telemetry } from '../telemetry';

// ─── Compilation - 单次编译上下文 ──────────────────────────────────

export interface Compilation {
  /** 当前请求 */
  readonly request: Request;
  /** 任务图 */
  readonly graph: TaskGraph;
  /** 本次运行的全局唯一 id（run()/stream() 入口生成，贯穿 runEnd/tool/model/retry 遥测事件） */
  readonly traceId: string;
  /** 当前编译产生的资源 */
  resources: ContextResource[];
  /** 消息列表 */
  messages: Message[];
  /** 编译是否完成 */
  completed: boolean;
  /** 编译错误 */
  readonly error?: Error;
  /** 对话轮数（runLoop 累计写入，供 onRunEnd 上报 step 长度） */
  turnCount?: number;
  /** 首个模型调用的首 token 延迟 ms（流式路径写入，供 onRunEnd 上报 ttftMs） */
  ttftMs?: number;
  /**
   * 终止原因。由 beforeToolCall/afterToolCall 的 terminate 决策设置，
   * runLoop 检测到后停止循环，buildResult 据此将 stopReason 标为 'terminated'。
   */
  terminateReason?: string;
  /**
   * 回合上限耗尽标记。runLoop/runLoopStream 因 maxTurns 用尽而退出循环
   * （非 break / 非模型自然停止）时设置，此时模型通常仍请求工具调用。
   * buildResult 据此将 stopReason 标为 'max_turns'，供调用方区分截断与正常完成。
   */
  maxTurnsExhausted?: boolean;
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

  /** 设置思考/推理级别（仅对 reasoning 模型生效） */
  setThinkingLevel(level: ThinkingLevel): this;

  /** 设置流式函数（模型提供者） */
  setStreamFn(fn: StreamFn): this;

  /** 注册扩展 */
  registerExtension(extension: import('./extension').Extension): this;

  /** 注册转换器 */
  useTransformer(transformer: import('./transformer').ContextTransformer): this;

  /** 获取指定会话的消息列表（默认会话；会话不存在返回空数组） */
  getMessages(sessionKey?: string): Message[];

  /** 终止指定会话的运行（默认会话） */
  abort(sessionKey?: string): void;

  /** 检查指定会话是否正在运行（默认会话） */
  isBusy(sessionKey?: string): boolean;

  /** 等待指定会话空闲（默认会话）。timeoutMs 可选，超时 reject 防无限等待 */
  waitForIdle(sessionKey?: string, timeoutMs?: number): Promise<void>;

  /** 清除指定会话消息（仅内存,不影响已持久化数据） */
  clearSession(sessionKey?: string): void;

  /** 删除指定会话(内存 + 存储),返回是否删除成功 */
  deleteSession(sessionKey?: string): Promise<boolean>;

  /** 当前活跃的会话 key 列表（含默认会话） */
  getSessionKeys(): string[];

  /** 某会话是否存在于内存 */
  hasSession(sessionKey: string): boolean;

  /** 关闭运行时，释放资源 */
  close(): Promise<void>;
}

// ─── 内置摘要压缩选项 ─────────────────────────────────────────────

/**
 * 内置上下文摘要压缩配置（RuntimeOptions.compaction）。
 *
 * 三级降级链：用户自定义压缩 transformer → 内置摘要压缩 → 硬截断。
 * 未配置 compaction 时保持旧行为（仅硬截断，向后兼容）。
 * 摘要在 runtime 层实现（可直接复用模型通道），产出 compactionSummary
 * 消息（资源层映射为 pinned 的 compaction_summary，不会被后续截断误删）。
 */
export interface CompactionOptions {
  /** 是否启用（默认 true；显式 false 关闭摘要压缩，恢复仅硬截断行为） */
  enabled?: boolean;
  /**
   * 阈值触发：估算 token 占 contextWindow 比例超过该值时，在下一回合
   * 模型调用前压缩（默认取 contextBudgetRatio，即 0.8）。
   */
  triggerRatio?: number;
  /** 压缩后目标：token 占 contextWindow 比例（默认 0.5，最新消息保留量为其一半） */
  targetRatio?: number;
  /** 溢出恢复时是否也尝试摘要（默认 true；false 则溢出仅硬截断快速重试） */
  onOverflow?: boolean;
  /** 摘要指令（默认内置中文指令；可自定义摘要侧重） */
  prompt?: string;
}

// ─── Runtime 选项 ─────────────────────────────────────────────────

export interface RuntimeOptions {
  /** 配置对象 */
  config?: Record<string, unknown>;
  /** 工作区路径 */
  workspace?: string;
  /** 内存会话状态表 LRU 上限（默认 256）。仅清理内存态，不删除存储；
   *  超限时淘汰最久未用的非活动会话。 */
  maxSessions?: number;
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
  /** 会话存储适配器（可选，启用后会话自动持久化到存储） */
  sessionStorage?: SessionStorage;
  /** 遥测（可选，观测 run/工具/模型调用，不干预流程） */
  telemetry?: Telemetry;
  /** 单次请求最大对话回合数（默认 50，防止失控循环） */
  maxTurns?: number;
  /** 单个工具执行超时（毫秒，默认 120000）。超时后该工具调用以错误结果返回 */
  toolTimeoutMs?: number;
  /** 是否并行执行同一轮的多个工具调用（默认 true） */
  parallelToolCalls?: boolean;
  /** 思考/推理级别（默认 'off'，仅对 reasoning 模型生效） */
  thinkingLevel?: ThinkingLevel;
  /** 上下文资源条数上限（TruncationTransformer，默认 200） */
  maxResources?: number;
  /** token 预算占 contextWindow 的比例（默认 0.8），超出则按 token 截断 */
  contextBudgetRatio?: number;
  /** 内置摘要压缩配置（可选）。未配置时保持旧行为（仅硬截断，向后兼容） */
  compaction?: CompactionOptions;
  /** 框架级工具权限策略（可选）。未配置时工具全部放行（向后兼容）；
   *  生产环境建议配置 createPermissionPolicy / createAllowListPolicy / createDenyAllPolicy。 */
  permissionPolicy?: import('./permission').PermissionPolicy;
  /** traceId 生成器（可选，默认 Date+UUID；测试可注入确定性 id） */
  traceIdGenerator?: () => string;
}
