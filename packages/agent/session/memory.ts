/**
 * packages/session/memory.ts - 内存会话存储
 *
 * 纯内存实现，进程退出即丢失。
 * 用于未配置持久化时的默认行为，或测试环境。
 * 支持 maxAge 过期清理（加载时惰性删除，与文件实现行为一致）。
 */

import type {
  SessionStorage,
  StoredSession,
  StorageLock,
  MemorySessionStorageOptions,
} from '../core';

export class MemorySessionStorage implements SessionStorage {
  private sessions = new Map<string, StoredSession>();
  private maxAge?: number;
  /** 每 key 串行队列（进程内互斥；跨进程不适用，但内存存储本身单进程） */
  private locks = new Map<string, Promise<void>>();

  constructor(options: MemorySessionStorageOptions = {}) {
    this.maxAge = options.maxAge;
  }

  private isExpired(session: StoredSession): boolean {
    if (!this.maxAge) return false;
    const updated = Date.parse(session.updatedAt);
    if (Number.isNaN(updated)) return false;
    return Date.now() - updated > this.maxAge;
  }

  async load(key: string): Promise<StoredSession | null> {
    const session = this.sessions.get(key);
    if (!session) return null;
    if (this.isExpired(session)) {
      this.sessions.delete(key);
      return null;
    }
    return session;
  }

  async save(key: string, session: StoredSession): Promise<void> {
    this.sessions.set(key, session);
  }

  async delete(key: string): Promise<boolean> {
    return this.sessions.delete(key);
  }

  async list(): Promise<string[]> {
    const keys: string[] = [];
    for (const [key, session] of this.sessions) {
      if (this.isExpired(session)) {
        this.sessions.delete(key);
        continue;
      }
      keys.push(key);
    }
    return keys;
  }

  /** 进程内 per-key 互斥：fn 执行期间独占该 key（与文件实现语义对齐） */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lock = await this.acquireLock(key);
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }

  /** 手动锁：finally 中 release() */
  async acquireLock(key: string): Promise<StorageLock> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    this.locks.set(key, current);
    await prev;
    return {
      release: async () => {
        release();
        if (this.locks.get(key) === current) {
          this.locks.delete(key);
        }
      },
    };
  }
}

export function createMemorySessionStorage(options?: MemorySessionStorageOptions): SessionStorage {
  return new MemorySessionStorage(options);
}
