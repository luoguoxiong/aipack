/**
 * 模型回合执行器（从 AgentRuntime 拆出）：
 * - 统一模型调用埋点生成器（计时 / spanId / attempts / onRetry 转发 / onModelCall）
 * - 单回合模型调用 + 上下文溢出自动恢复闭环（截断后同回合重试）
 * - buildContext：会话消息 → provider Context（内部扩展 role 转 user）
 */

import type {
  Model,
  Tool,
  StreamFn,
  Message,
  AssistantMessage,
  Context,
  Request,
  ResultChunk,
  Compilation,
  StreamOptions,
  StreamEvent,
  ThinkingLevel,
} from '../core';
import { extractText, createEmptyUsage } from '../core';
import { classifyError, isContextOverflow } from '../ai';
import {
  OVERFLOW_RECOVERY_LIMIT,
  COMPACTION_USER_PREFIX,
  STATE_SNAPSHOT_USER_PREFIX,
  statusOfRetryError,
  errorClassFromMessage,
  newSpanId,
  streamEventToChunk,
} from './shared';
import type { RuntimeTelemetry } from './telemetry';
import type { ErrorClass } from '../telemetry';
import type { ContextCompactor } from './compactor';

export interface ModelTurnDeps {
  telemetry: RuntimeTelemetry;
  compactor: ContextCompactor;
  hooks: import('../core').RuntimeHooks;
  getModel: () => Model;
  getStreamFn: () => StreamFn;
  getSystemPrompt: () => string;
  getThinkingLevel: () => ThinkingLevel;
  getTools: () => Map<string, Tool>;
  resolveSessionKey: (request: Request) => string;
}

export class ModelTurnRunner {
  constructor(private readonly _d: ModelTurnDeps) {}

  async streamModel(
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

  /** 空的 assistant 消息（流异常中断无 done/error 事件时的兜底） */
  private emptyAssistantMessage(): AssistantMessage {
    const model = this._d.getModel();
    return {
      role: 'assistant',
      content: [],
      stopReason: 'stop',
      usage: createEmptyUsage(),
      model: model.id,
      provider: model.provider,
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
  async *modelTurnWithRecovery(
    compilation: Compilation,
    signal: AbortSignal,
    sessionKey: string,
    stream: boolean,
  ): AsyncGenerator<ResultChunk, AssistantMessage | null> {
    const model = this._d.getModel();
    const contextWindow = model.contextWindow;
    const maxTokens = model.maxTokens;
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
          const chunk = streamEventToChunk(event);
          if (chunk) yield chunk;
          assistant = msg;
        } else {
          const chunk = streamEventToChunk(event);
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
          if (await this._d.compactor.recoverFromOverflow(compilation, recoveries, sessionKey, signal)) {
            const reason =
              thinkingOnly ? 'thinking 耗尽' : outputFull ? 'output 打满' : final.stopReason;
            console.warn(
              `[Runtime] 上下文溢出（${reason}），已压缩历史并同回合重试（${recoveries}/${OVERFLOW_RECOVERY_LIMIT}）`,
            );
            await this._d.telemetry.emit('onRetry', {
              traceId: compilation.traceId,
              provider: model.provider,
              modelId: model.id,
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
        await this._d.compactor.recoverFromOverflow(compilation, 1, sessionKey, signal);
        console.warn('[Runtime] 检测到静默上下文溢出（usage 超窗），已压缩历史消息');
      }

      return final;
    }
  }

  /**
   * 统一模型调用埋点生成器：run()（streamModel）与 stream()（runLoopStream）两路径共用。
   * 职责：模型调用计时、spanId、attempts 累计、onRetry 转发、onModelCall 上报
   * （含 tokens / cost / errorClass / ttft）。
   */
  async *streamModelEvents(
    compilation: Compilation,
    signal: AbortSignal,
    stream: boolean,
  ): AsyncGenerator<StreamEvent> {
    const model = this._d.getModel();
    const sessionKey = this._d.resolveSessionKey(compilation.request);
    const modelStartedAt = Date.now();
    const spanId = newSpanId();
    let attempts = 1; // 含首次调用
    let ttftAt: number | undefined;
    let lastAssistant: AssistantMessage | undefined;

    const options: StreamOptions = { signal };
    if (this._d.getThinkingLevel() !== 'off' && model.reasoning) {
      options.reasoning = this._d.getThinkingLevel();
    }
    // provider 内部 retry() 真正退避时回调：累计 attempts + 转发 onRetry 事件
    options.onRetryAttempt = (info) => {
      attempts += 1;
      void this._d.telemetry.emit('onRetry', {
        traceId: compilation.traceId,
        spanId, // P2：重试明细关联到本模型调用 span
        provider: model.provider,
        modelId: model.id,
        attempt: info.attempt,
        errorClass: classifyError(info.error),
        status: statusOfRetryError(info.error),
        delayMs: info.delayMs,
        willRetry: true,
      });
    };

    try {
      // beforeModelCall：插件可在此改写最终 Context（如 skills 目录注入 / 工具附加）
      const context = await this._d.hooks.beforeModelCall.promise(
        this.buildContext(compilation.messages),
      );
      for await (const event of this._d.getStreamFn()(model, context, options)) {
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
      await this._d.telemetry.emit('onModelCall', {
        traceId: compilation.traceId,
        spanId,
        sessionKey,
        modelId: model.id,
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

  buildContext(messages: Message[]): Context {
    const tools = Array.from(this._d.getTools().values());
    return {
      systemPrompt: this._d.getSystemPrompt(),
      // compactionSummary / stateSnapshot 为内部扩展 role，provider 适配层
      // 仅支持 user/assistant/toolResult，发出前统一转为带标注的 user 消息
      messages: messages
        .filter(m => m.role !== 'system')
        .map(m => {
          const role = (m as { role: string }).role;
          if (role === 'compactionSummary') return this.compactionSummaryToUser(m);
          if (role === 'stateSnapshot') return this.stateSnapshotToUser(m);
          return m;
        }),
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

  /** stateSnapshot 消息 → user 消息（所有 provider 均兼容 user role） */
  private stateSnapshotToUser(msg: Message): Message {
    const text = typeof msg.content === 'string' ? msg.content : extractText(msg.content);
    return {
      role: 'user',
      content: `${STATE_SNAPSHOT_USER_PREFIX}\n${text}`,
      timestamp: msg.timestamp,
    } as Message;
  }
}
