/**
 * 上下文压缩器（从 AgentRuntime 拆出，约 500 行压缩职责独立成模块）：
 * - 溢出恢复闭环（截断点计算 + 摘要优先/硬截断兜底 + 同回合重试配合）
 * - 阈值触发的内置摘要压缩（runLoop 每轮模型调用前检查，低频）
 * - compactionSummary 消息构造、摘要请求（复用模型通道，失败降级截断）
 */

import type {
  Model,
  StreamFn,
  Message,
  Context,
  Usage,
  Compilation,
  CompactionOptions,
} from '../core';
import { extractText } from '../core';
import type { CompactionTelemetryInfo } from '../telemetry';
import { ensureToolPairing } from '../transformer';
import {
  OVERFLOW_RECOVERY_LIMIT,
  COMPACTION_SUMMARY_BUDGET_RATIO,
  DEFAULT_COMPACTION_PROMPT,
  estimateMessageTokens,
  estimateTextTokens,
  messageToSummaryLine,
  newSpanId,
} from './shared';
import type { RuntimeTelemetry } from './telemetry';

export interface CompactorDeps {
  telemetry: RuntimeTelemetry;
  /** 模型（setModel 可变，须以 getter 注入） */
  getModel: () => Model;
  /** 流式函数（setStreamFn 可变，须以 getter 注入） */
  getStreamFn: () => StreamFn;
  contextBudgetRatio: number;
  compaction: CompactionOptions | undefined;
}

export class ContextCompactor {
  constructor(private readonly _d: CompactorDeps) {}

  /**
   * 计算溢出恢复的截断点：按 token 预算从最旧消息开始丢弃。
   *
   * 预算随恢复次数指数收紧（contextWindow × ratio × 0.5^recovery），且每次
   * 至少丢弃可丢弃部分的一半，保证重试规模必然小于上次溢出（token 估算
   * 偏小时也成立）。最后一条消息（当前请求/最新产出）始终保留。
   * 返回被压缩段的结束下标（messages[0..split) 为被压缩段）；0 = 已到
   * 最小集，单条请求即超窗，无法恢复。
   */
  computeOverflowSplit(messages: Message[], recovery: number): number {
    const contextWindow = this._d.getModel().contextWindow;
    if (!contextWindow || contextWindow <= 0) return 0;
    const target = Math.max(
      Math.floor(contextWindow * this._d.contextBudgetRatio * 0.5 ** recovery),
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
  async recoverFromOverflow(
    compilation: Compilation,
    recovery: number,
    sessionKey: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const messages = compilation.messages;
    const split = this.computeOverflowSplit(messages, recovery);
    if (split <= 0) return false;

    const useCompaction =
      !!this._d.compaction &&
      this._d.compaction.enabled !== false &&
      this._d.compaction.onOverflow !== false;
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
  async maybeCompactByThreshold(
    compilation: Compilation,
    sessionKey: string,
    signal: AbortSignal,
  ): Promise<void> {
    // 未配置 compaction = 保持旧行为（不压缩，溢出时硬截断兜底）
    if (!this._d.compaction || this._d.compaction.enabled === false) return;
    const contextWindow = this._d.getModel().contextWindow;
    if (!contextWindow || contextWindow <= 0) return;

    const messages = compilation.messages;
    const triggerTokens = Math.floor(
      contextWindow * (this._d.compaction?.triggerRatio ?? this._d.contextBudgetRatio),
    );

    let total = 0;
    for (const m of messages) total += estimateMessageTokens(m);
    if (total <= triggerTokens) return;

    // 从尾部累计保留最新消息，保留量为压缩目标的一半
    const split = this.computeKeepSplit(messages, contextWindow);

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
   * 保留段计算：从尾部累计保留最新消息，保留量为压缩目标（contextWindow ×
   * targetRatio）的一半。返回被压缩段的结束下标；messages[0..split) 为被压缩段。
   */
  computeKeepSplit(messages: Message[], contextWindow: number): number {
    const targetTokens = Math.floor(
      contextWindow * (this._d.compaction?.targetRatio ?? 0.5),
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
    return split;
  }

  /**
   * 执行压缩：messages[0..split) 为被压缩段，原地替换。
   *
   * 摘要成功 → 被压缩段替换为单条 compactionSummary 消息（资源层 pinned）；
   * 序列化超摘要预算或摘要调用失败 → 降级纯丢弃（旧行为）。两种路径均对
   * 保留段执行 ensureToolPairing（被压缩段边界可能截断工具配对）。上报
   * onCompaction 遥测。
   */
  async compactOrTruncate(
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

    const summaryEnabled = !!this._d.compaction && this._d.compaction.enabled !== false;
    if (summaryEnabled && compacted.length > 0) {
      const summaryBudget = Math.floor(
        this._d.getModel().contextWindow * COMPACTION_SUMMARY_BUDGET_RATIO,
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

    await this._d.telemetry.emit('onCompaction', {
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
  async summarizeMessages(
    inputText: string,
    sessionKey: string,
    traceId: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    const prompt = this._d.compaction?.prompt ?? DEFAULT_COMPACTION_PROMPT;
    const context: Context = {
      systemPrompt: prompt,
      messages: [{ role: 'user', content: inputText, timestamp: Date.now() }],
    };

    const startedAt = Date.now();
    let text = '';
    let usage: Usage | undefined;
    let failed = false;
    try {
      for await (const event of this._d.getStreamFn()(this._d.getModel(), context, { signal })) {
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
    await this._d.telemetry.emit('onModelCall', {
      traceId,
      spanId: newSpanId(),
      sessionKey,
      modelId: this._d.getModel().id,
      attempts: 1,
      inputTokens: usage?.input ?? estimateTextTokens(inputText),
      outputTokens: usage?.output ?? estimateTextTokens(text),
      durationMs: Date.now() - startedAt,
      stream: false,
    });
    return text;
  }

  /** 构造 compactionSummary 消息（内部扩展 role，发出前经 buildContext 转 user） */
  createCompactionSummaryMessage(text: string): Message {
    return {
      role: 'compactionSummary',
      content: text,
      timestamp: Date.now(),
    } as unknown as Message;
  }
}

export { OVERFLOW_RECOVERY_LIMIT };
