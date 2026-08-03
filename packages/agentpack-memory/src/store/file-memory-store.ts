/**
 * 文件记忆存储（默认实现）。
 *
 * 每条记忆一个 JSON 文件：<baseDir>/<encodeURIComponent(id)>.json。
 * 写入采用 temp + rename 原子替换（镜像 agentpack FileSessionStorage）。
 * 内存缓存 MemoryIndex + BM25 增量索引；首次访问时懒加载并按 maxAge 惰性清理。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MemoryIndex } from './memory-index';
import { finalizeEntry } from './in-memory-store';
import type {
  ConsolidateOptions,
  ConsolidatorLike,
  Embedder,
  FileMemoryStoreOptions,
  MemoryEntry,
  MemorySaveInput,
  MemorySearchResult,
  MemoryStore,
} from '../types';

function resolveBaseDir(baseDir?: string): string {
  if (baseDir) {
    if (baseDir === '~') return os.homedir();
    if (baseDir.startsWith('~/')) return path.join(os.homedir(), baseDir.slice(2));
    if (path.isAbsolute(baseDir)) return baseDir;
    return path.join(process.cwd(), baseDir);
  }
  return path.join(process.cwd(), '.agentpack', 'memory');
}

function encodeId(id: string): string {
  return encodeURIComponent(id);
}

export class FileMemoryStore implements MemoryStore {
  private baseDir: string;
  private maxAge?: number;
  private idx: MemoryIndex;
  private loaded = false;
  private loading: Promise<void> | null = null;
  private consolidator?: ConsolidatorLike;
  private embedder?: Embedder;

  constructor(
    options: FileMemoryStoreOptions & { index?: MemoryIndex; embedder?: Embedder } = {},
  ) {
    this.baseDir = resolveBaseDir(options.baseDir);
    this.maxAge = options.maxAge;
    this.idx = options.index ?? new MemoryIndex();
    this.embedder = options.embedder;
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
      try {
        await fs.mkdir(this.baseDir, { recursive: true });
        const files = await fs.readdir(this.baseDir);
        const now = Date.now();
        for (const f of files) {
          if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
          try {
            const raw = await fs.readFile(path.join(this.baseDir, f), 'utf-8');
            const entry = JSON.parse(raw) as MemoryEntry;
            if (!entry?.id) continue;
            // 惰性过期清理
            if (this.maxAge != null && now - entry.updatedAt > this.maxAge) {
              await fs.unlink(path.join(this.baseDir, f)).catch(() => {});
              continue;
            }
            this.idx.add(entry);
          } catch {
            // 损坏文件忽略
          }
        }
      } catch {
        // 目录不存在等，忽略
      }
      this.loaded = true;
      this.loading = null;
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
    const prev = entry.id ? this.idx.get(entry.id) : null;
    const finalized = finalizeEntry(
      {
        ...entry,
        // 保留 embedding（若已存在且新 entry 未提供）
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
    await this.writeEntry(finalized);
    this.idx.add(finalized);
    return finalized;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    await this.ensureLoaded();
    return this.idx.get(id);
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const existed = this.idx.remove(id);
    if (existed) {
      await fs.unlink(this.entryPath(id)).catch(() => {});
    }
    return existed;
  }

  async list(limit?: number): Promise<MemoryEntry[]> {
    await this.ensureLoaded();
    return this.idx.list(limit);
  }

  async search(query: string, limit?: number): Promise<MemorySearchResult[]> {
    await this.ensureLoaded();
    return this.idx.search(query, limit);
  }

  async touchRecall(id: string, at: number = Date.now()): Promise<void> {
    await this.ensureLoaded();
    const e = this.idx.get(id);
    if (!e) return;
    e.lastRecalledAt = at;
    e.recallCount += 1;
    e.updatedAt = Date.now();
    await this.writeEntry(e);
    this.idx.add(e);
  }

  async consolidate(
    options?: ConsolidateOptions,
  ): Promise<{ merged: number; pruned: number }> {
    if (!this.consolidator) return { merged: 0, pruned: 0 };
    await this.ensureLoaded();
    return this.consolidator.run(options);
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
      const expired = maxAge != null && now - e.updatedAt > maxAge;
      const lowConf = e.confidence < minConf;
      if (expired || lowConf) {
        this.idx.remove(e.id);
        await fs.unlink(this.entryPath(e.id)).catch(() => {});
        removed++;
      }
    }
    return removed;
  }

  async count(): Promise<number> {
    await this.ensureLoaded();
    return this.idx.count();
  }
}

export function createFileMemoryStore(options?: FileMemoryStoreOptions): MemoryStore {
  return new FileMemoryStore(options);
}
