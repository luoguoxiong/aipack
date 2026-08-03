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
} from '../core';
import {
  ExtensionManager,
  createPipeline,
  createTaskGraph,
  ResultBuilder,
  createRequest,
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
  TextContent,
  Usage,
  Context,
  StreamOptions,
  StreamEvent,
  ThinkingLevel,
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
import { messagesToResources, resourcesToMessages } from '../context-resource';

// ─── 会话状态 ─────────────────────────────────────────────────────

interface SessionState {
  messages: Message[];
  tools: Tool[];
  isStreaming: boolean;
  abortController: AbortController | null;
  createdAt: string;   // 会话首次创建时间，持久化时保留
}

// ─── KobotRuntime: Runtime 接口的独立实现 ─────────────────────────

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

  private _sessions: Map<string, SessionState> = new Map();
  private _sessionStorage: SessionStorage | undefined;
  private _hydrated: Set<string> = new Set();  // 已从存储恢复的会话

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
    this._thinkingLevel = 'off';
    this._sessionStorage = options.sessionStorage;

    // 注册初始工具
    if (options.tools) {
      for (const tool of options.tools) {
        this._globalTools.set(tool.name, tool);
      }
    }

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
      sessionKey: 'runtime',
      shared: new Map(),
    };
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
    this._globalTools.set(tool.name, tool);
    return this;
  }

  registerTools(tools: Tool[]): this {
    for (const tool of tools) {
      this._globalTools.set(tool.name, tool);
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

  getMessages(sessionKey: string = 'default'): Message[] {
    return this.getSession(sessionKey).messages;
  }

  // ─── 核心运行逻辑 ───────────────────────────────────────────────

  async run(request: Request): Promise<Result> {
    // 1. 触发 beforeInitialize / afterInitialize
    await this._hooks.beforeInitialize.promise(request);
    await this._hooks.afterInitialize.promise(request);

    // 2. beforeRun（waterfall，可修改请求）
    const finalRequest = await this._hooks.beforeRun.promise(request);

    // 3. 会话持久化：从存储恢复历史消息
    await this.hydrateSession(finalRequest.sessionKey);

    // 4. 创建编译上下文
    const compilation = this.createCompilation(finalRequest);

    // 5. 添加用户消息
    const userMessage: UserMessage = {
      role: 'user',
      content: finalRequest.message,
      timestamp: Date.now(),
    };
    compilation.messages.push(userMessage);

    // 6. 运行对话循环
    try {
      await this.runLoop(compilation, finalRequest);

      // 7. 构建结果
      const result = this.buildResult(compilation);

      // 8. 触发 beforeEmit / afterEmit
      await this._hooks.beforeEmit.promise(result);
      await this._hooks.afterEmit.promise(result);

      // 9. 触发 done
      await this._hooks.done.promise(result);

      compilation.completed = true;
      return result;
    } catch (err) {
      const error = err as Error;

      await this._hooks.failed.promise(error, finalRequest);

      return new ResultBuilder()
        .error(error.message)
        .build();
    } finally {
      // 10. 每轮结束后整体保存会话（失败不影响运行结果）
      try {
        await this.persistSession(finalRequest.sessionKey);
      } catch {
        // 忽略持久化错误，运行结果已返回
      }
    }
  }

  async *stream(request: Request): AsyncGenerator<ResultChunk> {
    // 1. 钩子
    await this._hooks.beforeInitialize.promise(request);
    await this._hooks.afterInitialize.promise(request);
    const finalRequest = await this._hooks.beforeRun.promise(request);

    // 2. 会话持久化：从存储恢复历史消息
    await this.hydrateSession(finalRequest.sessionKey);

    // 3. 创建编译上下文
    const compilation = this.createCompilation(finalRequest);

    // 4. 添加用户消息
    compilation.messages.push({
      role: 'user',
      content: finalRequest.message,
      timestamp: Date.now(),
    } as UserMessage);

    // 5. 流式对话循环
    try {
      for await (const chunk of this.runLoopStream(compilation, finalRequest)) {
        yield chunk;
      }

      // 6. 构建并触发结果钩子
      const result = this.buildResult(compilation);
      await this._hooks.beforeEmit.promise(result);
      await this._hooks.afterEmit.promise(result);
      await this._hooks.done.promise(result);

      yield { type: 'done' };
    } catch (err) {
      const error = err as Error;
      await this._hooks.failed.promise(error, finalRequest);
      yield { type: 'error', content: error.message };
      yield { type: 'done' };
    } finally {
      // 7. 每轮结束后整体保存会话（失败不影响运行结果）
      try {
        await this.persistSession(finalRequest.sessionKey);
      } catch {
        // 忽略持久化错误，流式结果已产出
      }
    }
  }

  createCompilation(request: Request): Compilation {
    const session = this.getSession(request.sessionKey);

    return {
      request,
      graph: createTaskGraph(),
      pipeline: this._pipeline,
      resources: [],
      messages: session.messages,
      completed: false,
    };
  }

  async close(): Promise<void> {
    this._sessions.clear();
    this._hydrated.clear();
    this._extensions.clear();
    this._pipeline.clear();
  }

  // ─── 对话循环（同步） ───────────────────────────────────────────

  private async runLoop(compilation: Compilation, request: Request): Promise<void> {
    const session = this.getSession(request.sessionKey);
    session.isStreaming = true;
    session.abortController = new AbortController();

    try {
      let maxTurns = 200;

      while (maxTurns-- > 0) {
        // 1. Pipeline 转换上下文（原地替换，保持 session 引用）
        await this.transformMessages(compilation);

        // 2. beforeTransform / afterTransform 钩子
        // (消息级转换通过 Pipeline 完成)

        // 3. 构建 LLM 上下文
        const context = this.buildContext(compilation.messages);

        // 4. 调用模型
        const assistantMessage = await this.streamModel(
          context,
          session.abortController.signal,
        );

        compilation.messages.push(assistantMessage);

        // 5. 检查工具调用
        const toolCalls = extractToolCalls(assistantMessage.content);

        if (toolCalls.length === 0) {
          break;  // 无工具调用，结束循环
        }

        // 6. 执行工具
        for (const toolCall of toolCalls) {
          const result = await this.executeTool(
            toolCall,
            session.abortController.signal,
          );

          const toolResultMsg: ToolResultMessage = {
            role: 'toolResult',
            content: result.content,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            isError: !!(result.details && typeof result.details === 'object' && 'error' in result.details),
            timestamp: Date.now(),
          };

          compilation.messages.push(toolResultMsg);
        }

        // 7. 检查终止
        if (toolCalls.every(tc => {
          const result = this.findToolResult(compilation.messages, tc.id);
          return result?.details && typeof result.details === 'object' && 'terminate' in result.details && result.details.terminate;
        })) {
          break;
        }
      }
    } finally {
      session.isStreaming = false;
      session.abortController = null;
    }
  }

  // ─── 对话循环（流式） ───────────────────────────────────────────

  private async *runLoopStream(
    compilation: Compilation,
    request: Request,
  ): AsyncGenerator<ResultChunk> {
    const session = this.getSession(request.sessionKey);
    session.isStreaming = true;
    session.abortController = new AbortController();

    try {
      let maxTurns = 200;

      while (maxTurns-- > 0) {
        // 1. Pipeline 转换（原地替换，保持 session 引用）
        await this.transformMessages(compilation);

        // 2. 构建上下文
        const context = this.buildContext(compilation.messages);

        // 3. 流式调用模型
        let assistantMessage: AssistantMessage | null = null;

        for await (const event of this._streamFn(this._model, context, {
          signal: session.abortController.signal,
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

          const result = await this.executeTool(
            toolCall,
            session.abortController.signal,
          );

          yield {
            type: 'tool_end',
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            isError: !!(result.details && typeof result.details === 'object' && 'error' in result.details),
          };

          const toolResultMsg: ToolResultMessage = {
            role: 'toolResult',
            content: result.content,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            isError: !!(result.details && typeof result.details === 'object' && 'error' in result.details),
            timestamp: Date.now(),
          };

          compilation.messages.push(toolResultMsg);
        }
      }
    } finally {
      session.isStreaming = false;
      session.abortController = null;
    }
  }

  // ─── 内部方法 ───────────────────────────────────────────────────

  private getSession(sessionKey: string): SessionState {
    if (!this._sessions.has(sessionKey)) {
      this._sessions.set(sessionKey, {
        messages: [],
        tools: Array.from(this._globalTools.values()),
        isStreaming: false,
        abortController: null,
        createdAt: new Date().toISOString(),
      });
    }
    return this._sessions.get(sessionKey)!;
  }

  // ─── 会话持久化 ─────────────────────────────────────────────────

  /** 从存储懒加载会话（每个会话 key 仅恢复一次） */
  private async hydrateSession(sessionKey: string): Promise<void> {
    if (!this._sessionStorage || this._hydrated.has(sessionKey)) return;
    this._hydrated.add(sessionKey);

    const stored = await this._sessionStorage.load(sessionKey);
    if (!stored) return;

    const session = this.getSession(sessionKey);
    session.messages = stored.messages;
    session.createdAt = stored.createdAt;
  }

  /** 每轮 run/stream 结束后整体保存会话 */
  private async persistSession(sessionKey: string): Promise<void> {
    if (!this._sessionStorage) return;
    const session = this._sessions.get(sessionKey);
    if (!session) return;

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

  /** 汇总所有 assistant 消息的 token 用量 */
  private sumUsage(messages: Message[]): Usage {
    const usage = createEmptyUsage();
    for (const msg of messages) {
      if (msg.role === 'assistant') {
        const u = (msg as AssistantMessage).usage;
        if (u) {
          usage.input += u.input;
          usage.output += u.output;
          usage.total += u.total;
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
        sessionKey: compilation.request.sessionKey,
        turn: compilation.messages.length,
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

  private async executeTool(
    toolCall: ToolCallContent,
    signal?: AbortSignal,
  ): Promise<import('../core').ToolResult> {
    const tool = this._globalTools.get(toolCall.name);

    if (!tool) {
      return {
        content: [createTextContent(`Tool "${toolCall.name}" not found`)],
        details: { error: `Tool "${toolCall.name}" not found` },
      };
    }

    try {
      let args: unknown = toolCall.arguments;
      if (tool.prepareArguments) {
        args = tool.prepareArguments(toolCall.arguments);
      }
      return await tool.execute(toolCall.id, args, signal);
    } catch (err) {
      return {
        content: [createTextContent((err as Error).message)],
        details: { error: (err as Error).message },
      };
    }
  }

  private findToolResult(
    messages: Message[],
    toolCallId: string,
  ): import('../core').ToolResult | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'toolResult' && (msg as ToolResultMessage).toolCallId === toolCallId) {
        return {
          content: msg.content as ContentBlock[],
          details: {},
        };
      }
    }
    return null;
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
        }
      }
      if (msg.role === 'toolResult') {
        const toolMsg = msg as ToolResultMessage;
        if (!toolsUsed.includes(toolMsg.toolName)) {
          toolsUsed.push(toolMsg.toolName);
        }
      }
    }

    return new ResultBuilder()
      .content(content)
      .toolsUsed(toolsUsed)
      .usage(usage)
      .stopReason(stopReason)
      .error(error)
      .build();
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
        // 此前默认分支返回 null，导致错误被静默吞掉、前端只收到 done。
        return {
          type: 'error',
          content: event.message.errorMessage || '模型调用出错',
        };
      default:
        return null;
    }
  }

  // ─── 便捷方法 ───────────────────────────────────────────────────

  /** 终止指定会话的运行 */
  abort(sessionKey: string = 'default'): void {
    const session = this._sessions.get(sessionKey);
    session?.abortController?.abort();
  }

  /** 检查会话是否正在运行 */
  isBusy(sessionKey: string = 'default'): boolean {
    return this.getSession(sessionKey).isStreaming;
  }

  /** 等待会话空闲 */
  async waitForIdle(sessionKey: string = 'default'): Promise<void> {
    while (this.isBusy(sessionKey)) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  /** 清除会话消息（仅内存；下次 run 会从存储恢复该会话） */
  clearSession(sessionKey: string = 'default'): void {
    this._sessions.delete(sessionKey);
    this._hydrated.delete(sessionKey);
  }

  /** 列出所有会话 key（内存 + 存储） */
  async listSessions(): Promise<string[]> {
    const memoryKeys = Array.from(this._sessions.keys());
    const storedKeys = this._sessionStorage ? await this._sessionStorage.list() : [];
    return [...new Set([...storedKeys, ...memoryKeys])];
  }

  /** 删除指定会话（内存 + 存储），返回是否删除成功 */
  async deleteSession(sessionKey: string = 'default'): Promise<boolean> {
    this._sessions.delete(sessionKey);
    this._hydrated.delete(sessionKey);
    if (this._sessionStorage) {
      return this._sessionStorage.delete(sessionKey);
    }
    return true;
  }
}

// ─── 工厂函数 ─────────────────────────────────────────────────────

export function createRuntime(options?: RuntimeOptions): Runtime {
  return AgentRuntime.create(options);
}
