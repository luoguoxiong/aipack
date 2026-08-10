/**
 * 文件记忆存储（默认实现）。
 *
 * 每条记忆一个 JSON 文件：<baseDir>/<encodeURIComponent(id)>.json。
 * 写入采用 temp + rename 原子替换（镜像 aipack FileSessionStorage）。
 * 内存缓存 MemoryIndex + BM25 增量索引；首次访问时懒加载并按 maxAge/expiresAt 惰性清理。
 *
 * 并发安全：同 id 的写操作（save/delete/touchRecall）经 keyed mutex 串行，
 * 避免 read-modify-write 竞态（如 embedding 计算期间丢失另一路更新）。
 *
 * 加载优化：懒加载时并发批量读文件（默认 64 并发），避免逐文件串行 IO；
 * 检索要求条目常驻内存（BM25 倒排 + 向量索引），内存占用与记忆规模成正比
 * （详见 README 限制说明）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MemoryIndex } from './memory-index';
import { finalizeEntry } from './in-memory-store';
import { KeyedMutex } from '../utils/keyed-mutex';
import type {
  ConsolidateOptions,
  ConsolidatorLike,
  Embedder,
  FileMemoryStoreOptions,
  MemoryEntry,
  MemoryEventSink,
  MemorySaveInput,
  MemorySearchResult,
  MemoryStats,
  MemoryStore,
} from '../types';

function resolveBaseDir(baseDir?: string): string {
  if (baseDir) {
    if (baseDir === '~') return os.homedir();
    if (baseDir.startsWith('~/')) return path.join(os.homedir(), baseDir.slice(2));
    if (path.isAbsolute(baseDir)) return baseDir;
    return path.join(process.cwd(), baseDir);
  }
  return path.join(process.cwd(), '.aipack', 'memory');
}

function encodeId(id: string): string {
  return encodeURIComponent(id);
}

/** 懒加载并发读的批大小 */
const LOAD_CONCURRENCY = 64;

/** 并发执行 tasks（每批 LOAD_CONCURRENCY 个），返回完成数量（含失败） */
async function runPool<T>(tasks: (() => Promise<T>)[]): Promise<number> {
  let done = 0;
  for (let i = 0; i < tasks.length; i += LOAD_CONCURRENCY) {
    const batch = tasks.slice(i, i + LOAD_CONCURRENCY);
    await Promise.all(
      batch.map(async (t) => {
        try {
          await t();
        } finally {
          done++;
        }
      }),
    );
  }
  return done;
}

export class FileMemoryStore implements MemoryStore {
  private baseDir: string;
  private maxAge?: number;
  private idx: MemoryIndex;
  private loaded = false;
  private loading: Promise<void> | null = null;
  private consolidator?: ConsolidatorLike;
  private embedder?: Embedder;
  private onEvent?: MemoryEventSink;
  /** 同 id 写互斥（save/delete/touchRecall） */
  private writeLocks = new KeyedMutex();
  private lastConsolidatedAt?: number;

  constructor(
    options: FileMemoryStoreOptions & {
      index?: MemoryIndex;
      embedder?: Embedder;
      onEvent?: MemoryEventSink;
    } = {},
  ) {
    this.baseDir = resolveBaseDir(options.baseDir);
    this.maxAge = options.maxAge;
    this.idx = options.index ?? new MemoryIndex();
    this.embedder = options.embedder;
    this.onEvent = options.onEvent;
  }

  get dir(): string {
    return this.baseDir;
  }

  setConsolidator(consolidator: ConsolidatorLike): void {
    this.consolidator = consolidator;
  }

  // ─── 加载 ───────────────────────────────────────────────────────

  /** 懒加载：读取目录所有 JSON → 内存索引。并发安全。 */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const start = Date.now();
      let loaded = 0;
      let skipped = 0;
      try {
        await fs.mkdir(this.baseDir, { recursive: true });
        const files = await fs.readdir(this.baseDir);
        const now = Date.now();
        const jsonFiles = files.filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'));
        await runPool(
          jsonFiles.map((f) => async () => {
            const filePath = path.join(this.baseDir, f);
            try {
              const raw = await fs.readFile(filePath, 'utf-8');
              const entry = JSON.parse(raw) as MemoryEntry;
              if (!entry?.id) {
                skipped++;
                return;
              }
              // 惰性过期清理（maxAge 按 updatedAt / expiresAt）
              const expiredByAge =
                this.maxAge != null && now - entry.updatedAt > this.maxAge;
              const expiredByTtl = entry.expiresAt != null && now > entry.expiresAt;
              if (expiredByAge || expiredByTtl) {
                await fs.unlink(filePath).catch(() => {});
                skipped++;
                return;
              }
              this.idx.add(entry);
              loaded++;
            } catch {
              skipped++;
              this.onEvent?.({ type: 'store:corrupt', file: f });
            }
          }),
        );
      } catch (err) {
        // 目录不存在等：记录并继续（空库可用）
        this.onEvent?.({ type: 'store:corrupt', file: `<baseDir> ${(err as Error).message}` });
      }
      this.loaded = true;
      this.loading = null;
      if (loaded > 0 || skipped > 0) {
        this.onEvent?.({
          type: 'store:load',
          loaded,
          skipped,
          ms: Date.now() - start,
        });
      }
    })();
    return this.loading;
  }

  private entryPath(id: string): string {
    return path.join(this.baseDir, `${encodeId(id)}.json`);
  }

  private async writeEntry(entry: MemoryEntry): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    const target = this.entryPath(entry.id);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entry, null, 2), 'utf-8');
    await fs.rename(tmp, target); // 原子替换
  }

  // ─── MemoryStore ────────────────────────────────────────────────

  async save(entry: MemorySaveInput): Promise<MemoryEntry> {
    await this.ensureLoaded();
    return this.writeLocks.withLock(entry.id ?? '*', async () => {
      const prev = entry.id ? this.idx.get(entry.id) : null;
      const finalized = finalizeEntry(
        {
          ...entry,
          // 保留 embedding（若已存在且新 entry 未提供）
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
          this.onEvent?.({
            type: 'embedding:error',
            id: finalized.id,
            error: (err as Error).message,
          });
          // embedding 失败不阻断保存（退化为纯 BM25 检索）
        }
      }
      await this.writeEntry(finalized);
      this.idx.add(finalized);
      return finalized;
    });
  }

  async get(id: string): Promise<MemoryEntry | null> {
    await this.ensureLoaded();
    return this.idx.get(id);
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.writeLocks.withLock(id, async () => {
      const existed = this.idx.remove(id);
      if (existed) {
        await fs.unlink(this.entryPath(id)).catch(() => {});
      }
      return existed;
    });
  }

  async list(limit?: number): Promise<MemoryEntry[]> {
    await this.ensureLoaded();
    return this.idx.list(limit);
  }

  async search(query: string, limit?: number): Promise<MemorySearchResult[]> {
    await this.ensureLoaded();
    return this.idx.search(query, limit);
  }

  async searchVectors(queryVec: number[], limit?: number): Promise<MemorySearchResult[]> {
    await this.ensureLoaded();
    return this.idx.searchVectors(queryVec, limit);
  }

  async touchRecall(id: string, at: number = Date.now()): Promise<void> {
    await this.ensureLoaded();
    return this.writeLocks.withLock(id, async () => {
      const e = this.idx.get(id);
      if (!e) return;
      // 仅更新检索统计；不更新 updatedAt（updatedAt = 内容修改时间，
      // 驱动增量合并候选窗口与过期语义，不应被一次检索刷新）
      e.lastRecalledAt = at;
      e.recallCount += 1;
      await this.writeEntry(e);
      this.idx.add(e);
    });
  }

  async consolidate(
    options?: ConsolidateOptions,
  ): Promise<{ merged: number; pruned: number }> {
    if (!this.consolidator) return { merged: 0, pruned: 0 };
    await this.ensureLoaded();
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
    await this.ensureLoaded();
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
    await this.ensureLoaded();
    return this.idx.count();
  }

  markConsolidated(at: number = Date.now()): void {
    this.lastConsolidatedAt = at;
  }

  async stats(): Promise<MemoryStats> {
    await this.ensureLoaded();
    const base = this.idx.stats();
    return { ...base, lastConsolidatedAt: this.lastConsolidatedAt };
  }

  dispose(): void {
    // 所有写操作均 await 完成，无后台句柄需释放（占位，保持接口一致）
  }
}

export function createFileMemoryStore(options?: FileMemoryStoreOptions): MemoryStore {
  return new FileMemoryStore(options);
}
