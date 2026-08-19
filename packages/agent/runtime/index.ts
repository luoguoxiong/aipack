/**
 * packages/runtime - 运行时核心实现
 *
 * 独立实现的 Runtime，不依赖 src/。
 * Runtime 是整个 Agent 系统的核心调度器，
 * 负责协调对话循环、工具执行、上下文转换和插件钩子。
 */

import type {
  Runtime,
  Compilation,
  RuntimeOptions,
  CompactionOptions,
  Request,
  Result,
  ResultChunk,
  Extension,
  RuntimeHooks,
  ExtensionContext,
  ContextTransformer,
  TransformContext,
  ToolCallContext,
  BeforeToolCallDecision,
  AfterToolCallDecision,
  PermissionRequest,
  PermissionPolicy,
  ApprovalManager,
} from '../core';
import {
  ExtensionManager,
  createTaskGraph,
  ResultBuilder,
  isErrorToolResult,
} from '../core';
import type {
  Model,
  Tool,
  StreamFn,
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  ContentBlock,
  ToolCallContent,
  ImageContent,
  Usage,
  Context,
  StreamOptions,
  StreamEvent,
  ThinkingLevel,
  ToolResult,
} from '../core';
import {
  extractText,
  extractToolCalls,
  createTextContent,
  createEmptyUsage,
  SESSION_VERSION,
} from '../core';
import type {
  SessionStorage,
  StoredSession,
  SessionModel,
} from '../core';
import type { Telemetry, ErrorClass, CompactionTelemetryInfo } from '../telemetry';
import { validateRequest, normalizeRequest } from '../request';
import {
  messagesToResources,
  resourcesToMessages,
} from '../context-resource';
import { classifyError, isAgentError, isContextOverflow } from '../ai';
import { ensureToolPairing } from '../transformer';
import { randomUUID } from 'node:crypto';

// ─── traceId / spanId 生成（零新依赖）────────────────────────────

function newTraceId(): string {
  return `${Date.now().toString(36)}-${randomUUID()}`;
}

function newSpanId(): string {
  return randomUUID();
}

/** 从流错误消息的 "[category]" 前缀解析错误分类（formatCategoryError 产出） */
function errorClassFromMessage(message: string): string | undefined {
  const m = message.match(/^\[([^\]]+)\]/);
  return m ? m[1] : undefined;
}

/** 工具结果状态分类：error(执行失败) / ok(正常)。blocked/skipped 不进入 onToolCall */
function toolResultStatus(result: ToolResult): 'ok' | 'error' | 'blocked' | 'skipped' {
  if (result.details && typeof result.details === 'object' && 'error' in result.details) {
    return 'error';
  }
  const d = result.details as { blocked?: boolean; skipped?: boolean } | undefined;
  if (d?.blocked) return 'blocked';
  if (d?.skipped) return 'skipped';
  return 'ok';
}

/** 从重试错误对象提取 HTTP 状态码（AgentError 或 fetch Response） */
function statusOfRetryError(error: unknown): number | undefined {
  if (isAgentError(error)) return error.status;
  const s = (error as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
}

// ─── 会话状态 ─────────────────────────────────────────────────────

interface SessionState {
  messages: Message[];
  isStreaming: boolean;
  abortController: AbortController | null;
  createdAt: string;   // 会话首次创建时间，持久化时保留
  hydrated: boolean;   // 是否已从存储恢复（串行化后无竞态）
  /** 串行队列：同一会话的 run/stream 依次执行，避免消息数组交错与 abort 覆盖 */
  queue: Promise<void>;
  /** 等待空闲的 resolver，isStreaming 变 false 时逐个唤醒 */
  idleResolvers: Array<() => void>;
  /** 是否持有执行锁（acquire 后 → release 前）。LRU 淘汰时保护刚入队未开始运行的会话 */
  lockHeld: boolean;
}

/** 内存会话状态表 LRU 上限（仅清理内存态，不删存储；超限淘汰最久未用） */
const DEFAULT_MAX_SESSIONS = 256;

function createSessionState(): SessionState {
  return {
    messages: [],
    isStreaming: false,
    abortController: null,
    createdAt: new Date().toISOString(),
    hydrated: false,
    queue: Promise.resolve(),
    idleResolvers: [],
    lockHeld: false,
  };
}

// ─── 工具超时信号（Node 18 无 AbortSignal.any，手动桥接）─────────

function withTimeoutSignal(
  parent: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Tool execution timeout after ${ms}ms`)),
    ms,
  );
  if (parent) {
    if (parent.aborted) {
      controller.abort(parent.reason);
    } else {
      parent.addEventListener(
        'abort',
        () => controller.abort(parent.reason),
        { once: true },
      );
    }
  }
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

// ─── 媒体附件 → ImageContent ──────────────────────────────────────

function buildImageContent(media: string): ImageContent {
  const dataMatch = media.match(/^data:([^;]+);base64,(.*)$/s);
  if (dataMatch) {
    return { type: 'image', mimeType: dataMatch[1], data: dataMatch[2] };
  }
  // 非 data URI 视为 URL（ImageContent.data 字段同时接受 base64 与 URL）
  return { type: 'image', mimeType: 'image/url', data: media };
}

// ─── 上下文溢出自动恢复 ────────────────────────────────────────────

/** 单回合内溢出恢复重试上限（截断后仍溢出最多再试 2 次，防止死循环） */
const OVERFLOW_RECOVERY_LIMIT = 2;

/** 粗略 token 估算（与 transformer 层同口径：约 4 字符/token） */
function estimateMessageTokens(message: Message): number {
  const content = message.content;
  if (typeof content === 'string') return Math.ceil(content.length / 4);
  try {
    return Math.ceil(JSON.stringify(content ?? []).length / 4);
  } catch {
    return 0;
  }
}

/** 估算文本 token（与 estimateMessageTokens 同口径） */
function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── 内置摘要压缩 ─────────────────────────────────────────────────

/**
 * 摘要请求输入预算：占 contextWindow 的比例。
 * 被压缩段序列化后超过该预算时不再发起摘要请求（请求本身必然超窗），
 * 直接降级硬截断，避免 doomed 调用。
 */
const COMPACTION_SUMMARY_BUDGET_RATIO = 0.6;

/** 摘要请求单条消息的序列化字符上限（防单条巨型 toolResult 撑爆摘要请求） */
const COMPACTION_LINE_CLAMP = 4000;

/** 默认摘要指令 */
const DEFAULT_COMPACTION_PROMPT = [
  '你是对话历史压缩器。请将以下对话历史压缩为一份信息密度高的摘要，供后续对话作为上下文参考。',
  '要求：',
  '1. 保留关键事实、决策、结论与未完成事项；',
  '2. 保留用户明确的偏好与约束；',
  '3. 保留重要工具调用的目的与结果要点（细节可省略）；',
  '4. 丢弃寒暄、重复与无关细节；',
  '5. 直接输出摘要正文，不要任何前后缀说明。',
].join('\n');

/** compactionSummary 消息发给 provider 时转换后的 user 消息前缀 */
const COMPACTION_USER_PREFIX = '[以下为此前对话历史的压缩摘要，作为上下文参考]';

/** 序列化单条消息为摘要输入行；system 等无关角色返回空串 */
function messageToSummaryLine(msg: Message): string {
  const clamp = (text: string): string =>
    text.length > COMPACTION_LINE_CLAMP
      ? `${text.slice(0, COMPACTION_LINE_CLAMP)}…(已截断)`
      : text;

  switch (msg.role) {
    case 'user': {
      const text = typeof msg.content === 'string' ? msg.content : extractText(msg.content);
      return `[用户] ${clamp(text)}`;
    }
    case 'assistant': {
      const parts: string[] = [];
      const content = msg.content;
      if (typeof content === 'string') {
        parts.push(content);
      } else {
        for (const block of content) {
          if (block.type === 'text') parts.push(block.text);
          else if (block.type === 'toolCall') {
            parts.push(`调用工具 ${block.name}(${JSON.stringify(block.arguments)})`);
          }
        }
      }
      return `[助手] ${clamp(parts.join('；'))}`;
    }
    case 'toolResult': {
      const m = msg as ToolResultMessage;
      const text = typeof m.content === 'string' ? m.content : extractText(m.content);
      return `[工具结果 ${m.toolName}] ${clamp(text)}`;
    }
    default: {
      // Message union 之外的扩展 role（compactionSummary / stateSnapshot 等）
      const role = (msg as { role: string }).role;
      // 已有的旧摘要/状态快照融入新摘要，避免反复压缩丢失早期信息
      if (role === 'compactionSummary' || role === 'stateSnapshot') {
        const text = typeof msg.content === 'string' ? msg.content : extractText(msg.content);
        return `[${role === 'compactionSummary' ? '历史摘要' : '状态快照'}] ${clamp(text)}`;
      }
      return '';
    }
  }
}

// ─── 工具执行结果（含 terminate 信号） ─────────────────────────────

/**
 * 单次/一组工具执行的产出。除结果列表外，携带 terminate 信号：
 * beforeToolCall / afterToolCall 可请求终止整个 run，
 * runLoop 检测到后停止循环（本轮工具结果仍写入会话以保持配对完整）。
 */
interface ToolExecutionOutcome {
  results: ToolResult[];
  /** 是否请求终止整个 run */
  terminate: boolean;
  /** 终止原因（写入 Result.metadata.terminateReason） */
  terminateReason?: string;
}

/** 单个工具执行的产出（含 terminate 信号） */
interface SingleToolOutcome {
  result: ToolResult;
  terminate: boolean;
  terminateReason?: string;
}

// ─── AgentRuntime: Runtime 接口的独立实现 ─────────────────────────

export class AgentRuntime implements Runtime {
  private _config: Record<string, unknown>;
  private _extensions: ExtensionManager;
  private _hooks: RuntimeHooks;
  /** 上下文转换器列表，按数组顺序链式执行（上一个输出作为下一个输入） */
  private _transformers: ContextTransformer[];

  private _model: Model;
  private _streamFn: StreamFn;
  private _systemPrompt: string;
  private _thinkingLevel: ThinkingLevel;
  private _globalTools: Map<string, Tool> = new Map();

  /** 多会话状态表：key = sessionKey。模型/工具/扩展/转换器等资源跨会话共享 */
  private _sessions: Map<string, SessionState>;
  /** 默认会话 key（常量 'default'；请求未指定 sessionKey 时路由到此会话） */
  private _sessionKey: string;
  /** 内存会话状态表 LRU 上限 */
  private _maxSessions: number;
  private _sessionStorage: SessionStorage | undefined;
  /** Extension 应用时的上下文（shared Map 供 ToolCallContext 引用） */
  private _extensionContext?: ExtensionContext;

  private _maxTurns: number;
  private _toolTimeoutMs: number;
  private _parallelToolCalls: boolean;
  private _contextBudgetRatio: number;
  /** 内置摘要压缩配置（未配置 = 保持旧行为，仅硬截断兜底） */
  private _compaction: CompactionOptions | undefined;
  private _telemetry: Telemetry | undefined;
  /** 框架级工具权限策略（未配置 → 放行，向后兼容） */
  private _permissionPolicy: PermissionPolicy | undefined;
  /** 审批管理器（pending 决策挂起等待外部批准；未配置 → pending 视为 deny） */
  private _approvals: ApprovalManager | undefined;
  /** 审批等待超时（毫秒） */
  private _approvalTimeoutMs: number;
  /** traceId 生成器（测试可注入确定性 id） */
  private _traceIdGenerator: (() => string) | undefined;

  private constructor(options: RuntimeOptions) {
    this._config = options.config ?? {};
    this._extensions = new ExtensionManager();
    this._hooks = this._extensions.getHooks();
    // 转换器按传入顺序链式执行（上一个输出作为下一个输入）
    this._transformers = [...(options.transformers ?? [])];

    this._model = options.model ?? {
      id: 'unknown',
      name: 'unknown',
      provider: 'unknown',
      contextWindow: 128000,
      maxTokens: 8192,
      reasoning: false,
    };

    this._streamFn = options.streamFn ?? (async function* () {
      throw new Error('streamFn 未设置，请通过 setStreamFn() 或 RuntimeOptions.streamFn 提供');
    });

    this._systemPrompt = options.systemPrompt ?? '';
    this._thinkingLevel = options.thinkingLevel ?? 'off';
    this._sessionStorage = options.sessionStorage;

    this._maxTurns = options.maxTurns ?? 50;
    this._toolTimeoutMs = options.toolTimeoutMs ?? 120_000;
    this._parallelToolCalls = options.parallelToolCalls ?? true;
    this._contextBudgetRatio = options.contextBudgetRatio ?? 0.8;
    this._compaction = options.compaction;
    this._telemetry = options.telemetry;
    this._permissionPolicy = options.permissionPolicy;
    this._approvals = options.approvals;
    this._approvalTimeoutMs = options.approvalTimeoutMs ?? 300_000;
    this._traceIdGenerator = options.traceIdGenerator;

    // 注册初始工具
    if (options.tools) {
      for (const tool of options.tools) {
        this._globalTools.set(tool.name, tool);
      }
    }

    this._sessionKey = 'default';
    this._maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    // 默认会话预先入表，保证未指定 sessionKey 的请求路由到它
    this._sessions = new Map([[this._sessionKey, createSessionState()]]);
  }

  // ─── 静态工厂 ───────────────────────────────────────────────────

  static create(options: RuntimeOptions = {}): AgentRuntime {
    const runtime = new AgentRuntime(options);

    // 注册扩展
    if (options.extensions) {
      runtime._extensions.registerAll(options.extensions);
    }

    // 应用扩展到钩子
    const ctx: ExtensionContext = {
      config: runtime._config,
      workspace: options.workspace ?? process.cwd(),
      sessionKey: runtime._sessionKey,
      shared: new Map(),
    };
    runtime._extensionContext = ctx;
    runtime._extensions.applyAll(ctx);

    return runtime;
  }

  // ─── Runtime 接口实现 ───────────────────────────────────────────

  get config(): Record<string, unknown> {
    return this._config;
  }

  get extensions(): ExtensionManager {
    return this._extensions;
  }

  get hooks(): RuntimeHooks {
    return this._hooks;
  }

  // ─── 工具/模型/流管理 ───────────────────────────────────────────

  registerTool(tool: Tool): this {
    if (this._globalTools.has(tool.name)) {
      console.warn(`[Runtime] 工具 "${tool.name}" 已存在，将被覆盖`);
    }
    this._globalTools.set(tool.name, tool);
    return this;
  }

  registerTools(tools: Tool[]): this {
    for (const tool of tools) {
      this.registerTool(tool);
    }
    return this;
  }

  setModel(model: Model): this {
    this._model = model;
    return this;
  }

  setSystemPrompt(prompt: string): this {
    this._systemPrompt = prompt;
    return this;
  }

  setThinkingLevel(level: ThinkingLevel): this {
    this._thinkingLevel = level;
    return this;
  }

  setStreamFn(fn: StreamFn): this {
    this._streamFn = fn;
    return this;
  }

  registerExtension(extension: Extension): this {
    this._extensions.register(extension);
    return this;
  }

  useTransformer(transformer: ContextTransformer): this {
    this._transformers.push(transformer);
    return this;
  }

  /** 获取指定会话的消息列表（默认会话；会话不存在返回空数组） */
  getMessages(sessionKey?: string): Message[] {
    const session = this._sessions.get(sessionKey ?? this._sessionKey);
    if (!session) return [];
    // 返回深拷贝，避免外部直接修改会话内部状态
    const messages = session.messages;
    try {
      return structuredClone(messages);
    } catch {
      return JSON.parse(JSON.stringify(messages));
    }
  }

  // ─── 核心运行逻辑 ───────────────────────────────────────────────

  /** 解析请求路由的会话 key：request.sessionKey ?? 默认会话 key */
  private resolveSessionKey(request: Request): string {
    return request.sessionKey ?? this._sessionKey;
  }

  /**
   * 获取（懒创建）会话状态。同一 Runtime 下不同 sessionKey 的消息历史、
   * 串行队列、abort 控制相互独立；共享模型/工具/扩展/转换器。
   * 超过 _maxSessions 时淘汰最久未用的非活动会话（仅清内存态，不删存储）。
   */
  private getSession(key: string): SessionState {
    let session = this._sessions.get(key);
    if (session) {
      // 刷新 LRU 顺序（Map 尾 = 最近使用）
      this._sessions.delete(key);
      this._sessions.set(key, session);
      return session;
    }
    session = createSessionState();
    this._sessions.set(key, session);
    this.evictIdleSessions();
    return session;
  }

  /** LRU 淘汰：仅淘汰非活动（未运行、未排队）的最久未用会话 */
  private evictIdleSessions(): void {
    if (this._sessions.size <= this._maxSessions) return;
    for (const [key, session] of this._sessions) {
      if (this._sessions.size <= this._maxSessions) break;
      // 运行中 / 已持有锁（入队待执行）不淘汰
      if (session.isStreaming || session.lockHeld) continue;
      this._sessions.delete(key);
    }
  }

  /** 当前活跃的会话 key 列表（含默认会话） */
  getSessionKeys(): string[] {
    return Array.from(this._sessions.keys());
  }

  /** 某会话是否存在（内存中） */
  hasSession(sessionKey: string): boolean {
    return this._sessions.has(sessionKey);
  }

  async run(request: Request): Promise<Result> {
    // 0. 校验请求
    const validation = validateRequest(request);
    if (!validation.valid) {
      const invalidResult = new ResultBuilder()
        .error(`请求校验失败: ${validation.errors.join('; ')}`)
        .build();
      // 校验失败也要可观测（errorClass='validation'），不进入排队
      await this.emitTelemetry('onRunEnd', {
        traceId: this.newTraceId(),
        sessionKey: this.resolveSessionKey(request),
        request,
        durationMs: 0,
        activeMs: 0,
        queuedMs: 0,
        turnCount: 0,
        result: invalidResult,
        success: false,
        errorClass: 'validation',
        tokens: { input: 0, output: 0 },
      });
      return invalidResult;
    }
    const finalRequest = normalizeRequest(request);
    const sessionKey = this.resolveSessionKey(finalRequest);
    const traceId = this.newTraceId();
    const queuedAt = Date.now();

    // 1. 入队前：onRunStart（配合 onRunEnd 求排队时长 queuedMs）
    await this.emitTelemetry('onRunStart', {
      traceId,
      sessionKey,
      request: finalRequest,
      queuedAt,
    });

    // 2. 串行化：同一会话的请求依次执行
    const session = this.getSession(sessionKey);
    const release = await this.acquire(session);
    const queuedMs = Date.now() - queuedAt;

    try {
      return await this.runWithStorageLock(finalRequest, sessionKey, () =>
        this._run(finalRequest, sessionKey, session, traceId, queuedMs),
      );
    } finally {
      release();
    }
  }

  async *stream(request: Request): AsyncGenerator<ResultChunk> {
    // 0. 校验请求
    const validation = validateRequest(request);
    if (!validation.valid) {
      const message = `请求校验失败: ${validation.errors.join('; ')}`;
      await this.emitTelemetry('onRunEnd', {
        traceId: this.newTraceId(),
        sessionKey: this.resolveSessionKey(request),
        request,
        durationMs: 0,
        activeMs: 0,
        queuedMs: 0,
        turnCount: 0,
        result: new ResultBuilder().error(message).build(),
        success: false,
        errorClass: 'validation',
        tokens: { input: 0, output: 0 },
      });
      yield { type: 'error', content: message };
      yield { type: 'done' };
      return;
    }
    const finalRequest = normalizeRequest(request);
    const sessionKey = this.resolveSessionKey(finalRequest);
    const traceId = this.newTraceId();
    const queuedAt = Date.now();

    await this.emitTelemetry('onRunStart', {
      traceId,
      sessionKey,
      request: finalRequest,
      queuedAt,
    });

    // 1. 串行化
    const session = this.getSession(sessionKey);
    const release = await this.acquire(session);
    const queuedMs = Date.now() - queuedAt;

    try {
      yield* this.streamWithStorageLock(finalRequest, sessionKey, () =>
        this._stream(finalRequest, sessionKey, session, traceId, queuedMs),
      );
    } finally {
      release();
    }
  }

  /**
   * 非 ephemeral 请求在"读(load)-改(run)-写(save)"全程持有存储级锁，
   * 防止多进程并发写同一会话导致 last-write-wins 丢消息。
   * ephemeral / 无锁支持 / 无存储时直接执行。
   */
  private async runWithStorageLock<T>(
    request: Request,
    sessionKey: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const storage = this._sessionStorage;
    if (request.ephemeral || !storage?.withLock) return fn();
    return storage.withLock(sessionKey, fn);
  }

  /** 流式版本：无法用回调包住生成器，改用手动锁（acquire/release） */
  private async *streamWithStorageLock(
    request: Request,
    sessionKey: string,
    gen: () => AsyncGenerator<ResultChunk>,
  ): AsyncGenerator<ResultChunk> {
    const storage = this._sessionStorage;
    if (request.ephemeral || !storage?.acquireLock) {
      yield* gen();
      return;
    }
    const lock = await storage.acquireLock(sessionKey);
    try {
      yield* gen();
    } finally {
      await lock.release();
    }
  }

  private async _run(
    request: Request,
    sessionKey: string,
    session: SessionState,
    traceId: string,
    queuedMs: number,
  ): Promise<Result> {
    const activeStartedAt = Date.now();

    // 1. 触发 beforeInitialize / afterInitialize
    await this._hooks.beforeInitialize.promise(request);
    await this._hooks.afterInitialize.promise(request);

    // 2. beforeRun（waterfall，可修改请求）
    const finalRequest = await this._hooks.beforeRun.promise(request);

    // 3. 会话持久化：从存储恢复历史消息（ephemeral 跳过）
    if (!finalRequest.ephemeral) {
      await this.hydrateSession(sessionKey, session);
    }

    // 4. 创建编译上下文
    const compilation = this.createCompilation(finalRequest, sessionKey, session, traceId);

    // 5. 添加用户消息（含媒体附件）
    compilation.messages.push(this.buildUserMessage(finalRequest));

    // 6. 运行对话循环
    try {
      await this.runLoop(compilation, finalRequest, session);

      // 7. 构建结果
      const result = this.buildResult(compilation);

      // 8. 触发 beforeEmit / afterEmit
      await this._hooks.beforeEmit.promise(result);
      await this._hooks.afterEmit.promise(result);

      // 9. 触发 done（携带最终 Request，供钩子按会话配对）
      await this._hooks.done.promise(result, finalRequest);

      compilation.completed = true;
      await this.emitRunEnd(finalRequest, sessionKey, compilation, result, queuedMs, activeStartedAt);
      return result;
    } catch (err) {
      const error = err as Error;
      // 非中止错误打印栈，便于线上排障（此前 catch 全部静默转 Result.error，丢栈）
      if (error?.name !== 'AbortError') {
        console.error('[Runtime] 运行失败:', error?.stack ?? error);
      }
      await this._hooks.failed.promise(error, finalRequest);

      const result = new ResultBuilder()
        .error(error.message)
        .build();
      await this.emitRunEnd(finalRequest, sessionKey, compilation, result, queuedMs, activeStartedAt);
      return result;
    } finally {
      // 10. 结束前最终保存会话（ephemeral 不持久化；失败不影响运行结果）
      await this.persistSessionSafe(finalRequest, sessionKey);
    }
  }

  private async *_stream(
    request: Request,
    sessionKey: string,
    session: SessionState,
    traceId: string,
    queuedMs: number,
  ): AsyncGenerator<ResultChunk> {
    const activeStartedAt = Date.now();

    // 1. 钩子
    await this._hooks.beforeInitialize.promise(request);
    await this._hooks.afterInitialize.promise(request);
    const finalRequest = await this._hooks.beforeRun.promise(request);

    // 2. 会话持久化：从存储恢复历史消息（ephemeral 跳过）
    if (!finalRequest.ephemeral) {
      await this.hydrateSession(sessionKey, session);
    }

    // 3. 创建编译上下文
    const compilation = this.createCompilation(finalRequest, sessionKey, session, traceId);

    // 4. 添加用户消息（含媒体附件）
    compilation.messages.push(this.buildUserMessage(finalRequest));

    // 5. 流式对话循环
    try {
      for await (const chunk of this.runLoopStream(compilation, finalRequest, session)) {
        yield chunk;
      }

      // 6. 构建并触发结果钩子
      const result = this.buildResult(compilation);
      await this._hooks.beforeEmit.promise(result);
      await this._hooks.afterEmit.promise(result);
      await this._hooks.done.promise(result, finalRequest);

      yield { type: 'done', result };
      await this.emitRunEnd(finalRequest, sessionKey, compilation, result, queuedMs, activeStartedAt);
    } catch (err) {
      const error = err as Error;
      if (error?.name !== 'AbortError') {
        console.error('[Runtime] 流式运行失败:', error?.stack ?? error);
      }
      await this._hooks.failed.promise(error, finalRequest);
      const result = new ResultBuilder().error(error.message).build();
      yield { type: 'error', content: error.message };
      yield { type: 'done', result };
      await this.emitRunEnd(finalRequest, sessionKey, compilation, result, queuedMs, activeStartedAt);
    } finally {
      await this.persistSessionSafe(finalRequest, sessionKey);
    }
  }

  createCompilation(request: Request, sessionKey?: string, session?: SessionState, traceId?: string): Compilation {
    return {
      request,
      graph: createTaskGraph(),
      resources: [],
      messages: (session ?? this.getSession(sessionKey ?? this._sessionKey)).messages,
      completed: false,
      traceId: traceId ?? this.newTraceId(),
    };
  }

  async close(): Promise<void> {
    // 等待所有会话的在途任务完成，再清理
    await Promise.allSettled(Array.from(this._sessions.values(), s => s.queue));

    for (const session of this._sessions.values()) {
      session.messages = [];
      session.hydrated = false;
    }
    this._sessions.clear();
    this._extensions.clear();
    this._transformers = [];
  }

  // ─── 对话循环（同步） ───────────────────────────────────────────

  private async runLoop(
    compilation: Compilation,
    request: Request,
    session: SessionState,
  ): Promise<void> {
    session.isStreaming = true;
    session.abortController = new AbortController();
    // 多会话路由：本次循环所属会话（请求携带的 sessionKey 优先）
    const sessionKey = this.resolveSessionKey(request);

    try {
      let maxTurns = this._maxTurns;
      let turnCount = 0; // step 长度：实际对话轮数（与 maxTurns 上限解耦）

      while (maxTurns-- > 0) {
        turnCount += 1;

        // 1. 链式转换上下文（原地替换，保持 session 引用）
        await this.transformMessages(compilation, sessionKey);

        // 1.5 阈值触发内置摘要压缩（估算 token 超窗口比例时，先摘要后截断兜底）
        await this.maybeCompactByThreshold(
          compilation, sessionKey, session.abortController!.signal,
        );

        // 2. 调用模型（streamModel 内部走统一埋点 streamModelEvents，
        //    含溢出自动恢复：检测 → 截断历史 → 同回合重试）
        const assistantMessage = await this.streamModel(
          compilation,
          session.abortController!.signal,
          sessionKey,
        );

        compilation.messages.push(assistantMessage);
        // 3.1 实时持久化：assistant 回复完成即落盘（运行中可查看最新会话）
        await this.persistSessionSafe(request, sessionKey);

        // 4. 检查工具调用
        const toolCalls = extractToolCalls(assistantMessage.content);

        if (toolCalls.length === 0) {
          break;  // 无工具调用，结束循环
        }

        // 5. 执行工具（可选并行）
        const outcome = await this.executeToolCalls(
          compilation,
          toolCalls,
          session.abortController!.signal,
        );
        // 5.1 实时持久化：工具结果落盘
        await this.persistSessionSafe(request, sessionKey);
        // 5.2 beforeToolCall/afterToolCall 请求终止：停止循环
        if (outcome.terminate) {
          compilation.terminateReason = outcome.terminateReason ?? 'terminated';
          break;
        }
      }

      // 回合上限耗尽（循环条件失效而非 break 退出，maxTurns 已减至 -1）：
      // 模型仍请求工具调用但被截断，标记供 buildResult 输出 'max_turns'
      if (maxTurns < 0) compilation.maxTurnsExhausted = true;
      compilation.turnCount = turnCount;
    } finally {
      this.markIdle(session);
    }
  }

  // ─── 对话循环（流式） ───────────────────────────────────────────

  private async *runLoopStream(
    compilation: Compilation,
    request: Request,
    session: SessionState,
  ): AsyncGenerator<ResultChunk> {
    session.isStreaming = true;
    session.abortController = new AbortController();
    // 多会话路由：本次流式循环所属会话
    const sessionKey = this.resolveSessionKey(request);

    try {
      let maxTurns = this._maxTurns;
      let turnCount = 0; // step 长度：实际对话轮数（与 maxTurns 上限解耦）

      while (maxTurns-- > 0) {
        turnCount += 1;

        // 1. 链式转换上下文（原地替换，保持 session 引用）
        await this.transformMessages(compilation, sessionKey);

        // 1.5 阈值触发内置摘要压缩（估算 token 超窗口比例时，先摘要后截断兜底）
        await this.maybeCompactByThreshold(
          compilation, sessionKey, session.abortController!.signal,
        );

        // 2. 流式调用模型（统一埋点 + 溢出自动恢复：可恢复的溢出错误
        //    吞掉 error chunk，截断历史后同回合重试）
        const turn = this.modelTurnWithRecovery(
          compilation,
          session.abortController!.signal,
          sessionKey,
          true, // stream 模式：同时统计首 token 延迟
        );
        let turnResult = await turn.next();
        while (!turnResult.done) {
          yield turnResult.value;
          turnResult = await turn.next();
        }
        const assistantMessage = turnResult.value;

        if (!assistantMessage) break;
        compilation.messages.push(assistantMessage);
        // 3.1 实时持久化：assistant 回复完成即落盘（运行中可查看最新会话）
        await this.persistSessionSafe(request, sessionKey);

        // 4. 检查工具调用
        const toolCalls = extractToolCalls(assistantMessage.content);

        if (toolCalls.length === 0) {
          break;
        }

        // 5. 执行工具
        for (const toolCall of toolCalls) {
          yield {
            type: 'tool_start',
            toolName: toolCall.name,
            toolCallId: toolCall.id,
          };
        }

        const outcome = await this.executeToolCallsStreaming(
          compilation,
          toolCalls,
          session.abortController!.signal,
        );
        // 5.1 实时持久化：工具结果落盘
        await this.persistSessionSafe(request, sessionKey);

        // 5.2 yield tool_end（block 的工具也产出事件，便于前端展示被拒调用）
        for (let i = 0; i < toolCalls.length; i++) {
          yield {
            type: 'tool_end',
            toolName: toolCalls[i].name,
            toolCallId: toolCalls[i].id,
            isError: this.isErrorResult(outcome.results[i]),
          };
        }

        // 5.3 beforeToolCall/afterToolCall 请求终止：tool_end 之后再停止循环
        if (outcome.terminate) {
          compilation.terminateReason = outcome.terminateReason ?? 'terminated';
          break;
        }
      }

      // 回合上限耗尽（循环条件失效而非 break 退出，maxTurns 已减至 -1）：
      // 模型仍请求工具调用但被截断，标记供 buildResult 输出 'max_turns'
      if (maxTurns < 0) compilation.maxTurnsExhausted = true;
      compilation.turnCount = turnCount;
    } finally {
      this.markIdle(session);
    }
  }

  // ─── 工具执行 ───────────────────────────────────────────────────

  /** 同步循环：执行工具调用并将结果消息按原顺序追加 */
  private async executeToolCalls(
    compilation: Compilation,
    toolCalls: ToolCallContent[],
    signal: AbortSignal,
  ): Promise<ToolExecutionOutcome> {
    const outcome = await this.runTools(toolCalls, signal, compilation.request, compilation.traceId);
    for (let i = 0; i < toolCalls.length; i++) {
      compilation.messages.push(
        this.buildToolResultMessage(toolCalls[i], outcome.results[i]),
      );
    }
    return outcome;
  }

  /** 流式循环：执行工具调用，返回结果（消息由调用方追加） */
  private async executeToolCallsStreaming(
    compilation: Compilation,
    toolCalls: ToolCallContent[],
    signal: AbortSignal,
  ): Promise<ToolExecutionOutcome> {
    const outcome = await this.runTools(toolCalls, signal, compilation.request, compilation.traceId);
    for (let i = 0; i < toolCalls.length; i++) {
      compilation.messages.push(
        this.buildToolResultMessage(toolCalls[i], outcome.results[i]),
      );
    }
    return outcome;
  }

  /**
   * 执行一组工具调用：parallelToolCalls 为 true 时并行，否则串行。
   * 返回 ToolExecutionOutcome：任一工具请求 terminate 即终止整个 run；
   * 串行模式下 terminate 后剩余工具生成 skipped 结果以保持配对完整。
   */
  private async runTools(
    toolCalls: ToolCallContent[],
    signal: AbortSignal,
    request: Request,
    traceId: string,
  ): Promise<ToolExecutionOutcome> {
    const execute = (tc: ToolCallContent) => this.executeTool(tc, signal, request, traceId);

    if (this._parallelToolCalls && toolCalls.length > 1) {
      // 并行：全部执行，聚合 terminate（取第一个命中的原因）
      const outcomes = await Promise.all(toolCalls.map(execute));
      const terminated = outcomes.find(o => o.terminate);
      return {
        results: outcomes.map(o => o.result),
        terminate: !!terminated,
        terminateReason: terminated?.terminateReason,
      };
    }

    // 串行：依次执行；遇 terminate 后剩余工具跳过执行（生成 skipped 结果保持配对）
    const results: ToolResult[] = [];
    let terminate = false;
    let terminateReason: string | undefined;
    for (const tc of toolCalls) {
      if (terminate) {
        results.push(this.makeSkippedResult(tc));
        continue;
      }
      const outcome = await execute(tc);
      results.push(outcome.result);
      if (outcome.terminate) {
        terminate = true;
        terminateReason = outcome.terminateReason;
      }
    }
    return { results, terminate, terminateReason };
  }

  private async executeTool(
    toolCall: ToolCallContent,
    signal: AbortSignal | undefined,
    request: Request,
    traceId: string,
  ): Promise<SingleToolOutcome> {
    const tool = this._globalTools.get(toolCall.name);

    if (!tool) {
      return {
        result: {
          content: [createTextContent(`Tool "${toolCall.name}" not found`)],
          details: { error: `Tool "${toolCall.name}" not found` },
        },
        terminate: false,
      };
    }

    // ─── 参数预处理（权限裁决与执行钩子均基于处理后的 args）───
    let args: unknown = toolCall.arguments;
    if (tool.prepareArguments) {
      args = tool.prepareArguments(toolCall.arguments);
    }

    // ─── PermissionPolicy：框架级安全底线，先于扩展钩子裁决 ───
    // 未配置策略 → 放行（向后兼容）；deny / confirm 未批准 → blocked 结果；
    // pending → 挂起等待外部审批（超时 / run abort 均视为拒绝）
    if (this._permissionPolicy) {
      const permissionReq: PermissionRequest = {
        toolName: toolCall.name,
        permissions: tool.permissions ?? [],
        args,
        sessionKey: request.sessionKey ?? this._sessionKey,
        request,
        shared: this._extensionContext?.shared ?? new Map(),
      };
      const decision = await this._permissionPolicy.check(permissionReq);
      let allowed = decision === 'allow';
      if (decision === 'confirm') {
        allowed = this._permissionPolicy.confirm
          ? await this._permissionPolicy.confirm(permissionReq)
          : false;
      }
      if (decision === 'pending') {
        // 挂起等待外部审批（异步 Human-in-the-loop）；
        // 未配置审批管理器 → 保守拒绝（与 confirm 未提供回调的行为一致）
        if (this._approvals) {
          const approval = this._approvals.create(permissionReq, {
            timeoutMs: this._approvalTimeoutMs,
            signal,
          });
          await this.emitTelemetry('onApprovalPending', {
            traceId,
            sessionKey: permissionReq.sessionKey,
            approvalId: approval.id,
            toolName: toolCall.name,
            permissions: permissionReq.permissions,
            args,
            expiresAt: approval.expiresAt,
          });
          const outcome = await this._approvals.wait(approval);
          allowed = outcome.status === 'approved';
          await this.emitTelemetry('onApprovalResolved', {
            traceId,
            sessionKey: permissionReq.sessionKey,
            approvalId: approval.id,
            toolName: toolCall.name,
            outcome: outcome.status,
            waitedMs: outcome.waitedMs,
          });
        } else {
          allowed = false;
        }
      }
      if (!allowed) {
        const reason = `permission denied by policy for tool "${toolCall.name}"`;
        await this.emitTelemetry('onPermissionDenied', {
          traceId,
          sessionKey: permissionReq.sessionKey,
          toolName: toolCall.name,
          permissions: permissionReq.permissions,
          args,
          reason,
        });
        return {
          result: this.makeBlockedResult(reason),
          terminate: false,
        };
      }
    }

    // ─── 工具超时信号：权限裁决（含审批挂起）完成后起表，
    // 审批等待不占用工具执行超时 ───
    const { signal: timedSignal, clear } = withTimeoutSignal(signal, this._toolTimeoutMs);
    try {
      // ─── beforeToolCall：参数校验后、执行前（可 block / terminate / 改写 args）───
      const beforeCtx = this.buildToolCallContext(toolCall, tool, args, request, timedSignal);
      const before: BeforeToolCallDecision = await this._hooks.beforeToolCall.promise(
        { block: false, terminate: false, args },
        beforeCtx,
      );

      if (before.terminate) {
        const reason = before.reason ?? 'terminated by beforeToolCall';
        return {
          result: this.makeBlockedResult(reason),
          terminate: true,
          terminateReason: reason,
        };
      }
      if (before.block) {
        const reason = before.reason ?? 'blocked by beforeToolCall';
        return {
          result: this.makeBlockedResult(reason),
          terminate: false,
        };
      }
      // 允许 beforeToolCall 改写参数
      args = before.args;

      // ─── 执行工具 ───
      const toolStartedAt = Date.now();
      let result: ToolResult;
      try {
        result = await tool.execute(toolCall.id, args, timedSignal);
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        result = {
          content: [createTextContent(message)],
          details: { error: message },
        };
      }

      const status = toolResultStatus(result);
      await this.emitTelemetry('onToolCall', {
        traceId,
        spanId: newSpanId(),
        sessionKey: request.sessionKey ?? this._sessionKey,
        toolName: toolCall.name,
        args,
        durationMs: Date.now() - toolStartedAt,
        result,
        success: status === 'ok',
        status,
        errorClass:
          status === 'error'
            ? (errorClassFromMessage(String((result.details as { error?: unknown })?.error ?? '')) as ErrorClass | undefined) ?? 'tool_error'
            : undefined,
      });

      // ─── afterToolCall：执行后、事件发出前（可改写 result / terminate）───
      // 用更新后的 args 重建 ctx，让 afterToolCall 看到改写后的参数
      const afterCtx = this.buildToolCallContext(toolCall, tool, args, request, timedSignal);
      const after: AfterToolCallDecision = await this._hooks.afterToolCall.promise(
        { result, terminate: false },
        afterCtx,
      );

      return {
        result: after.result,
        terminate: after.terminate,
        terminateReason: after.terminate ? 'terminated by afterToolCall' : undefined,
      };
    } finally {
      clear();
    }
  }

  private isErrorResult(result: ToolResult): boolean {
    return !!(result.details && typeof result.details === 'object' && 'error' in result.details);
  }

  /** beforeToolCall 阻断/终止时生成拒绝结果（非执行错误，isError=false） */
  private makeBlockedResult(reason: string): ToolResult {
    return {
      content: [createTextContent(`[blocked] ${reason}`)],
      details: { blocked: true, reason },
    };
  }

  /** 串行模式下前序工具 terminate 后，剩余工具生成 skipped 结果保持配对 */
  private makeSkippedResult(toolCall: ToolCallContent): ToolResult {
    return {
      content: [createTextContent(`[skipped] run terminated by prior tool: ${toolCall.name}`)],
      details: { skipped: true, toolName: toolCall.name },
    };
  }

  /** 构建 ToolCallContext：beforeToolCall/afterToolCall 的调用上下文 */
  private buildToolCallContext(
    toolCall: ToolCallContent,
    tool: Tool,
    args: unknown,
    request: Request,
    signal: AbortSignal,
  ): ToolCallContext {
    return {
      toolCall,
      tool,
      args,
      sessionKey: request.sessionKey ?? this._sessionKey,
      request,
      shared: this._extensionContext?.shared ?? new Map(),
      signal,
    };
  }

  private buildToolResultMessage(
    toolCall: ToolCallContent,
    result: ToolResult,
  ): ToolResultMessage {
    return {
      role: 'toolResult',
      content: result.content,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      isError: this.isErrorResult(result),
      timestamp: Date.now(),
    };
  }

  private buildUserMessage(request: Request): UserMessage {
    if (request.media && request.media.length > 0) {
      const blocks: ContentBlock[] = [
        createTextContent(request.message),
        ...request.media.filter(Boolean).map(buildImageContent),
      ];
      return {
        role: 'user',
        content: blocks,
        timestamp: Date.now(),
      };
    }
    return {
      role: 'user',
      content: request.message,
      timestamp: Date.now(),
    };
  }

  // ─── 内部方法 ───────────────────────────────────────────────────

  /**
   * 获取同一会话的执行锁：返回 release 函数，调用后释放。
   * 同一 sessionKey 的 run/stream 会串行执行，避免消息数组交错、
   * abortController 互相覆盖、hydrate 竞态。
   */
  private async acquire(session: SessionState): Promise<() => void> {
    let release!: () => void;
    const prev = session.queue;
    session.queue = new Promise<void>(resolve => {
      release = () => resolve();
    });
    await prev;
    session.lockHeld = true;
    return () => {
      session.lockHeld = false;
      release();
    };
  }

  /** 标记会话空闲并唤醒所有 waitForIdle 等待者 */
  private markIdle(session: SessionState): void {
    session.isStreaming = false;
    session.abortController = null;
    if (session.idleResolvers.length > 0) {
      const resolvers = session.idleResolvers.splice(0);
      for (const resolve of resolvers) resolve();
    }
  }

  // ─── 会话持久化 ─────────────────────────────────────────────────

  /** 从存储懒加载会话（串行化后无竞态，每个会话仅恢复一次） */
  private async hydrateSession(
    sessionKey: string,
    session: SessionState,
  ): Promise<void> {
    if (!this._sessionStorage) return;
    if (session.hydrated) return;
    session.hydrated = true;

    const stored = await this._sessionStorage.load(sessionKey);
    if (!stored) return;

    session.messages = stored.messages;
    session.createdAt = stored.createdAt;
  }

  /** 整体保存指定会话（ephemeral 跳过；失败不影响运行结果） */
  private async persistSession(
    sessionKey: string,
    session: SessionState,
  ): Promise<void> {
    if (!this._sessionStorage) return;

    const stored: StoredSession = {
      key: sessionKey,
      version: SESSION_VERSION,
      messages: session.messages,
      model: this.deriveModel(session.messages),
      usage: this.sumUsage(session.messages),
      createdAt: session.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await this._sessionStorage.save(sessionKey, stored);
  }

  /**
   * 实时持久化指定会话：每轮 assistant 回复/工具结果完成后调用，
   * 让运行中的会话随时可被持久化数据观测到。ephemeral 跳过；
   * 存储失败仅告警，不影响对话循环继续。
   */
  private async persistSessionSafe(
    request: Request,
    sessionKey: string,
  ): Promise<void> {
    if (request.ephemeral || !this._sessionStorage) return;
    try {
      const session = this._sessions.get(sessionKey);
      if (!session) return; // 会话已被淘汰/删除，跳过
      await this.persistSession(sessionKey, session);
    } catch (err) {
      console.warn('[Runtime] 会话持久化失败:', (err as Error)?.message);
    }
  }

  /** 从消息中推导最后使用的模型 */
  private deriveModel(messages: Message[]): SessionModel | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant' && (msg as AssistantMessage).model) {
        return {
          provider: (msg as AssistantMessage).provider ?? this._model.provider,
          modelId: (msg as AssistantMessage).model as string,
        };
      }
    }
    return null;
  }

  /** 汇总所有 assistant 消息的 token 用量（含 cache） */
  private sumUsage(messages: Message[]): Usage {
    const usage = createEmptyUsage();
    for (const msg of messages) {
      if (msg.role === 'assistant') {
        const u = (msg as AssistantMessage).usage;
        if (u) {
          usage.input += u.input;
          usage.output += u.output;
          usage.total += u.total;
          usage.cacheRead = (usage.cacheRead ?? 0) + (u.cacheRead ?? 0);
          usage.cacheWrite = (usage.cacheWrite ?? 0) + (u.cacheWrite ?? 0);
          usage.reasoning = (usage.reasoning ?? 0) + (u.reasoning ?? 0);
        }
      }
    }
    return usage;
  }

  /** 链式执行上下文转换器（按数组顺序，上一个输出作为下一个输入） */
  private async transformMessages(
    compilation: Compilation,
    sessionKey: string,
  ): Promise<void> {
    if (this._transformers.length === 0) {
      return;
    }

    let resources = messagesToResources(compilation.messages);
    const context: TransformContext = {
      graph: compilation.graph,
      runtime: {
        sessionKey,
        turn: compilation.messages.length,
        contextWindow: this._model.contextWindow,
        maxTokens: this._model.maxTokens,
        contextBudgetRatio: this._contextBudgetRatio,
      },
    };

    for (const transformer of this._transformers) {
      try {
        resources = await transformer.transform(resources, context);
      } catch (err) {
        // 单个转换器失败时跳过，保持当前资源不变，但需可观测
        console.warn(
          `[Runtime] 转换器 "${transformer.name}" 失败，已跳过:`,
          (err as Error)?.message ?? err,
        );
      }
    }

    const messages = resourcesToMessages(resources);
    // 原地替换而非重新赋值：createCompilation 将 session.messages 按引用共享，
    // 重新赋值会导致后续 push 的 assistant/tool 消息脱离会话（持久化丢失）
    compilation.messages.splice(0, compilation.messages.length, ...messages);
  }

  private buildContext(messages: Message[]): Context {
    const tools = Array.from(this._globalTools.values());
    return {
      systemPrompt: this._systemPrompt,
      // compactionSummary 为内部扩展 role，provider 适配层仅支持
      // user/assistant/toolResult，发出前统一转为带标注的 user 消息
      messages: messages
        .filter(m => m.role !== 'system')
        .map(m => ((m as { role: string }).role === 'compactionSummary'
          ? this.compactionSummaryToUser(m)
          : m)),
      tools: tools.length > 0 ? tools : undefined,
    };
  }

  /** compactionSummary 消息 → user 消息（所有 provider 均兼容 user role） */
  private compactionSummaryToUser(msg: Message): Message {
    const text = typeof msg.content === 'string' ? msg.content : extractText(msg.content);
    return {
      role: 'user',
      content: `${COMPACTION_USER_PREFIX}\n${text}`,
      timestamp: msg.timestamp,
    } as Message;
  }

  private async streamModel(
    compilation: Compilation,
    signal: AbortSignal,
    sessionKey: string,
  ): Promise<AssistantMessage> {
    // 含溢出自动恢复（modelTurnWithRecovery）；非流式路径丢弃事件 chunk
    const turn = this.modelTurnWithRecovery(compilation, signal, sessionKey, false);
    let r = await turn.next();
    while (!r.done) r = await turn.next();
    return r.value ?? this.emptyAssistantMessage();
  }

  /** 空的 assistant 消息（流异常中断无 done/error 事件时的兜底，与旧 streamModel 行为一致） */
  private emptyAssistantMessage(): AssistantMessage {
    return {
      role: 'assistant',
      content: [],
      stopReason: 'stop',
      usage: createEmptyUsage(),
      model: this._model.id,
      provider: this._model.provider,
      timestamp: Date.now(),
    };
  }

  /**
   * 单回合模型调用 + 上下文溢出自动恢复闭环。
   *
   * 检测（isContextOverflow，统一传入 model.contextWindow / content / maxTokens，
   * 覆盖显式错误 / 静默溢出 / 输入截断溢出 / 输出 thinking 耗尽 / 输出打满 五模式）
   * → 丢弃失败的 assistant 消息 → 截断会话历史 → 同回合重试（不消耗回合数，
   * 上限 OVERFLOW_RECOVERY_LIMIT）：
   *
   * - 显式错误 / 零产出截断溢出 / thinking 耗尽溢出 / 输出打满溢出：丢弃失败
   *   消息后重试；流式路径吞掉可恢复的 error chunk（消费者看不到瞬态错误），
   *   不可恢复时补发。
   * - 静默溢出（stop + 有完整产出）：保留回复，仅压缩旧上下文供后续轮次。
   * - 恢复耗尽或单请求超窗（无可丢弃）：返回最后一次错误消息，维持旧行为。
   *
   * 流式路径 yield 模型事件 chunk；非流式路径由 streamModel 消费（chunk 丢弃）。
   * 返回最终 assistant 消息；无 done/error 事件时返回 null。
   */
  private async *modelTurnWithRecovery(
    compilation: Compilation,
    signal: AbortSignal,
    sessionKey: string,
    stream: boolean,
  ): AsyncGenerator<ResultChunk, AssistantMessage | null> {
    const contextWindow = this._model.contextWindow;
    const maxTokens = this._model.maxTokens;
    let recoveries = 0;

    // 把 content / maxTokens 一并塞入 OverflowProbeMessage，供 isContextOverflow
    // 识别「只有 thinking 没有有效产出」和「output 打满 maxTokens」两种可恢复截断。
    const toProbe = (m: AssistantMessage) => ({
      stopReason: m.stopReason,
      errorMessage: m.errorMessage,
      usage: m.usage,
      content: m.content,
      maxTokens,
    });

    while (true) {
      let assistant: AssistantMessage | null = null;
      /** 被吞掉的可恢复溢出错误消息（等待恢复决策：重试则丢弃，不可恢复则补发 chunk） */
      let suppressed: AssistantMessage | null = null;

      for await (const event of this.streamModelEvents(compilation, signal, stream)) {
        if (event.type === 'error') {
          const msg = event.message;
          if (
            recoveries < OVERFLOW_RECOVERY_LIMIT &&
            isContextOverflow(toProbe(msg), contextWindow)
          ) {
            suppressed = msg; // 吞掉 error chunk，稍后恢复重试
            continue;
          }
          const chunk = this.streamEventToChunk(event);
          if (chunk) yield chunk;
          assistant = msg;
        } else {
          const chunk = this.streamEventToChunk(event);
          if (chunk) yield chunk;
          if (event.type === 'done') assistant = event.message;
        }
      }

      const final = assistant ?? suppressed;
      if (!final) return null; // 流异常中断（无 done/error 事件）

      if (isContextOverflow(toProbe(final), contextWindow)) {
        // failed：需要丢弃上轮并立即重试的场景
        //  - stop=error 或 output=0：原有判定
        //  - stop=length 但 content 里只有 thinking（零有效产出）：reasoning 预算耗尽
        //    必须重跑（catalog 已给更高 maxTokens，但仍有可能碰到边界）
        //  - stop=length 且 output 打满 maxTokens：回复被截断，丢弃并压缩后重试
        const output = final.usage?.output ?? 0;
        const blocks = Array.isArray(final.content) ? final.content : null;
        const hasMeaningfulText = blocks?.some(
          (b) => b.type === 'text' && 'text' in b && typeof b.text === 'string' && b.text.trim().length > 0,
        );
        const hasToolCall = blocks?.some((b) => b.type === 'toolCall');
        const thinkingOnly = blocks
          ? !hasMeaningfulText && !hasToolCall && blocks.some((b) => b.type === 'thinking')
          : false;
        const outputFull = maxTokens > 0 && output >= Math.floor(maxTokens * 0.95);

        const failed = final.stopReason === 'error' || output === 0 || thinkingOnly || outputFull;
        if (failed && recoveries < OVERFLOW_RECOVERY_LIMIT) {
          recoveries += 1;
          if (await this.recoverFromOverflow(compilation, recoveries, sessionKey, signal)) {
            const reason =
              thinkingOnly ? 'thinking 耗尽' : outputFull ? 'output 打满' : final.stopReason;
            console.warn(
              `[Runtime] 上下文溢出（${reason}），已压缩历史并同回合重试（${recoveries}/${OVERFLOW_RECOVERY_LIMIT}）`,
            );
            await this.emitTelemetry('onRetry', {
              traceId: compilation.traceId,
              provider: this._model.provider,
              modelId: this._model.id,
              attempt: recoveries,
              errorClass: 'context-overflow',
              delayMs: 0,
              willRetry: true,
            });
            continue; // 同回合重试（不消耗回合数）
          }
          // 无可丢弃（单条请求即超窗）：补发被吞的 error chunk 后原样返回
          if (suppressed) {
            yield { type: 'error', content: final.errorMessage || '模型调用出错' };
          }
          return final;
        }
        if (failed) return final; // 恢复次数耗尽，维持旧行为（错误消息落库）
        // 静默溢出（stop + 有完整产出）：保留回复，仅压缩旧上下文供后续轮次
        await this.recoverFromOverflow(compilation, 1, sessionKey, signal);
        console.warn('[Runtime] 检测到静默上下文溢出（usage 超窗），已压缩历史消息');
      }

      return final;
    }
  }

  /**
   * 计算溢出恢复的截断点：按 token 预算从最旧消息开始丢弃。
   *
   * 预算随恢复次数指数收紧（contextWindow × ratio × 0.5^recovery），且每次
   * 至少丢弃可丢弃部分的一半，保证重试规模必然小于上次溢出（token 估算
   * 偏小时也成立）。最后一条消息（当前请求/最新产出）始终保留。
   * 返回被压缩段的结束下标（messages[0..split) 为被压缩段）；0 = 已到
   * 最小集，单条请求即超窗，无法恢复。
   */
  private computeOverflowSplit(messages: Message[], recovery: number): number {
    const contextWindow = this._model.contextWindow;
    if (!contextWindow || contextWindow <= 0) return 0;
    const target = Math.max(
      Math.floor(contextWindow * this._contextBudgetRatio * 0.5 ** recovery),
      1,
    );

    let total = 0;
    for (const m of messages) total += estimateMessageTokens(m);

    const droppable = messages.length - 1; // 最后一条必保
    if (droppable <= 0) return 0;
    // 至少丢弃一半可丢弃消息，保证恢复必然缩小规模（估算偏小时的兜底）
    const mustDrop = Math.max(Math.floor(droppable / 2), 1);

    let dropUntil = 0;
    while (dropUntil < droppable && (dropUntil < mustDrop || total > target)) {
      total -= estimateMessageTokens(messages[dropUntil]);
      dropUntil += 1;
    }
    return dropUntil;
  }

  /**
   * 溢出恢复：摘要优先、硬截断兜底（原地修改会话消息）。
   *
   * 开启 compaction（默认）时，被压缩段先尝试 LLM 摘要替换（compactionSummary
   * 消息），摘要失败或序列化超摘要预算（请求本身会超窗）则降级纯丢弃；
   * 关闭 compaction 时维持旧行为纯截断。截断/摘要后均经 ensureToolPairing
   * 修复保留段的工具配对。返回是否执行了恢复动作（false = 无可压缩，单条
   * 请求即超窗）。
   */
  private async recoverFromOverflow(
    compilation: Compilation,
    recovery: number,
    sessionKey: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const messages = compilation.messages;
    const split = this.computeOverflowSplit(messages, recovery);
    if (split <= 0) return false;

    const useCompaction =
      !!this._compaction &&
      this._compaction.enabled !== false &&
      this._compaction.onOverflow !== false;
    if (useCompaction) {
      await this.compactOrTruncate(
        messages, split, sessionKey, compilation.traceId, signal, 'overflow',
      );
      return true;
    }

    const kept = ensureToolPairing(messages.slice(split));
    messages.splice(0, messages.length, ...kept);
    return true;
  }

  /**
   * 阈值触发内置摘要压缩（runLoop 每轮模型调用前检查，低频）：
   * 估算 token 超过 contextWindow × triggerRatio（默认 contextBudgetRatio）
   * 时，将历史压缩到 targetRatio（默认 0.5）——最新消息保留目标的一半，
   * 其余部分摘要替换；摘要失败降级硬截断。
   */
  private async maybeCompactByThreshold(
    compilation: Compilation,
    sessionKey: string,
    signal: AbortSignal,
  ): Promise<void> {
    // 未配置 compaction = 保持旧行为（不压缩，溢出时硬截断兜底）
    if (!this._compaction || this._compaction.enabled === false) return;
    const contextWindow = this._model.contextWindow;
    if (!contextWindow || contextWindow <= 0) return;

    const messages = compilation.messages;
    const triggerTokens = Math.floor(
      contextWindow * (this._compaction?.triggerRatio ?? this._contextBudgetRatio),
    );

    let total = 0;
    for (const m of messages) total += estimateMessageTokens(m);
    if (total <= triggerTokens) return;

    // 从尾部累计保留最新消息，保留量为压缩目标的一半
    const targetTokens = Math.floor(
      contextWindow * (this._compaction?.targetRatio ?? 0.5),
    );
    const keepTokens = Math.max(Math.floor(targetTokens / 2), 1);

    let kept = 0;
    let split = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (kept >= keepTokens) {
        split = i + 1;
        break;
      }
      kept += estimateMessageTokens(messages[i]);
      split = i;
    }
    // 无可压缩段（最新消息已占满保留预算）：等待下一轮
    if (split <= 0 || split >= messages.length) return;

    const mode = await this.compactOrTruncate(
      messages, split, sessionKey, compilation.traceId, signal, 'threshold',
    );
    console.warn(
      `[Runtime] 上下文达阈值（约 ${total} token > ${triggerTokens}），已${mode === 'summary' ? '摘要压缩' : '截断'}历史`,
    );
  }

  /**
   * 手动压缩指定会话（交互命令 /compact 等）：跳过阈值判断，
   * 直接将历史压缩至 targetRatio 保留量（复用 maybeCompactByThreshold
   * 的保留段计算与 compactOrTruncate 执行路径），压缩后持久化。
   */
  async compact(sessionKey?: string): Promise<'summary' | 'truncate' | null> {
    if (!this._compaction || this._compaction.enabled === false) return null;
    const key = sessionKey ?? this._sessionKey;
    const session = this.getSession(key);
    const messages = session.messages;
    if (messages.length === 0) return null;

    const contextWindow = this._model.contextWindow;
    if (!contextWindow || contextWindow <= 0) return null;

    // 与 maybeCompactByThreshold 相同的保留段计算：保留 target 的一半（最新消息）
    const targetTokens = Math.floor(
      contextWindow * (this._compaction.targetRatio ?? 0.5),
    );
    const keepTokens = Math.max(Math.floor(targetTokens / 2), 1);

    let kept = 0;
    let split = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (kept >= keepTokens) {
        split = i + 1;
        break;
      }
      kept += estimateMessageTokens(messages[i]);
      split = i;
    }
    // 无可压缩段（最新消息已占满保留预算）
    if (split <= 0 || split >= messages.length) return null;

    const mode = await this.compactOrTruncate(
      messages, split, key, `manual-${Date.now().toString(36)}`,
      new AbortController().signal, 'threshold',
    );
    try {
      await this.persistSession(key, session);
    } catch (err) {
      console.warn('[Runtime] 手动压缩后持久化失败:', (err as Error)?.message);
    }
    return mode;
  }

  /**
   * 执行压缩：messages[0..split) 为被压缩段，原地替换。
   *
   * 摘要成功 → 被压缩段替换为单条 compactionSummary 消息（资源层 pinned）；
   * 序列化超摘要预算或摘要调用失败 → 降级纯丢弃（旧行为）。两种路径均对
   * 保留段执行 ensureToolPairing（被压缩段边界可能截断工具配对）。上报
   * onCompaction 遥测。
   */
  private async compactOrTruncate(
    messages: Message[],
    split: number,
    sessionKey: string,
    traceId: string,
    signal: AbortSignal,
    trigger: 'threshold' | 'overflow',
  ): Promise<'summary' | 'truncate'> {
    const compacted = messages.slice(0, split);
    const tokensBefore = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

    let mode: 'summary' | 'truncate' = 'truncate';
    let summaryText = '';

    const summaryEnabled = !!this._compaction && this._compaction.enabled !== false;
    if (summaryEnabled && compacted.length > 0) {
      const summaryBudget = Math.floor(
        this._model.contextWindow * COMPACTION_SUMMARY_BUDGET_RATIO,
      );
      const inputText = compacted
        .map(m => messageToSummaryLine(m))
        .filter(line => line.length > 0)
        .join('\n');
      // 预算判断：被压缩段超预算时摘要请求自身必然超窗，不发 doomed 请求
      if (inputText && estimateTextTokens(inputText) <= summaryBudget) {
        const summary = await this.summarizeMessages(
          inputText, sessionKey, traceId, signal,
        );
        if (summary && summary.trim()) {
          summaryText = summary.trim();
          mode = 'summary';
        }
      }
    }

    let tokensAfter: number;
    if (mode === 'summary') {
      const summaryMsg = this.createCompactionSummaryMessage(summaryText);
      const kept = ensureToolPairing(messages.slice(split));
      messages.splice(0, messages.length, summaryMsg, ...kept);
      tokensAfter = estimateMessageTokens(summaryMsg)
        + kept.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    } else {
      const kept = ensureToolPairing(messages.slice(split));
      messages.splice(0, messages.length, ...kept);
      tokensAfter = kept.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    }

    await this.emitTelemetry('onCompaction', {
      traceId,
      sessionKey,
      mode,
      trigger,
      tokensBefore,
      tokensAfter,
      droppedMessages: split,
      summary: mode === 'summary' ? summaryText : undefined,
    } satisfies CompactionTelemetryInfo);
    return mode;
  }

  /**
   * 调用模型生成摘要文本。失败（模型错误/中止/空产出）返回 null，
   * 由调用方降级硬截断——摘要失败不影响主流程。
   */
  private async summarizeMessages(
    inputText: string,
    sessionKey: string,
    traceId: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    const prompt = this._compaction?.prompt ?? DEFAULT_COMPACTION_PROMPT;
    const context: Context = {
      systemPrompt: prompt,
      messages: [{ role: 'user', content: inputText, timestamp: Date.now() }],
    };

    const startedAt = Date.now();
    let text = '';
    let usage: Usage | undefined;
    let failed = false;
    try {
      for await (const event of this._streamFn(this._model, context, { signal })) {
        if (event.type === 'text_delta') {
          text += event.delta;
        } else if (event.type === 'error') {
          failed = true;
          usage = event.message.usage;
          break;
        } else if (event.type === 'done') {
          usage = event.message.usage;
          if (event.message.stopReason === 'error') failed = true;
          // 非流式式产出兜底：done 前无 text_delta 时从消息体取文本
          if (!text) text = extractText(event.message.content);
          break;
        }
      }
    } catch {
      return null; // 摘要异常（网络/中止等）：降级截断
    }
    if (failed || !text.trim()) return null;

    // 摘要调用也计入 onModelCall（成本对账）：独立 span，stream=false
    await this.emitTelemetry('onModelCall', {
      traceId,
      spanId: newSpanId(),
      sessionKey,
      modelId: this._model.id,
      attempts: 1,
      inputTokens: usage?.input ?? estimateTextTokens(inputText),
      outputTokens: usage?.output ?? estimateTextTokens(text),
      durationMs: Date.now() - startedAt,
      stream: false,
    });
    return text;
  }

  /** 构造 compactionSummary 消息（内部扩展 role，发出前经 buildContext 转 user） */
  private createCompactionSummaryMessage(text: string): Message {
    return {
      role: 'compactionSummary',
      content: text,
      timestamp: Date.now(),
    } as unknown as Message;
  }

  /**
   * 统一模型调用埋点生成器：run()（streamModel）与 stream()（runLoopStream）两路径共用。
   * 职责：模型调用计时、spanId、attempts 累计、onRetry 转发、onModelCall 上报
   * （含 tokens / cost / errorClass / ttft）。
   */
  private async *streamModelEvents(
    compilation: Compilation,
    signal: AbortSignal,
    stream: boolean,
  ): AsyncGenerator<StreamEvent> {
    const sessionKey = this.resolveSessionKey(compilation.request);
    const modelStartedAt = Date.now();
    const spanId = newSpanId();
    let attempts = 1; // 含首次调用
    let ttftAt: number | undefined;
    let lastAssistant: AssistantMessage | undefined;

    const options: StreamOptions = { signal };
    if (this._thinkingLevel !== 'off' && this._model.reasoning) {
      options.reasoning = this._thinkingLevel;
    }
    // provider 内部 retry() 真正退避时回调：累计 attempts + 转发 onRetry 事件
    options.onRetryAttempt = (info) => {
      attempts += 1;
      void this.emitTelemetry('onRetry', {
        traceId: compilation.traceId,
        spanId, // P2：重试明细关联到本模型调用 span
        provider: this._model.provider,
        modelId: this._model.id,
        attempt: info.attempt,
        errorClass: classifyError(info.error),
        status: statusOfRetryError(info.error),
        delayMs: info.delayMs,
        willRetry: true,
      });
    };

    try {
      for await (const event of this._streamFn(this._model, this.buildContext(compilation.messages), options)) {
        if (stream && event.type === 'text_delta' && ttftAt === undefined) {
          ttftAt = Date.now();
        }
        if (event.type === 'done' || event.type === 'error') {
          lastAssistant = event.message;
        }
        yield event;
      }
    } finally {
      const assistant = lastAssistant;
      const errorClass = assistant?.errorMessage
        ? (errorClassFromMessage(assistant.errorMessage) as ErrorClass | undefined) ?? 'unknown'
        : undefined;
      await this.emitTelemetry('onModelCall', {
        traceId: compilation.traceId,
        spanId,
        sessionKey,
        modelId: this._model.id,
        attempts,
        inputTokens: assistant?.usage?.input ?? 0,
        outputTokens: assistant?.usage?.output ?? 0,
        cacheRead: assistant?.usage?.cacheRead,
        cacheWrite: assistant?.usage?.cacheWrite,
        durationMs: Date.now() - modelStartedAt,
        stream,
        errorClass,
      });
      // 流式：记录首个模型调用的首 token 延迟（run 级 onRunEnd 读取）
      if (stream && ttftAt !== undefined && compilation.ttftMs === undefined) {
        compilation.ttftMs = ttftAt - modelStartedAt;
      }
    }
  }

  /**
   * 触发遥测回调。全可选、失败不阻断主流程。
   */
  private async emitTelemetry<E extends keyof Telemetry>(
    event: E,
    info: Parameters<NonNullable<Telemetry[E]>>[0],
  ): Promise<void> {
    const fn = this._telemetry?.[event];
    if (!fn) return;
    try {
      await Promise.resolve((fn as (arg: unknown) => unknown)(info));
    } catch (err) {
      // 遥测失败不应影响主流程
      console.warn(`[aipack] telemetry "${String(event)}" 上报失败:`, err);
    }
  }

  /** traceId 生成：优先用注入的生成器（测试可确定性） */
  private newTraceId(): string {
    return this._traceIdGenerator ? this._traceIdGenerator() : newTraceId();
  }

  /** 组装并上报 run 级完成事件（_run/_stream 内部统一调用） */
  private async emitRunEnd(
    request: Request,
    sessionKey: string,
    compilation: Compilation,
    result: Result,
    queuedMs: number,
    activeStartedAt: number,
  ): Promise<void> {
    const activeMs = Date.now() - activeStartedAt;
    await this.emitTelemetry('onRunEnd', {
      traceId: compilation.traceId,
      sessionKey,
      // 请求未显式指定 model 时补实际模型（模型排行按 run 级 requests 统计，缺省会落入 'unknown'）
      request: request.model ? request : { ...request, model: this._model.id },
      durationMs: activeMs + queuedMs,
      activeMs,
      queuedMs,
      turnCount: compilation.turnCount ?? 0,
      result,
      success: result.success,
      errorClass: this.runErrorClass(compilation),
      tokens: {
        input: result.usage.input ?? 0,
        output: result.usage.output ?? 0,
        cacheRead: result.usage.cacheRead,
        cacheWrite: result.usage.cacheWrite,
      },
      ttftMs: compilation.ttftMs,
    });
  }

  /** run 级错误分类：terminate → 'terminated'；否则只看最后一条 assistant 消息（与 buildResult 的 result.success 同口径） */
  private runErrorClass(compilation: Compilation): ErrorClass | undefined {
    if (compilation.terminateReason) return 'terminated';
    const messages = compilation.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant') {
        // 最后一条 assistant 无 errorMessage → run 成功（早期轮次失败已被后续轮次恢复，不判错误）
        if (!(m as AssistantMessage).errorMessage) return undefined;
        const cls = errorClassFromMessage((m as AssistantMessage).errorMessage!);
        return (cls as ErrorClass | undefined) ?? 'unknown';
      }
    }
    return undefined;
  }

  private buildResult(compilation: Compilation): Result {
    const messages = compilation.messages;
    let content = '';
    let stopReason = 'completed';
    let error: string | undefined;
    const toolsUsed: string[] = [];
    const usage: Record<string, number> = {};

    for (const msg of messages) {
      if (msg.role === 'assistant') {
        const assistant = msg as AssistantMessage;
        content = extractText(assistant.content);
        stopReason = assistant.stopReason ?? 'completed';
        error = assistant.errorMessage;
        if (assistant.usage) {
          usage.input = (usage.input ?? 0) + assistant.usage.input;
          usage.output = (usage.output ?? 0) + assistant.usage.output;
          usage.total = (usage.total ?? 0) + assistant.usage.total;
          if (assistant.usage.cacheRead) usage.cacheRead = (usage.cacheRead ?? 0) + assistant.usage.cacheRead;
          if (assistant.usage.cacheWrite) usage.cacheWrite = (usage.cacheWrite ?? 0) + assistant.usage.cacheWrite;
        }
      }
      if (msg.role === 'toolResult') {
        const toolMsg = msg as ToolResultMessage;
        if (!toolsUsed.includes(toolMsg.toolName)) {
          toolsUsed.push(toolMsg.toolName);
        }
      }
    }

    // 填充资源快照（此前 Result.resources 永远 undefined）
    const resources = messagesToResources(messages);

    const builder = new ResultBuilder()
      .content(content)
      .toolsUsed(toolsUsed)
      .usage(usage)
      .stopReason(stopReason)
      .error(error)
      .resources(resources)
      .metadata('traceId', compilation.traceId);

    // beforeToolCall/afterToolCall 请求终止：覆盖 stopReason 并记录原因
    if (compilation.terminateReason) {
      builder.stopReason('terminated').metadata('terminateReason', compilation.terminateReason);
    }

    // 回合上限耗尽：调用方据此区分"正常完成"与"被截断"（模型仍想调用工具）
    if (compilation.maxTurnsExhausted) {
      builder.stopReason('max_turns').metadata('maxTurns', true);
    }

    return builder.build();
  }

  private streamEventToChunk(event: StreamEvent): ResultChunk | null {
    switch (event.type) {
      case 'text_delta':
        return { type: 'text', content: event.delta };
      case 'thinking_delta':
        return { type: 'thinking', content: event.delta };
      case 'error':
        // 模型调用错误（无 API Key / 鉴权失败 / 网络错误 / HTTP 4xx-5xx 等）
        // 以 error 事件流入，errorMessage 已由 stream-openai/anthropic 填好。
        return {
          type: 'error',
          content: event.message.errorMessage || '模型调用出错',
        };
      default:
        return null;
    }
  }

  // ─── 便捷方法 ───────────────────────────────────────────────────

  /** 终止指定会话的运行（默认会话；会话不存在为 no-op） */
  abort(sessionKey?: string): void {
    this._sessions.get(sessionKey ?? this._sessionKey)?.abortController?.abort();
  }

  /** 检查指定会话是否正在运行（默认会话；会话不存在返回 false） */
  isBusy(sessionKey?: string): boolean {
    return this._sessions.get(sessionKey ?? this._sessionKey)?.isStreaming ?? false;
  }

  /** 等待指定会话空闲（默认会话；基于 promise，无轮询） */
  async waitForIdle(sessionKey?: string, timeoutMs?: number): Promise<void> {
    const session = this._sessions.get(sessionKey ?? this._sessionKey);
    if (!session || !session.isStreaming) return;

    if (timeoutMs === undefined) {
      await new Promise<void>(resolve => {
        session.idleResolvers.push(resolve);
      });
      return;
    }

    // 带超时等待：超时 reject 并把自己从等待队列移除，避免 markIdle 唤醒残留 resolver
    await new Promise<void>((resolve, reject) => {
      const resolver = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const i = session.idleResolvers.indexOf(resolver);
        if (i >= 0) session.idleResolvers.splice(i, 1);
        reject(new Error(
          `[Runtime] waitForIdle 超时（${timeoutMs}ms）: ${sessionKey ?? 'default'}`,
        ));
      }, timeoutMs);
      session.idleResolvers.push(resolver);
    });
  }

  /** 清除指定会话消息（仅内存；下次 run 会从存储恢复） */
  clearSession(sessionKey?: string): void {
    const session = this._sessions.get(sessionKey ?? this._sessionKey);
    if (!session) return;
    session.messages = [];
    session.hydrated = false;
  }

  /** 删除指定会话（内存 + 存储），返回是否删除成功 */
  async deleteSession(sessionKey?: string): Promise<boolean> {
    const key = sessionKey ?? this._sessionKey;
    const session = this._sessions.get(key);
    // 等待在途任务完成后再清理
    if (session) {
      await session.queue;
      this._sessions.delete(key);
    }
    if (!this._sessionStorage) return true;
    const storage = this._sessionStorage;
    if (!storage.withLock) return storage.delete(key);
    // 删除同样持存储锁，避免与另一进程的写入竞争
    return storage.withLock(key, () => storage.delete(key));
  }
}

// ─── 工厂函数 ─────────────────────────────────────────────────────

export function createRuntime(options?: RuntimeOptions): Runtime {
  return AgentRuntime.create(options);
}
