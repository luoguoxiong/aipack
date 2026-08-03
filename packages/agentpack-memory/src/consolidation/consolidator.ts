/**
 * 合并器：去重 / 合并相似记忆 + 修剪过期与低置信度。
 *
 * 参考 agentmemory 的 consolidate 阶段：
 *   - 用每条记忆的 content 作为 query 检索相似记忆（混合检索）。
 *   - 相似度 >= 阈值则合并为一条（content 取较长、concepts 并集、置信度累加截断）。
 *   - 删除被合并项，更新幸存项。
 *   - 修剪过期 / 低置信度记忆；超过 maxMemories 时淘汰置信度最低的。
 */

import type { HybridRetriever } from '../retrieval/hybrid-retriever';
import type {
  ConsolidateOptions,
  ConsolidatorLike,
  MemoryEntry,
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
  const confidence = Math.min(1, a.confidence + b.confidence + 0.1);
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
    meta: { ...(older.meta ?? {}), ...(newer.meta ?? {}) },
  };
}

export interface ConsolidatorOptions {
  similarityThreshold?: number;
}

export class Consolidator implements ConsolidatorLike {
  private store: MemoryStore;
  private retriever: HybridRetriever;
  private similarityThreshold: number;

  constructor(store: MemoryStore, retriever: HybridRetriever, options: ConsolidatorOptions = {}) {
    this.store = store;
    this.retriever = retriever;
    this.similarityThreshold = options.similarityThreshold ?? 0.85;
  }

  async run(
    options: ConsolidateOptions = {},
  ): Promise<{ merged: number; pruned: number }> {
    const threshold = options.similarityThreshold ?? this.similarityThreshold;
    const all = await this.store.list();
    const processed = new Set<string>();
    let merged = 0;

    // 按 updatedAt 降序处理（list 已是降序），优先保留较新的幸存者
    for (const entry of all) {
      if (processed.has(entry.id)) continue;

      // 用该记忆 content 作为 query 检索相似记忆
      let results: Awaited<ReturnType<HybridRetriever['search']>> = [];
      try {
        results = await this.retriever.search(entry.content, 10);
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

      // 合并所有相似项到当前 entry（作为幸存者）
      let survivor = entry;
      for (const r of similar) {
        survivor = mergeTwo(survivor, r.entry);
        await this.store.delete(r.entry.id);
        processed.add(r.entry.id);
        merged++;
      }
      await this.store.save({
        id: survivor.id,
        content: survivor.content,
        concepts: survivor.concepts,
        confidence: survivor.confidence,
        source: 'consolidation',
        sessionKey: survivor.sessionKey,
        embedding: survivor.embedding,
        recallCount: survivor.recallCount,
      });
      processed.add(survivor.id);
    }

    // 修剪过期 / 低置信度
    let pruned = 0;
    try {
      pruned += await this.store.prune({
        maxAgeMs: options.maxAgeMs,
        minConfidence: options.minConfidence ?? 0.1,
      });
    } catch {
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

    return { merged, pruned };
  }
}
