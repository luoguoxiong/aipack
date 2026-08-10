/**
 * packages/session/file.ts - 文件会话存储
 *
 * 每个会话一个 JSON 文件，默认存储到 <pwd>/.aipack/sessions/。
 * 写入采用 temp + rename 原子替换，防止进程中断损坏会话。
 * 支持 maxAge 过期清理（加载与列举时清理）。
 *
 * 并发说明：同一进程内由 Runtime 的会话串行队列保证不会并发写同一 key；
 * 多进程场景通过 withLock/acquireLock 文件锁（O_EXCL + 陈旧锁回收）保证
 * 同 key 的"读-改-写"互斥，Runtime 在非 ephemeral 请求下自动加锁。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type {
  SessionStorage,
  StoredSession,
  StorageLock,
  FileSessionStorageOptions,
} from '../core';

/** 简单 sleep 工具 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resolveBaseDir(baseDir?: string): string {
  if (baseDir) {
    if (baseDir.startsWith('~')) return path.join(os.homedir(), baseDir.slice(1));
    if (path.isAbsolute(baseDir)) return baseDir;
    return path.join(process.cwd(), baseDir);
  }
  return path.join(process.cwd(), '.aipack', 'sessions');
}

/** 将任意 sessionKey 编码为安全文件名 */
function encodeKey(key: string): string {
  return encodeURIComponent(key);
}

function decodeKey(fileName: string): string {
  return decodeURIComponent(fileName);
}

/** 判断会话是否已过期 */
function isExpired(session: StoredSession, maxAge: number): boolean {
  const updated = Date.parse(session.updatedAt);
  if (Number.isNaN(updated)) return false;
  return Date.now() - updated > maxAge;
}

export class FileSessionStorage implements SessionStorage {
  private baseDir: string;
  private maxAge?: number;
  private maxStoredMessages: number;
  private lockWaitMs: number;
  private lockStaleMs: number;
  private lockRetryMs: number;

  constructor(options: FileSessionStorageOptions = {}) {
    this.baseDir = resolveBaseDir(options.baseDir);
    this.maxAge = options.maxAge;
    this.maxStoredMessages = options.maxStoredMessages ?? 0;
    this.lockWaitMs = options.lockWaitMs ?? 30_000;
    this.lockStaleMs = options.lockStaleMs ?? 300_000;
    this.lockRetryMs = options.lockRetryMs ?? 25;
  }

  get dir(): string {
    return this.baseDir;
  }

  private sessionPath(key: string): string {
    return path.join(this.baseDir, `${encodeKey(key)}.json`);
  }

  /** 锁文件路径：<baseDir>/.locks/<key>.lock，跨进程用文件独占创建互斥 */
  private lockPath(key: string): string {
    return path.join(this.baseDir, '.locks', `${encodeKey(key)}.lock`);
  }

  async load(key: string): Promise<StoredSession | null> {
    try {
      const raw = await fs.readFile(this.sessionPath(key), 'utf-8');
      const session = JSON.parse(raw) as StoredSession;

      if (this.maxAge && isExpired(session, this.maxAge)) {
        await this.delete(key);
        return null;
      }
      return session;
    } catch {
      return null; // 文件不存在或损坏，视为无会话
    }
  }

  async save(key: string, session: StoredSession): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });

    // 应用消息条数上限，保留最新部分
    const toStore: StoredSession = this.maxStoredMessages > 0 &&
      session.messages.length > this.maxStoredMessages
      ? {
          ...session,
          messages: session.messages.slice(-this.maxStoredMessages),
        }
      : session;

    const target = this.sessionPath(key);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(toStore, null, 2), 'utf-8');
    await fs.rename(tmp, target); // 原子替换
  }

  async delete(key: string): Promise<boolean> {
    try {
      await fs.unlink(this.sessionPath(key));
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.baseDir);
      const keys: string[] = [];
      for (const f of files) {
        if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
        try {
          const decoded = decodeKey(path.basename(f, '.json'));

          // 若配置了 maxAge，列举时顺带清理过期会话
          if (this.maxAge) {
            try {
              const raw = await fs.readFile(path.join(this.baseDir, f), 'utf-8');
              const session = JSON.parse(raw) as StoredSession;
              if (isExpired(session, this.maxAge)) {
                await fs.unlink(path.join(this.baseDir, f)).catch(() => {});
                continue;
              }
            } catch {
              // 损坏文件跳过，不阻塞列举
              continue;
            }
          }

          keys.push(decoded);
        } catch {
          // 忽略无法解码的文件名
        }
      }
      return keys;
    } catch {
      return []; // 目录不存在
    }
  }

  // ─── 跨进程锁 ──────────────────────────────────────────────────

  /**
   * 跨进程互斥锁（文件锁）：
   * - 用 O_EXCL 独占创建锁文件实现互斥，多进程共享同一 baseDir 时生效
   * - 竞争方指数退避 + jitter 重试，直到 lockWaitMs 超时
   * - 持有进程崩溃遗留的锁文件超过 lockStaleMs 视为陈旧，接管删除后重试
   */
  async acquireLock(key: string): Promise<StorageLock> {
    const lockFile = this.lockPath(key);
    await fs.mkdir(path.dirname(lockFile), { recursive: true });

    const deadline = Date.now() + this.lockWaitMs;
    let attempt = 0;
    for (;;) {
      try {
        await fs.writeFile(
          lockFile,
          `${process.pid}\n${Date.now()}\n`,
          { flag: 'wx' }, // 独占创建：已存在则失败
        );
        let released = false;
        return {
          release: async () => {
            if (released) return;
            released = true;
            // 仅删除自己创建的锁文件（理论上不可能被替换，防御性判断）
            await fs.unlink(lockFile).catch(() => {});
          },
        };
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'EEXIST') throw err; // 非互斥类错误（权限等）直接抛出

        // 陈旧锁回收：持有进程崩溃留下的锁文件
        try {
          const st = await fs.stat(lockFile);
          if (Date.now() - st.mtimeMs > this.lockStaleMs) {
            await fs.unlink(lockFile).catch(() => {});
            continue; // 删除后立即重试
          }
        } catch {
          continue; // stat 失败（锁文件刚被释放）→ 重试
        }

        if (Date.now() >= deadline) {
          throw new Error(
            `[SessionStorage] 获取会话锁超时（${this.lockWaitMs}ms）: ${key}`,
          );
        }
        attempt++;
        // 指数退避 + jitter，上限 500ms
        await sleep(Math.min(this.lockRetryMs * 2 ** attempt, 500) + Math.random() * 20);
      }
    }
  }

  /** 便捷形式：fn 执行期间独占该 key */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lock = await this.acquireLock(key);
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }
}

export function createFileSessionStorage(options?: FileSessionStorageOptions): SessionStorage {
  return new FileSessionStorage(options);
}
