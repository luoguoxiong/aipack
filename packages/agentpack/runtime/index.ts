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
  Request,
  Result,
  ResultChunk,
  Pipeline,
  Extension,
  RuntimeHooks,
  ExtensionContext,
  ContextTransformer,
  ToolCallContext,
  BeforeToolCallDecision,
  AfterToolCallDecision,
} from '../core';
import {
  ExtensionManager,
  createPipeline,
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
import { validateRequest, normalizeRequest } from '../request';
import {
  messagesToResources,
  resourcesToMessages,
} from '../context-resource';

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
  private _pipeline: Pipeline;

  private _model: Model;
  private _streamFn: StreamFn;
  private _systemPrompt: string;
  private _thinkingLevel: ThinkingLevel;
  private _globalTools: Map<string, Tool> = new Map();

  private _session: SessionState;
  private _sessionKey: string;
  private _sessionStorage: SessionStorage | undefined;
  /** Extension 应用时的上下文（shared Map 供 ToolCallContext 引用） */
  private _extensionContext?: ExtensionContext;

  private _maxTurns: number;
  private _toolTimeoutMs: number;
  private _parallelToolCalls: boolean;
  private _contextBudgetRatio: number;

  private constructor(options: RuntimeOptions) {
    this._config = options.config ?? {};
    this._extensions = new ExtensionManager();
    this._hooks = this._extensions.getHooks();
    this._pipeline = options.pipeline ?? createPipeline();

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

    // 注册初始工具
    if (options.tools) {
      for (const tool of options.tools) {
        this._globalTools.set(tool.name, tool);
      }
    }

    this._sessionKey = options.sessionKey ?? 'default';
    this._session = {
      messages: [],
      isStreaming: false,
      abortController: null,
      createdAt: new Date().toISOString(),
      hydrated: false,
      queue: Promise.resolve(),
      idleResolvers: [],
    };

    // 注册转换器
    if (options.transformers) {
      this._pipeline.useAll(options.transformers);
    }
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
    this._pipeline.use(transformer);
    return this;
  }

  getMessages(): Message[] {
    // 返回深拷贝，避免外部直接修改会话内部状态
    const messages = this._session.messages;
    try {
      return structuredClone(messages);
    } catch {
      return JSON.parse(JSON.stringify(messages));
    }
  }

  // ─── 核心运行逻辑 ───────────────────────────────────────────────

  async run(request: Request): Promise<Result> {
    // 0. 校验请求
    const validation = validateRequest(request);
    if (!validation.valid) {
      return new ResultBuilder()
        .error(`请求校验失败: ${validation.errors.join('; ')}`)
        .build();
    }
    const finalRequest = normalizeRequest(request);

    // 1. 串行化：同一会话的请求依次执行
    const release = await this.acquire();

    try {
      return await this._run(finalRequest);
    } finally {
      release();
    }
  }

  async *stream(request: Request): AsyncGenerator<ResultChunk> {
    // 0. 校验请求
    const validation = validateRequest(request);
    if (!validation.valid) {
      yield { type: 'error', content: `请求校验失败: ${validation.errors.join('; ')}` };
      yield { type: 'done' };
      return;
    }
    const finalRequest = normalizeRequest(request);

    // 1. 串行化
    const release = await this.acquire();

    try {
      yield* this._stream(finalRequest);
    } finally {
      release();
    }
  }

  private async _run(request: Request): Promise<Result> {
    // 1. 触发 beforeInitialize / afterInitialize
    await this._hooks.beforeInitialize.promise(request);
    await this._hooks.afterInitialize.promise(request);

    // 2. beforeRun（waterfall，可修改请求）
    const finalRequest = await this._hooks.beforeRun.promise(request);

    // 3. 会话持久化：从存储恢复历史消息（ephemeral 跳过）
    if (!finalRequest.ephemeral) {
      await this.hydrateSession();
    }

    // 4. 创建编译上下文
    const compilation = this.createCompilation(finalRequest);

    // 5. 添加用户消息（含媒体附件）
    compilation.messages.push(this.buildUserMessage(finalRequest));

    // 6. 运行对话循环
    try {
      await this.runLoop(compilation, finalRequest);

      // 7. 构建结果
      const result = this.buildResult(compilation);

      // 8. 触发 beforeEmit / afterEmit
      await this._hooks.beforeEmit.promise(result);
      await this._hooks.afterEmit.promise(result);

      // 9. 触发 done（携带最终 Request，供钩子按会话配对）
      await this._hooks.done.promise(result, finalRequest);

      compilation.completed = true;
      return result;
    } catch (err) {
      const error = err as Error;
      // 非中止错误打印栈，便于线上排障（此前 catch 全部静默转 Result.error，丢栈）
      if (error?.name !== 'AbortError') {
        console.error('[Runtime] 运行失败:', error?.stack ?? error);
      }
      await this._hooks.failed.promise(error, finalRequest);

      return new ResultBuilder()
        .error(error.message)
        .build();
    } finally {
      // 10. 结束前最终保存会话（ephemeral 不持久化；失败不影响运行结果）
      await this.persistSessionSafe(finalRequest);
    }
  }

  private async *_stream(request: Request): AsyncGenerator<ResultChunk> {
    // 1. 钩子
    await this._hooks.beforeInitialize.promise(request);
    await this._hooks.afterInitialize.promise(request);
    const finalRequest = await this._hooks.beforeRun.promise(request);

    // 2. 会话持久化：从存储恢复历史消息（ephemeral 跳过）
    if (!finalRequest.ephemeral) {
      await this.hydrateSession();
    }

    // 3. 创建编译上下文
    const compilation = this.createCompilation(finalRequest);

    // 4. 添加用户消息（含媒体附件）
    compilation.messages.push(this.buildUserMessage(finalRequest));

    // 5. 流式对话循环
    try {
      for await (const chunk of this.runLoopStream(compilation, finalRequest)) {
        yield chunk;
      }

      // 6. 构建并触发结果钩子
      const result = this.buildResult(compilation);
      await this._hooks.beforeEmit.promise(result);
      await this._hooks.afterEmit.promise(result);
      await this._hooks.done.promise(result, finalRequest);

      yield { type: 'done' };
    } catch (err) {
      const error = err as Error;
      if (error?.name !== 'AbortError') {
        console.error('[Runtime] 流式运行失败:', error?.stack ?? error);
      }
      await this._hooks.failed.promise(error, finalRequest);
      yield { type: 'error', content: error.message };
      yield { type: 'done' };
    } finally {
      await this.persistSessionSafe(finalRequest);
    }
  }

  createCompilation(request: Request): Compilation {
    return {
      request,
      graph: createTaskGraph(),
      pipeline: this._pipeline,
      resources: [],
      messages: this._session.messages,
      completed: false,
    };
  }

  async close(): Promise<void> {
    // 等待当前会话的在途任务完成，再清理
    await Promise.allSettled([this._session.queue]);

    this._session.messages = [];
    this._session.hydrated = false;
    this._extensions.clear();
    this._pipeline.clear();
  }

  // ─── 对话循环（同步） ───────────────────────────────────────────

  private async runLoop(compilation: Compilation, request: Request): Promise<void> {
    const session = this._session;
    session.isStreaming = true;
    session.abortController = new AbortController();

    try {
      let maxTurns = this._maxTurns;

      while (maxTurns-- > 0) {
        // 1. Pipeline 转换上下文（原地替换，保持 session 引用）
        await this.transformMessages(compilation);

        // 2. 构建 LLM 上下文
        const context = this.buildContext(compilation.messages);

        // 3. 调用模型
        const assistantMessage = await this.streamModel(
          context,
          session.abortController!.signal,
        );

        compilation.messages.push(assistantMessage);
        // 3.1 实时持久化：assistant 回复完成即落盘（运行中可查看最新会话）
        await this.persistSessionSafe(request);

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
        await this.persistSessionSafe(request);
        // 5.2 beforeToolCall/afterToolCall 请求终止：停止循环
        if (outcome.terminate) {
          compilation.terminateReason = outcome.terminateReason ?? 'terminated';
          break;
        }
      }
    } finally {
      this.markIdle(session);
    }
  }

  // ─── 对话循环（流式） ───────────────────────────────────────────

  private async *runLoopStream(
    compilation: Compilation,
    request: Request,
  ): AsyncGenerator<ResultChunk> {
    const session = this._session;
    session.isStreaming = true;
    session.abortController = new AbortController();

    try {
      let maxTurns = this._maxTurns;

      while (maxTurns-- > 0) {
        // 1. Pipeline 转换（原地替换，保持 session 引用）
        await this.transformMessages(compilation);

        // 2. 构建上下文
        const context = this.buildContext(compilation.messages);

        // 3. 流式调用模型
        let assistantMessage: AssistantMessage | null = null;

        for await (const event of this._streamFn(this._model, context, {
          signal: session.abortController!.signal,
          reasoning: this._thinkingLevel !== 'off' ? this._thinkingLevel : undefined,
        })) {
          const chunk = this.streamEventToChunk(event);
          if (chunk) yield chunk;

          if (event.type === 'done') {
            assistantMessage = event.message;
          } else if (event.type === 'error') {
            assistantMessage = event.message;
          }
        }

        if (!assistantMessage) break;
        compilation.messages.push(assistantMessage);
        // 3.1 实时持久化：assistant 回复完成即落盘（运行中可查看最新会话）
        await this.persistSessionSafe(request);

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
        await this.persistSessionSafe(request);

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
    const outcome = await this.runTools(toolCalls, signal, compilation.request);
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
    const outcome = await this.runTools(toolCalls, signal, compilation.request);
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
  ): Promise<ToolExecutionOutcome> {
    const execute = (tc: ToolCallContent) => this.executeTool(tc, signal, request);

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

    const { signal: timedSignal, clear } = withTimeoutSignal(signal, this._toolTimeoutMs);
    try {
      let args: unknown = toolCall.arguments;
      if (tool.prepareArguments) {
        args = tool.prepareArguments(toolCall.arguments);
      }

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
      sessionKey: this._sessionKey,
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
  private async acquire(): Promise<() => void> {
    const session = this._session;
    let release!: () => void;
    const prev = session.queue;
    session.queue = new Promise<void>(resolve => {
      release = () => resolve();
    });
    await prev;
    return release;
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
  private async hydrateSession(): Promise<void> {
    if (!this._sessionStorage) return;
    const session = this._session;
    if (session.hydrated) return;
    session.hydrated = true;

    const stored = await this._sessionStorage.load(this._sessionKey);
    if (!stored) return;

    session.messages = stored.messages;
    session.createdAt = stored.createdAt;
  }

  /** 整体保存会话（ephemeral 跳过；失败不影响运行结果） */
  private async persistSession(): Promise<void> {
    if (!this._sessionStorage) return;
    const session = this._session;

    const stored: StoredSession = {
      key: this._sessionKey,
      version: SESSION_VERSION,
      messages: session.messages,
      model: this.deriveModel(session.messages),
      usage: this.sumUsage(session.messages),
      createdAt: session.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await this._sessionStorage.save(this._sessionKey, stored);
  }

  /**
   * 实时持久化当前会话：每轮 assistant 回复/工具结果完成后调用，
   * 让运行中的会话随时可被持久化数据观测到。ephemeral 跳过；
   * 存储失败仅告警，不影响对话循环继续。
   */
  private async persistSessionSafe(request: Request): Promise<void> {
    if (request.ephemeral || !this._sessionStorage) return;
    try {
      await this.persistSession();
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

  /** 汇总所有 assistant 消息的 token 用量（含 cache/cost） */
  private sumUsage(messages: Message[]): Usage {
    const usage = createEmptyUsage();
    usage.cost = { input: 0, output: 0, total: 0 };
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
          if (u.cost) {
            usage.cost!.input += u.cost.input ?? 0;
            usage.cost!.output += u.cost.output ?? 0;
            usage.cost!.total += u.cost.total ?? 0;
          }
        }
      }
    }
    return usage;
  }

  /** 通过 Pipeline 转换上下文（原地替换消息数组，保持与 session 的共享引用） */
  private async transformMessages(compilation: Compilation): Promise<void> {
    if (this._pipeline.isEmpty) {
      return;
    }

    const resources = messagesToResources(compilation.messages);

    const transformed = await this._pipeline.run(resources, {
      graph: compilation.graph,
      runtime: {
        sessionKey: this._sessionKey,
        turn: compilation.messages.length,
        contextWindow: this._model.contextWindow,
        maxTokens: this._model.maxTokens,
        contextBudgetRatio: this._contextBudgetRatio,
      },
    });

    const messages = resourcesToMessages(transformed);
    // 原地替换而非重新赋值：createCompilation 将 session.messages 按引用共享，
    // 重新赋值会导致后续 push 的 assistant/tool 消息脱离会话（持久化丢失）
    compilation.messages.splice(0, compilation.messages.length, ...messages);
  }

  private buildContext(messages: Message[]): Context {
    const tools = Array.from(this._globalTools.values());
    return {
      systemPrompt: this._systemPrompt,
      messages: messages.filter(m => m.role !== 'system'),
      tools: tools.length > 0 ? tools : undefined,
    };
  }

  private async streamModel(
    context: Context,
    signal: AbortSignal,
  ): Promise<AssistantMessage> {
    let assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'stop',
      usage: createEmptyUsage(),
      model: this._model.id,
      provider: this._model.provider,
      timestamp: Date.now(),
    };

    const options: StreamOptions = { signal };
    if (this._thinkingLevel !== 'off' && this._model.reasoning) {
      options.reasoning = this._thinkingLevel;
    }

    for await (const event of this._streamFn(this._model, context, options)) {
      if (event.type === 'start') {
        assistantMessage.content = event.partial.content;
      } else if (event.type === 'done') {
        assistantMessage = event.message;
      } else if (event.type === 'error') {
        assistantMessage = event.message;
      }
    }

    return assistantMessage;
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
      .resources(resources);

    // beforeToolCall/afterToolCall 请求终止：覆盖 stopReason 并记录原因
    if (compilation.terminateReason) {
      builder.stopReason('terminated').metadata('terminateReason', compilation.terminateReason);
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

  /** 终止当前会话的运行 */
  abort(): void {
    this._session.abortController?.abort();
  }

  /** 检查当前会话是否正在运行 */
  isBusy(): boolean {
    return this._session.isStreaming;
  }

  /** 等待当前会话空闲（基于 promise，无轮询） */
  async waitForIdle(): Promise<void> {
    const session = this._session;
    if (!session.isStreaming) return;
    await new Promise<void>(resolve => {
      session.idleResolvers.push(resolve);
    });
  }

  /** 清除当前会话消息（仅内存；下次 run 会从存储恢复） */
  clearSession(): void {
    this._session.messages = [];
    this._session.hydrated = false;
  }

  /** 删除当前会话（内存 + 存储），返回是否删除成功 */
  async deleteSession(): Promise<boolean> {
    // 等待在途任务完成后再清理
    await this._session.queue;
    // 重置内存会话状态（保留结构，避免后续调用崩溃）
    this._session.messages = [];
    this._session.hydrated = false;
    this._session.isStreaming = false;
    this._session.abortController = null;
    if (this._sessionStorage) {
      return this._sessionStorage.delete(this._sessionKey);
    }
    return true;
  }
}

// ─── 工厂函数 ─────────────────────────────────────────────────────

export function createRuntime(options?: RuntimeOptions): Runtime {
  return AgentRuntime.create(options);
}
