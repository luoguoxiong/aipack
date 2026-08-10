/**
 * 合并器：去重 / 合并相似记忆 + 修剪过期与低置信度。
 *
 * 参考 agentmemory 的 consolidate 阶段：
 *   - 候选窗口 = 自上次合并以来内容有更新的条目（增量合并，避免每次对全库 N 条
 *     逐一检索的 O(N²) 塌陷；首次合并或跨进程重启后为全量）。
 *   - 对每个候选：以其 content 作为 query 检索相似记忆，相似度 >= 阈值则合并。
 *   - 合并：content 取较长、concepts 并集、置信度取 max + 小奖励（避免旧「累加」
 *     使置信度快速饱和到 1.0 而丧失排序/修剪信号）。
 *   - 修剪过期 / 低置信度；超过 maxMemories 时淘汰置信度最低的。
 */

import type { HybridRetriever } from '../retrieval/hybrid-retriever';
import type {
  ConsolidateOptions,
  ConsolidatorLike,
  MemoryEntry,
  MemoryEventSink,
  MemoryStore,
} from '../types';

/** 合并两条记忆为一条（保留 newer 的 id） */
function mergeTwo(a: MemoryEntry, b: MemoryEntry): MemoryEntry {
  const newer = a.updatedAt >= b.updatedAt ? a : b;
  const older = newer === a ? b : a;
  // content 取较长者（信息量更大），若相近则取较新
  const content =
    newer.content.length >= older.content.length ? newer.content : older.content;
  const concepts = [...new Set([...a.concepts, ...b.concepts])];
  // 置信度取 max + 0.05 小奖励（截断到 1）：累加会让记忆快速顶到 1.0，
  // 使 confidence 作为 pruning/排序信号失效
  const confidence = Math.min(1, Math.max(a.confidence, b.confidence) + 0.05);
  const lastRecalledAt = [a.lastRecalledAt, b.lastRecalledAt]
    .filter((t): t is number => t != null)
    .sort()
    .pop();

  return {
    id: newer.id,
    content,
    concepts,
    confidence,
    source: 'consolidation',
    sessionKey: newer.sessionKey,
    createdAt: Math.min(a.createdAt, b.createdAt),
    updatedAt: Date.now(),
    lastRecalledAt,
    recallCount: a.recallCount + b.recallCount,
    embedding: newer.embedding ?? older.embedding,
    expiresAt: newer.expiresAt ?? older.expiresAt,
    meta: { ...(older.meta ?? {}), ...(newer.meta ?? {}) },
  };
}

export interface ConsolidatorOptions {
  similarityThreshold?: number;
  /** 事件接收器（合并结果/失败） */
  onEvent?: MemoryEventSink;
}

export class Consolidator implements ConsolidatorLike {
  private store: MemoryStore;
  private retriever: HybridRetriever;
  private similarityThreshold: number;
  private onEvent?: MemoryEventSink;

  constructor(
    store: MemoryStore,
    retriever: HybridRetriever,
    options: ConsolidatorOptions = {},
  ) {
    this.store = store;
    this.retriever = retriever;
    this.similarityThreshold = options.similarityThreshold ?? 0.85;
    this.onEvent = options.onEvent;
  }

  async run(
    options: ConsolidateOptions = {},
  ): Promise<{ merged: number; pruned: number }> {
    const start = Date.now();
    const threshold = options.similarityThreshold ?? this.similarityThreshold;
    const all = await this.store.list();

    // 增量候选：仅处理上次合并后内容有更新的条目（touchRecall 不再更新 updatedAt，
    // 因此 updatedAt 稳定表示内容修改时间；首次/跨进程重启 lastConsolidatedAt 为空 → 全量）
    const stats = await this.store.stats();
    const since = stats.lastConsolidatedAt;
    const candidates = (since == null ? all : all.filter((e) => e.updatedAt >= since)).sort(
      // 显式按 updatedAt 降序（新条目先处理，可吸收旧的相似条目）；
      // 同毫秒写入时以 createdAt 决胜，保证处理顺序确定
      (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt,
    );

    const processed = new Set<string>();
    let merged = 0;

    // 按 updatedAt 降序处理（list 已是降序），优先保留较新的幸存者
    for (const entry of candidates) {
      if (processed.has(entry.id)) continue;

      // 用该记忆 content 作为 query 检索相似记忆。
      // raw 模式：保留原始 BM25/cosine 分数，使 similarityThreshold 按「绝对
      // 相似度」判定 —— min-max 归一化会把次优分数压到 0，导致阈值形同虚设。
      let results: Awaited<ReturnType<HybridRetriever['search']>> = [];
      try {
        results = await this.retriever.search(entry.content, 10, { raw: true });
      } catch {
        continue;
      }

      const similar = results.filter(
        (r) =>
          r.entry.id !== entry.id &&
          !processed.has(r.entry.id) &&
          r.score >= threshold,
      );

      if (similar.length === 0) {
        processed.add(entry.id);
        continue;
      }

      // 原子性修复：先合并内存中的幸存者并 save（原子写入），成功后再 delete
      // 相似项。旧实现「先逐条 delete 再 save」，中途失败即丢失已删记忆。
      let survivor = entry;
      for (const r of similar) {
        survivor = mergeTwo(survivor, r.entry);
        processed.add(r.entry.id);
      }
      await this.store.save({
        id: survivor.id,
        content: survivor.content,
        concepts: survivor.concepts,
        confidence: survivor.confidence,
        source: 'consolidation',
        sessionKey: survivor.sessionKey,
        createdAt: survivor.createdAt,
        embedding: survivor.embedding,
        expiresAt: survivor.expiresAt,
        recallCount: survivor.recallCount,
      });
      merged += similar.length;
      for (const r of similar) {
        try {
          await this.store.delete(r.entry.id);
        } catch (err) {
          // delete 失败留下重复条目，可被下一轮合并吸收；不中断整体
          this.onEvent?.({ type: 'consolidate:failed', error: `delete:${(err as Error).message}` });
        }
      }
      processed.add(survivor.id);
    }

    // 修剪过期 / 低置信度
    let pruned = 0;
    try {
      pruned += await this.store.prune({
        maxAgeMs: options.maxAgeMs,
        minConfidence: options.minConfidence ?? 0.1,
      });
    } catch (err) {
      this.onEvent?.({ type: 'consolidate:failed', error: (err as Error).message });
      // 修剪失败忽略
    }

    // 数量上限：淘汰置信度最低、最旧的
    if (options.maxMemories != null) {
      const after = await this.store.list();
      if (after.length > options.maxMemories) {
        const sorted = [...after].sort(
          (a, b) => b.confidence - a.confidence || b.updatedAt - a.updatedAt,
        );
        const toRemove = sorted.slice(options.maxMemories);
        for (const e of toRemove) {
          const ok = await this.store.delete(e.id);
          if (ok) pruned++;
        }
      }
    }

    // 记录合并完成时间（驱动下一轮增量窗口）
    this.store.markConsolidated();

    const ms = Date.now() - start;
    this.onEvent?.({ type: 'consolidate', merged, pruned, ms });
    return { merged, pruned };
  }
}
