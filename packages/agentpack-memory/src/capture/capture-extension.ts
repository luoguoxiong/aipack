/**
 * 记忆捕获扩展。
 *
 * 在 Runtime 生命周期中「静默」捕获每轮对话要点并存为可检索记忆。
 * 参考 agentmemory 的 capture 阶段。
 *
 * 机制（详见方案决策 B）：
 *   - beforeRun（waterfall）：stash {message, timestamp} 入 pending Map，sessionKey 入 FIFO 队列。
 *     done 钩子只收 Result、不含 sessionKey（框架限制），故用 FIFO 队列配对。
 *   - done：从队列取出 sessionKey，组装 MemoryEntry 存盘；每 consolidateEvery 次触发合并。
 *
 * 典型顺序 awaited run 下 FIFO 配对精确；并发多会话下为 best-effort。
 */

import { BaseExtension } from 'agentpack';
import type { RuntimeHooks, ExtensionContext, Request, Result } from 'agentpack';
import type { MemoryStore } from '../types';
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
}

interface PendingCapture {
  message: string;
  timestamp: number;
}

export class MemoryCaptureExtension extends BaseExtension {
  readonly name = 'memory-capture';

  private store: MemoryStore;
  private summarizeFn?: SummarizeFn;
  private minLength: number;
  private maxConcepts: number;
  private maxContentChars: number;
  private consolidateEvery: number;

  /** pending 捕获（sessionKey -> 请求信息） */
  private pending = new Map<string, PendingCapture>();
  /** FIFO 队列：与 done 钩子配对（done 不携带 sessionKey） */
  private queue: string[] = [];
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
  }

  protected setup(hooks: RuntimeHooks, _context: ExtensionContext): void {
    // beforeRun：stash 请求信息（不改请求）
    hooks.beforeRun.tapPromise('memory-capture', async (request: Request) => {
      try {
        this.pending.set(request.sessionKey, {
          message: request.message,
          timestamp: Date.now(),
        });
        this.queue.push(request.sessionKey);
      } catch {
        // 忽略 stash 失败
      }
      return request;
    });

    // done：组装并保存记忆
    hooks.done.tapPromise('memory-capture', async (result: Result) => {
      await this.captureFromResult(result);
    });
  }

  private async captureFromResult(result: Result): Promise<void> {
    const sessionKey = this.queue.shift();
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
      });

      this.captureCount += 1;

      // 周期性合并
      if (this.consolidateEvery > 0 && this.captureCount % this.consolidateEvery === 0) {
        try {
          await this.store.consolidate();
        } catch {
          // 合并失败不影响捕获
        }
      }
    } catch (err) {
      // 捕获失败不影响运行结果
      console.warn(`[agentpack-memory] capture failed: ${(err as Error).message}`);
    }
  }
}
