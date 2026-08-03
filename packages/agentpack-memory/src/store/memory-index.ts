/**
 * 内存索引：维护 entries 集合 + BM25 倒排索引，供两个 store 复用。
 *
 * 职责：get / list / count / search / add / remove。
 * 不负责持久化（由具体 store 处理）。
 */

import { BM25Index, BM25Retriever } from '../retrieval/bm25';
import { tokenize } from '../retrieval/tokenizer';
import type { MemoryEntry, MemorySearchResult } from '../types';

/** updatedAt 降序比较器 */
function byUpdatedAtDesc(a: MemoryEntry, b: MemoryEntry): number {
  return b.updatedAt - a.updatedAt;
}

export class MemoryIndex {
  private entries = new Map<string, MemoryEntry>();
  private index = new BM25Index();
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
  }

  remove(id: string): boolean {
    if (!this.entries.has(id)) return false;
    this.index.remove(id);
    this.entries.delete(id);
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.index.clear();
  }

  async search(query: string, limit?: number): Promise<MemorySearchResult[]> {
    return this.retriever.search(query, limit ?? 5);
  }
}
