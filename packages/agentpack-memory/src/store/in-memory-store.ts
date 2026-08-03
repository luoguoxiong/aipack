/**
 * 内存记忆存储（测试与临时场景）。
 * 进程退出即丢失，无持久化。API 与 FileMemoryStore 完全一致。
 */

import { MemoryIndex } from './memory-index';
import type {
  ConsolidateOptions,
  ConsolidatorLike,
  Embedder,
  MemoryEntry,
  MemorySaveInput,
  MemorySearchResult,
  MemoryStore,
} from '../types';

/** 生成短随机 id */
function genId(): string {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 填充默认字段（id / createdAt / updatedAt / recallCount） */
export function finalizeEntry(entry: MemorySaveInput, now: number = Date.now()): MemoryEntry {
  return {
    ...entry,
    id: entry.id ?? genId(),
    createdAt: entry.createdAt ?? now,
    updatedAt: now,
    recallCount: entry.recallCount ?? 0,
  };
}

export interface InMemoryStoreOptions {
  /** 可选向量化器：配置后 save 时自动计算 embedding（供混合检索） */
  embedder?: Embedder;
}

export class InMemoryStore implements MemoryStore {
  private idx = new MemoryIndex();
  private consolidator?: ConsolidatorLike;
  private embedder?: Embedder;

  constructor(options: InMemoryStoreOptions = {}) {
    this.embedder = options.embedder;
  }

  setConsolidator(consolidator: ConsolidatorLike): void {
    this.consolidator = consolidator;
  }

  async save(entry: MemorySaveInput): Promise<MemoryEntry> {
    // 若已存在同 id，保留 createdAt 与 embedding
    const prev = entry.id ? this.idx.get(entry.id) : null;
    const finalized = finalizeEntry(
      {
        ...entry,
        embedding: entry.embedding ?? prev?.embedding,
        createdAt: prev?.createdAt ?? entry.createdAt,
      },
      Date.now(),
    );
    // 配置了 embedder 且无既有向量时，计算 embedding
    if (this.embedder && !finalized.embedding) {
      try {
        finalized.embedding = await this.embedder.embed(finalized.content);
      } catch {
        // embedding 失败不阻断保存（退化为纯 BM25 检索）
      }
    }
    this.idx.add(finalized);
    return finalized;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    return this.idx.get(id);
  }

  async delete(id: string): Promise<boolean> {
    return this.idx.remove(id);
  }

  async list(limit?: number): Promise<MemoryEntry[]> {
    return this.idx.list(limit);
  }

  async search(query: string, limit?: number): Promise<MemorySearchResult[]> {
    return this.idx.search(query, limit);
  }

  async touchRecall(id: string, at: number = Date.now()): Promise<void> {
    const e = this.idx.get(id);
    if (!e) return;
    e.lastRecalledAt = at;
    e.recallCount += 1;
    e.updatedAt = Date.now();
    this.idx.add(e);
  }

  async consolidate(
    options?: ConsolidateOptions,
  ): Promise<{ merged: number; pruned: number }> {
    if (!this.consolidator) return { merged: 0, pruned: 0 };
    return this.consolidator.run(options);
  }

  async prune(options?: {
    maxAgeMs?: number;
    minConfidence?: number;
  }): Promise<number> {
    const now = Date.now();
    const maxAge = options?.maxAgeMs;
    const minConf = options?.minConfidence ?? 0;
    let removed = 0;
    for (const e of this.idx.all()) {
      const expired = maxAge != null && now - e.updatedAt > maxAge;
      const lowConf = e.confidence < minConf;
      if (expired || lowConf) {
        if (this.idx.remove(e.id)) removed++;
      }
    }
    return removed;
  }

  async count(): Promise<number> {
    return this.idx.count();
  }
}

export function createInMemoryStore(): MemoryStore {
  return new InMemoryStore();
}
