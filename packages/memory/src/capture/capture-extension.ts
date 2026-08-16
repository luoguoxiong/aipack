/**
 * 记忆捕获扩展。
 *
 * 在 Runtime 生命周期中「静默」捕获每轮对话要点并存为可检索记忆。
 * 参考 agentmemory 的 capture 阶段。
 *
 * 机制：
 *   - beforeRun：暂存本轮用户消息（单会话，Runtime 持有唯一 sessionKey）。
 *   - done：与本轮结果配对捕获。sessionKey 来自 ExtensionContext（Runtime 级），
 *     与结果配对写入记忆库。框架保证同一 Runtime 的 run 串行执行，无并发错配。
 *   - failed：本轮失败不捕获（仅成功回合入库），无残留状态需清理。
 *
 * 每 consolidateEvery 次捕获触发一次合并。
 */

import { BaseExtension } from '@aipack-ai/agent';
import type { RuntimeHooks, ExtensionContext, Request, Result } from '@aipack-ai/agent';
import type { MemoryEventSink, MemoryStore } from '../types';
import type { SummarizeFn } from '../types';
import { runCaptureExtractor } from './extractor';

export interface CaptureOptions {
  enabled?: boolean;
  /** 可选 LLM 摘要函数（默认关闭，零 token） */
  summarizeFn?: SummarizeFn;
  /** 最小用户消息长度（小于则跳过捕获），默认 12 */
  minLength?: number;
  /** 概念数上限，默认 8 */
  maxConcepts?: number;
  /** content 最大字符数，默认 2000 */
  maxContentChars?: number;
  /** 每 N 次捕获触发一次 consolidate（0=不自动，默认 0） */
  consolidateEvery?: number;
  /** 捕获记忆 TTL（ms），过期后 prune 时清理 */
  ttlMs?: number;
  /** 事件接收器（捕获失败等） */
  onEvent?: MemoryEventSink;
}

export class MemoryCaptureExtension extends BaseExtension {
  readonly name = 'memory-capture';

  private store: MemoryStore;
  private summarizeFn?: SummarizeFn;
  private minLength: number;
  private maxConcepts: number;
  private maxContentChars: number;
  private consolidateEvery: number;
  private ttlMs?: number;
  private onEvent?: MemoryEventSink;

  /** 本轮待捕获的用户消息（sessionKey -> 请求信息） */
  private pending = new Map<string, { message: string }>();

  /** 捕获计数（用于触发 consolidate） */
  private captureCount = 0;

  constructor(store: MemoryStore, options: CaptureOptions = {}) {
    super();
    this.store = store;
    this.summarizeFn = options.summarizeFn;
    this.minLength = options.minLength ?? 12;
    this.maxConcepts = options.maxConcepts ?? 8;
    this.maxContentChars = options.maxContentChars ?? 2000;
    this.consolidateEvery = options.consolidateEvery ?? 0;
    this.ttlMs = options.ttlMs;
    this.onEvent = options.onEvent;
  }

  protected setup(hooks: RuntimeHooks, context: ExtensionContext): void {
    const sessionKey = context.sessionKey;
    // beforeRun：暂存用户消息（不改请求）
    hooks.beforeRun.tapPromise('memory-capture', async (request: Request) => {
      try {
        this.pending.set(sessionKey, { message: request.message });
      } catch {
        // 忽略 stash 失败
      }
      return request;
    });

    // done：与本轮结果配对捕获（单会话模式，sessionKey 由 Runtime 持有）
    hooks.done.tapPromise('memory-capture', async (result: Result, _request?: Request) => {
      await this.captureFromResult(result, sessionKey);
    });
  }

  private async captureFromResult(result: Result, sessionKey?: string): Promise<void> {
    if (!sessionKey) return;

    // 先取后删（避免 delete 后 get 返回 undefined）
    const stashed = this.pending.get(sessionKey);
    this.pending.delete(sessionKey);
    if (!stashed) return;

    // 仅捕获成功回合
    if (!result.success) return;
    const userMessage = stashed.message;
    const assistantContent = result.content ?? '';
    if (!userMessage || userMessage.trim().length < this.minLength) return;
    if (!assistantContent || !assistantContent.trim()) return;

    try {
      const extracted = await runCaptureExtractor(
        {
          userMessage,
          assistantContent,
          toolsUsed: result.toolsUsed ?? [],
          summarizeFn: this.summarizeFn,
        },
        { maxConcepts: this.maxConcepts, maxChars: this.maxContentChars },
      );

      await this.store.save({
        content: extracted.content,
        concepts: extracted.concepts,
        confidence: extracted.summarized ? 0.8 : 0.6,
        source: 'capture',
        sessionKey,
        ttlMs: this.ttlMs,
      });

      this.captureCount += 1;

      // 周期性合并
      if (this.consolidateEvery > 0 && this.captureCount % this.consolidateEvery === 0) {
        try {
          await this.store.consolidate();
        } catch (err) {
          this.onEvent?.({
            type: 'consolidate:failed',
            error: (err as Error).message,
          });
          // 合并失败不影响捕获
        }
      }
    } catch (err) {
      // 捕获失败不影响运行结果
      this.onEvent?.({ type: 'capture:failed', sessionKey, error: (err as Error).message });
    }
  }
}
