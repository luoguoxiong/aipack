import type { TSchema } from '@sinclair/typebox';
import type {
  Model,
  Context,
  Message,
  AssistantMessage,
  UserMessage,
  ToolResultMessage,
  StreamEvent,
  SimpleStreamOptions,
  StreamResult,
  ToolCallContent,
  TextContent,
  ContentBlock,
  Tool,
} from '../ai/types';
import type {
  AgentMessage,
  AgentEvent,
  AgentTool,
  AgentState,
  AgentContext,
  AgentOptions,
  AgentInitialState,
  AgentToolResult,
  AgentEventListener,
  ThinkingLevel,
  ToolExecutionStartEvent,
  ToolExecutionEndEvent,
} from './types';

// ─── 默认的 convertToLlm ───────────────────────────────────────────

function stripThinkingBlocks(msg: Message): Message {
  if (msg.role === 'assistant' && Array.isArray(msg.content)) {
    return {
      ...msg,
      content: msg.content.filter((b) => b.type !== 'thinking'),
    };
  }
  return msg;
}

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  const result: Message[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      // 将系统消息转换为用户消息以兼容不同提供商
      const sysMsg = m as { role: 'system'; content: string };
      const content = typeof sysMsg.content === 'string' ? sysMsg.content : '';
      result.push({ role: 'user', content, timestamp: (m as { timestamp?: number }).timestamp ?? Date.now() });
    } else if (m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult') {
      result.push(stripThinkingBlocks(m as Message));
    }
  }
  return result;
}

// ─── 构建 LLM 上下文 ──────────────────────────────────────────────

function buildContext(
  systemPrompt: string,
  llmMessages: Message[],
  tools: AgentTool[],
): Context {
  const contextTools: Tool[] | undefined = tools.length > 0
    ? tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
    : undefined;

  return {
    systemPrompt,
    messages: llmMessages,
    tools: contextTools,
  };
}

// ─── 构建 StreamOptions ───────────────────────────────────────────

function buildStreamOptions(
  state: AgentState,
  options: AgentOptions,
): SimpleStreamOptions {
  const streamOpts: SimpleStreamOptions = {};

  if (state.thinkingLevel !== 'off' && state.model.reasoning) {
    streamOpts.reasoning = state.thinkingLevel;
  }

  if (options.sessionId) {
    streamOpts.sessionId = options.sessionId;
  }

  if (options.getApiKey) {
    // 我们将在流调用中异步解析 API 密钥
    // 目前让流函数从环境变量中解析
  }

  return streamOpts;
}

// ─── Agent 类 ─────────────────────────────────────────────────────

export class Agent {
  // ── 公开状态 ──
  private _systemPrompt: string;
  private _model: Model;
  private _thinkingLevel: ThinkingLevel;
  private _tools: AgentTool[];
  private _messages: AgentMessage[];
  private _isStreaming = false;
  private _streamingMessage: AgentMessage | undefined;
  private _pendingToolCalls = new Set<string>();
  private _errorMessage: string | undefined;

  // ── 配置 ──
  private streamFn: (model: Model, context: Context, options?: SimpleStreamOptions) => StreamResult;
  private convertToLlmFn: (messages: AgentMessage[]) => Message[];
  private transformContextFn?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  private _sessionId: string | undefined;
  private _toolExecution: 'parallel' | 'sequential';
  private beforeToolCallFn?: AgentOptions['beforeToolCall'];
  private afterToolCallFn?: AgentOptions['afterToolCall'];
  private thinkingBudgets?: Partial<Record<ThinkingLevel, number>>;
  private getApiKeyFn?: (provider: string) => Promise<string | undefined>;

  // ── 事件监听器 ──
  private listeners: AgentEventListener[] = [];

  // ── 中止控制器 ──
  private abortController: AbortController | null = null;

  constructor(options: AgentOptions) {
    this._systemPrompt = options.initialState.systemPrompt;
    this._model = options.initialState.model;
    this._thinkingLevel = options.initialState.thinkingLevel ?? 'off';
    this._tools = options.initialState.tools ?? [];
    this._messages = options.initialState.messages ?? [];

    this.streamFn = options.streamFn;
    this.convertToLlmFn = options.convertToLlm ?? defaultConvertToLlm;
    this.transformContextFn = options.transformContext;
    this._sessionId = options.sessionId;
    this._toolExecution = options.toolExecution ?? 'parallel';
    this.beforeToolCallFn = options.beforeToolCall;
    this.afterToolCallFn = options.afterToolCall;
    this.thinkingBudgets = options.thinkingBudgets;
    this.getApiKeyFn = options.getApiKey;
  }

  // ── 状态访问器 ──
  // 返回 agent 状态的实时视图。messages/tools 数组通过引用返回
  //（修改会影响状态）；赋值时复制数组。

  get state(): AgentState {
    const self = this;
    return {
      get systemPrompt() { return self._systemPrompt; },
      set systemPrompt(v: string) { self._systemPrompt = v; },
      get model() { return self._model; },
      set model(v: Model) { self._model = v; },
      get thinkingLevel() { return self._thinkingLevel; },
      set thinkingLevel(v: ThinkingLevel) { self._thinkingLevel = v; },
      get tools() { return self._tools; },
      set tools(v: AgentTool[]) { self._tools = [...v]; },
      get messages() { return self._messages; },
      set messages(v: AgentMessage[]) { self._messages = [...v]; },
      get isStreaming() { return self._isStreaming; },
      get streamingMessage() { return self._streamingMessage; },
      get pendingToolCalls() { return self._pendingToolCalls; },
      get errorMessage() { return self._errorMessage; },
    } as AgentState;
  }

  get sessionId(): string | undefined { return this._sessionId; }
  set sessionId(v: string | undefined) { this._sessionId = v; }

  get toolExecution(): 'parallel' | 'sequential' { return this._toolExecution; }
  set toolExecution(v: 'parallel' | 'sequential') { this._toolExecution = v; }

  // ── 事件订阅 ──

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private async emit(event: AgentEvent): Promise<void> {
    const signal = this.abortController?.signal;
    for (const listener of [...this.listeners]) {
      try {
        await listener(event, signal);
      } catch {
        // 监听器错误被忽略
      }
    }
  }

  // ── 提示输入 ──

  async prompt(message: string | AgentMessage): Promise<void> {
    const userMessage: AgentMessage = typeof message === 'string'
      ? { role: 'user', content: message, timestamp: Date.now() }
      : message;

    this._messages.push(userMessage);
    await this.runLoop();
  }

  // ── 从当前上下文继续 ──

  async continue(): Promise<void> {
    // 最后一条消息必须是 user 或 toolResult
    const last = this._messages[this._messages.length - 1];
    if (!last || (last.role !== 'user' && last.role !== 'toolResult')) {
      throw new Error('continue() requires the last message to be user or toolResult');
    }
    await this.runLoop(false);
  }

  // ── 主循环 ──

  private async runLoop(addUserMessageEvents = true): Promise<void> {
    if (this._isStreaming) {
      throw new Error('Agent is already streaming');
    }

    this._isStreaming = true;
    this._errorMessage = undefined;
    this.abortController = new AbortController();

    try {
      await this.emit({ type: 'agent_start' });

      // 发出用户消息事件（针对 prompt()，不是 continue()）
      if (addUserMessageEvents && this._messages.length > 0) {
        const lastMsg = this._messages[this._messages.length - 1];
        await this.emit({ type: 'message_start', message: lastMsg });
        await this.emit({ type: 'message_end', message: lastMsg });
      }

      // 对话循环
      let maxTurns = 200; // 安全限制
      while (maxTurns-- > 0) {
        await this.emit({ type: 'turn_start' });

        // 按需转换上下文
        let currentMessages = this._messages;
        if (this.transformContextFn) {
          currentMessages = await this.transformContextFn(this._messages, this.abortController.signal);
          this._messages = currentMessages;
        }

        // 转换为 LLM 格式
        const llmMessages = this.convertToLlmFn(currentMessages);

        // 构建上下文
        const context = buildContext(this._systemPrompt, llmMessages, this._tools);

        // 构建流选项
        const streamOptions = this.buildStreamOptions();

        // 流式获取 LLM 响应
        const assistantMessage = await this.streamAssistant(context, streamOptions);

        // 检查是否有工具调用
        const toolCalls = assistantMessage.content.filter(
          (b): b is ToolCallContent => b.type === 'toolCall',
        );

        if (toolCalls.length === 0) {
          // 没有工具调用——本轮结束
          await this.emit({
            type: 'turn_end',
            message: assistantMessage,
            toolResults: [],
          });
          break;
        }

        // 执行工具调用
        const toolResults = await this.executeTools(toolCalls);

        // 将 toolResult 消息添加到状态
        for (const { toolCall, result } of toolResults) {
          const toolResultMessage: AgentMessage = {
            role: 'toolResult',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: result.content,
            isError: !!(result.details && typeof result.details === 'object' && 'error' in result.details),
            timestamp: Date.now(),
          };
          this._messages.push(toolResultMessage);

          // 发出 toolResult 消息事件
          await this.emit({ type: 'message_start', message: toolResultMessage });
          await this.emit({ type: 'message_end', message: toolResultMessage });
        }

        // 本轮结束，附带工具结果
        await this.emit({
          type: 'turn_end',
          message: assistantMessage,
          toolResults: toolResults.map((r) => r.result),
        });

        // 检查是否所有工具都请求终止
        const allTerminated = toolResults.every((r) => r.result.terminate === true);
        if (allTerminated) {
          break;
        }
      }

      await this.emit({ type: 'agent_end', messages: this._messages });
    } catch (e) {
      this._errorMessage = (e as Error).message;
      // 即使出错也发出 agent_end 事件
      await this.emit({ type: 'agent_end', messages: this._messages });
    } finally {
      this._isStreaming = false;
      this._streamingMessage = undefined;
      this.abortController = null;
    }
  }

  // ── 流式获取助理消息 ──

  private async streamAssistant(
    context: Context,
    options: SimpleStreamOptions,
  ): Promise<AssistantMessage> {
    const stream = this.streamFn(this._model, context, options);

    let assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'stop',
      usage: { input: 0, output: 0, total: 0, cost: { input: 0, output: 0, total: 0 } },
      model: this._model.id,
      provider: this._model.provider,
    };

    this._streamingMessage = assistantMessage;

    // 发出 message_start 事件
    await this.emit({ type: 'message_start', message: assistantMessage });

    // 遍历流事件
    for await (const event of stream) {
      // 与流的局部消息共享 content 数组引用
      // 以便 message_update 事件携带实际正在构建的内容
      if (event.type === 'start') {
        assistantMessage.content = event.partial.content;
      }

      // 为每个流事件发出 message_update 事件
      await this.emit({
        type: 'message_update',
        message: assistantMessage,
        assistantMessageEvent: event,
      });

      if (event.type === 'done') {
        assistantMessage = event.message;
      } else if (event.type === 'error') {
        assistantMessage = event.error;
      }
    }

    // 发出 message_end 事件
    await this.emit({ type: 'message_end', message: assistantMessage });

    // 添加到消息列表
    this._messages.push(assistantMessage);
    this._streamingMessage = undefined;

    return assistantMessage;
  }

  // ── 执行工具 ──

  private async executeTools(
    toolCalls: ToolCallContent[],
  ): Promise<Array<{ toolCall: ToolCallContent; result: AgentToolResult }>> {
    const results: Array<{ toolCall: ToolCallContent; result: AgentToolResult }> = [];

    for (const toolCall of toolCalls) {
      this._pendingToolCalls.add(toolCall.id);

      // 发出 tool_execution_start 事件
      await this.emit({
        type: 'tool_execution_start',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        args: toolCall.arguments,
      });

      // 查找工具
      const tool = this._tools.find((t) => t.name === toolCall.name);
      let result: AgentToolResult = {
        content: [],
        details: {},
      };
      let isError = false;

      if (!tool) {
        result = {
          content: [{ type: 'text', text: `Tool "${toolCall.name}" not found` }],
          details: { error: `Tool "${toolCall.name}" not found` },
        };
        isError = true;
      } else {
        // 准备参数
        let args: unknown = toolCall.arguments;
        if (tool.prepareArguments) {
          try {
            args = tool.prepareArguments(toolCall.arguments);
          } catch {
            // 使用原始参数
          }
        }

        // 工具调用前钩子
        if (this.beforeToolCallFn) {
          const ctx: AgentContext = {
            systemPrompt: this._systemPrompt,
            messages: this._messages,
            tools: this._tools,
          };
          const hookResult = await this.beforeToolCallFn({
            toolCall,
            args,
            context: ctx,
          });
          if (hookResult?.block) {
            result = {
              content: [{ type: 'text', text: `Tool execution blocked: ${hookResult.reason ?? 'no reason'}` }],
              details: { error: hookResult.reason ?? 'blocked' },
            };
            isError = true;
          }
        }

        // 如果未被阻止则执行工具
        if (!isError) {
          try {
            result = await tool.execute(toolCall.id, args, this.abortController?.signal);

            // 工具调用后钩子
            if (this.afterToolCallFn) {
              const ctx: AgentContext = {
                systemPrompt: this._systemPrompt,
                messages: this._messages,
                tools: this._tools,
              };
              const hookResult = await this.afterToolCallFn({
                toolCall,
                result,
                isError: false,
                context: ctx,
              });
              if (hookResult?.terminate) {
                result = { ...result, terminate: true };
              }
              if (hookResult?.details !== undefined) {
                result = { ...result, details: hookResult.details };
              }
            }
          } catch (e) {
            result = {
              content: [{ type: 'text', text: (e as Error).message }],
              details: { error: (e as Error).message },
            };
            isError = true;
          }
        }
      }

      this._pendingToolCalls.delete(toolCall.id);

      // 发出 tool_execution_end 事件
      await this.emit({
        type: 'tool_execution_end',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result,
        isError,
        args: toolCall.arguments,
      });

      results.push({ toolCall, result });
    }

    return results;
  }

  // ── 构建流选项 ──

  private buildStreamOptions(): SimpleStreamOptions {
    const opts: SimpleStreamOptions = {};

    if (this.abortController) {
      opts.signal = this.abortController.signal;
    }

    if (this._thinkingLevel !== 'off' && this._model.reasoning) {
      opts.reasoning = this._thinkingLevel;
    }

    if (this._sessionId) {
      opts.sessionId = this._sessionId;
    }

    return opts;
  }

  // ── 控制方法 ──

  abort(): void {
    this.abortController?.abort();
  }

  async waitForIdle(): Promise<void> {
    if (!this._isStreaming) return;
    // 等待当前操作完成
    // 循环结束后 isStreaming 标志会被设置为 false
    while (this._isStreaming) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  reset(): void {
    this._messages = [];
    this._isStreaming = false;
    this._streamingMessage = undefined;
    this._pendingToolCalls.clear();
    this._errorMessage = undefined;
    this.abortController = null;
  }

  // ── 引导与追问（兼容性基本存根）──

  steer(_message: AgentMessage): void {
    // 基本实现：直接推入消息
    this._messages.push(_message);
  }

  followUp(_message: AgentMessage): void {
    this._messages.push(_message);
  }

  clearSteeringQueue(): void {}
  clearFollowUpQueue(): void {}
  clearAllQueues(): void {}
}

// ─── AgentHarness（兼容性存根）────────────────────────────────────

export class AgentHarness {
  agent: Agent;

  constructor(options: AgentOptions) {
    this.agent = new Agent(options);
  }

  get state(): AgentState {
    return this.agent.state;
  }

  subscribe(listener: AgentEventListener): () => void {
    return this.agent.subscribe(listener);
  }

  async prompt(message: string | AgentMessage): Promise<void> {
    return this.agent.prompt(message);
  }

  async continue(): Promise<void> {
    return this.agent.continue();
  }

  async waitForIdle(): Promise<void> {
    return this.agent.waitForIdle();
  }

  abort(): void {
    this.agent.abort();
  }

  reset(): void {
    this.agent.reset();
  }
}
