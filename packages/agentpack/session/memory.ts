/**
 * packages/session/memory.ts - 内存会话存储
 *
 * 纯内存实现，进程退出即丢失。
 * 用于未配置持久化时的默认行为，或测试环境。
 */

import type { SessionStorage, StoredSession } from '../core';

export class MemorySessionStorage implements SessionStorage {
  private sessions = new Map<string, StoredSession>();

  async load(key: string): Promise<StoredSession | null> {
    return this.sessions.get(key) ?? null;
  }

  async save(key: string, session: StoredSession): Promise<void> {
    this.sessions.set(key, session);
  }

  async delete(key: string): Promise<boolean> {
    return this.sessions.delete(key);
  }

  async list(): Promise<string[]> {
    return Array.from(this.sessions.keys());
  }
}

export function createMemorySessionStorage(): SessionStorage {
  return new MemorySessionStorage();
}
