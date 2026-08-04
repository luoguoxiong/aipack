/**
 * 内存记忆存储（测试与临时场景）。
 * 进程退出即丢失，无持久化。API 与 FileMemoryStore 完全一致。
 *
 * 并发安全：同 id 的写操作（save/delete/touchRecall）经 keyed mutex 串行，
 * 避免 embedder 异步计算期间的 read-modify-write 竞态；跨 id 互不阻塞。
 */

import { MemoryIndex } from './memory-index';
import { KeyedMutex } from '../utils/keyed-mutex';
import type {
  ConsolidateOptions,
  ConsolidatorLike,
  Embedder,
  MemoryEntry,
  MemoryEventSink,
  MemorySaveInput,
  MemorySearchResult,
  MemoryStats,
  MemoryStore,
} from '../types';

/** 生成短随机 id */
function genId(): string {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 填充默认字段（id / createdAt / updatedAt / recallCount / expiresAt） */
export function finalizeEntry(entry: MemorySaveInput, now: number = Date.now()): MemoryEntry {
  const createdAt = entry.createdAt ?? now;
  const { ttlMs, ...rest } = entry;
  return {
    ...rest,
    id: entry.id ?? genId(),
    createdAt,
    updatedAt: now,
    recallCount: entry.recallCount ?? 0,
    expiresAt: ttlMs != null ? createdAt + ttlMs : entry.expiresAt,
  };
}

export interface InMemoryStoreOptions {
  /** 可选向量化器：配置后 save 时自动计算 embedding（供混合检索） */
  embedder?: Embedder;
  /** 事件接收器（失败/整理等关键节点） */
  onEvent?: MemoryEventSink;
}

export class InMemoryStore implements MemoryStore {
  private idx = new MemoryIndex();
  private consolidator?: ConsolidatorLike;
  private embedder?: Embedder;
  private onEvent?: MemoryEventSink;
  private writeLock = new KeyedMutex();
  private lastConsolidatedAt?: number;

  constructor(options: InMemoryStoreOptions = {}) {
    this.embedder = options.embedder;
    this.onEvent = options.onEvent;
  }

  setConsolidator(consolidator: ConsolidatorLike): void {
    this.consolidator = consolidator;
  }

  async save(entry: MemorySaveInput): Promise<MemoryEntry> {
    return this.writeLock.withLock(entry.id ?? '*', async () => {
      // 若已存在同 id，保留 createdAt 与 embedding
      const prev = entry.id ? this.idx.get(entry.id) : null;
      const finalized = finalizeEntry(
        {
          ...entry,
          embedding: entry.embedding ?? prev?.embedding,
          // 显式 createdAt 优先（如合并器保留最早创建时间）；未提供时沿用已有条目的
          createdAt: entry.createdAt ?? prev?.createdAt,
        },
        Date.now(),
      );
      // 配置了 embedder 且无既有向量时，计算 embedding
      if (this.embedder && !finalized.embedding) {
        try {
          finalized.embedding = await this.embedder.embed(finalized.content);
        } catch (err) {
          this.onEvent?.({ type: 'embedding:error', id: finalized.id, error: (err as Error).message });
          // embedding 失败不阻断保存（退化为纯 BM25 检索）
        }
      }
      this.idx.add(finalized);
      return finalized;
    });
  }

  async get(id: string): Promise<MemoryEntry | null> {
    return this.idx.get(id);
  }

  async delete(id: string): Promise<boolean> {
    return this.writeLock.withLock(id, async () => this.idx.remove(id));
  }

  async list(limit?: number): Promise<MemoryEntry[]> {
    return this.idx.list(limit);
  }

  async search(query: string, limit?: number): Promise<MemorySearchResult[]> {
    return this.idx.search(query, limit);
  }

  async searchVectors(queryVec: number[], limit?: number): Promise<MemorySearchResult[]> {
    return this.idx.searchVectors(queryVec, limit);
  }

  async touchRecall(id: string, at: number = Date.now()): Promise<void> {
    return this.writeLock.withLock(id, async () => {
      const e = this.idx.get(id);
      if (!e) return;
      // 仅更新检索统计；不更新 updatedAt（updatedAt 表示内容修改时间，
      // 驱动增量合并候选窗口与过期语义，不应被一次检索刷新）
      e.lastRecalledAt = at;
      e.recallCount += 1;
      this.idx.add(e);
    });
  }

  async consolidate(
    options?: ConsolidateOptions,
  ): Promise<{ merged: number; pruned: number }> {
    if (!this.consolidator) return { merged: 0, pruned: 0 };
    // 不持全局锁：consolidator 内部经 store.save/delete（逐 id 锁）原子化，
    // 跨 id 的交错为 best-effort（新写入条目未被本次合并处理，下一轮再合并）
    const result = await this.consolidator.run(options);
    this.lastConsolidatedAt = Date.now();
    return result;
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
      const expiredByAge = maxAge != null && now - e.updatedAt > maxAge;
      const expiredByTtl = e.expiresAt != null && now > e.expiresAt;
      const lowConf = e.confidence < minConf;
      if (expiredByAge || expiredByTtl || lowConf) {
        if (await this.delete(e.id)) removed++;
      }
    }
    if (removed > 0) this.onEvent?.({ type: 'prune', removed });
    return removed;
  }

  async count(): Promise<number> {
    return this.idx.count();
  }

  markConsolidated(at: number = Date.now()): void {
    this.lastConsolidatedAt = at;
  }

  async stats(): Promise<MemoryStats> {
    const base = this.idx.stats();
    return { ...base, lastConsolidatedAt: this.lastConsolidatedAt };
  }

  dispose(): void {
    // 内存存储无可释放资源（占位，保持接口一致）
  }
}

export function createInMemoryStore(): MemoryStore {
  return new InMemoryStore();
}
