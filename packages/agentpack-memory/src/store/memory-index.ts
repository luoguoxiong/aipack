/**
 * 内存索引：维护 entries 集合 + BM25 倒排索引，供两个 store 复用。
 *
 * 职责：get / list / count / search / add / remove。
 * 不负责持久化（由具体 store 处理）。
 */

import { BM25Index, BM25Retriever } from '../retrieval/bm25';
import { VectorIndex } from '../retrieval/vector-index';
import { tokenize } from '../retrieval/tokenizer';
import type { MemoryEntry, MemorySearchResult, MemoryStats } from '../types';

/** updatedAt 降序比较器 */
function byUpdatedAtDesc(a: MemoryEntry, b: MemoryEntry): number {
  return b.updatedAt - a.updatedAt;
}

export class MemoryIndex {
  private entries = new Map<string, MemoryEntry>();
  private index = new BM25Index();
  /** 独立向量索引：保证向量召回不被 BM25 候选池封顶 */
  private vectors = new VectorIndex();
  private retriever = new BM25Retriever(this.index, this.entries);

  /** 共享底层索引与条目表，返回一个 BM25Retriever（与 store 实时同步） */
  getRetriever(): BM25Retriever {
    return this.retriever;
  }

  get(id: string): MemoryEntry | null {
    return this.entries.get(id) ?? null;
  }

  /** 全部条目（updatedAt 降序） */
  all(): MemoryEntry[] {
    return [...this.entries.values()].sort(byUpdatedAtDesc);
  }

  list(limit?: number): MemoryEntry[] {
    const all = this.all();
    return limit != null ? all.slice(0, limit) : all;
  }

  count(): number {
    return this.entries.size;
  }

  /** 索引内容 = content + concepts（提升概念命中） */
  add(entry: MemoryEntry): void {
    this.entries.set(entry.id, entry);
    const tokens = tokenize(`${entry.content} ${entry.concepts.join(' ')}`);
    this.index.add(entry.id, tokens);
    // 向量索引同步：有 embedding 则加入，否则移除（避免残留旧向量）
    if (entry.embedding && entry.embedding.length > 0) {
      this.vectors.add(entry.id, entry.embedding);
    } else {
      this.vectors.remove(entry.id);
    }
  }

  remove(id: string): boolean {
    if (!this.entries.has(id)) return false;
    this.index.remove(id);
    this.vectors.remove(id);
    this.entries.delete(id);
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.index.clear();
    this.vectors.clear();
  }

  async search(query: string, limit?: number): Promise<MemorySearchResult[]> {
    return this.retriever.search(query, limit ?? 5);
  }

  async searchVectors(queryVec: number[], limit?: number): Promise<MemorySearchResult[]> {
    const hits = this.vectors.search(queryVec, limit ?? 5);
    const results: MemorySearchResult[] = [];
    for (const { id, score } of hits) {
      const entry = this.entries.get(id);
      if (entry) results.push({ entry, score, matchedBy: 'embedding' as const });
    }
    return results;
  }

  /** 统计快照 */
  stats(): MemoryStats {
    const bySource = { capture: 0, tool: 0, consolidation: 0 } as MemoryStats['bySource'];
    let avgConfidence = 0;
    let recallTotal = 0;
    let lastRecalledAt: number | undefined;
    for (const e of this.entries.values()) {
      if (bySource[e.source] == null) bySource[e.source] = 0;
      bySource[e.source] += 1;
      avgConfidence += e.confidence;
      recallTotal += e.recallCount;
      if (e.lastRecalledAt != null && (lastRecalledAt == null || e.lastRecalledAt > lastRecalledAt)) {
        lastRecalledAt = e.lastRecalledAt;
      }
    }
    const count = this.entries.size;
    return {
      count,
      embeddingCount: this.vectors.size,
      bySource,
      avgConfidence: count > 0 ? avgConfidence / count : 0,
      recallTotal,
      lastRecalledAt,
    };
  }
}
