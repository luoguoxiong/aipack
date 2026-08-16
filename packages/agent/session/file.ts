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
 *
 * 防双写保障：
 * - 陈旧锁回收前先探测持有进程存活（锁文件首行 pid + 信号 0），
 *   长任务（超过 lockStaleMs）持有的活跃锁不会被误回收；
 * - release 校验锁文件内容归属（写入时附带唯一 token），
 *   即使锁被回收接管也不会误删他人新持有的锁。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
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

/**
 * 探测进程是否存活：信号 0 仅测试存在性，不实际发送。
 * EPERM（存在但无权限）仍视为存活；ESRCH/EINVAL 视为已死亡。
 * pid 被操作系统复用时可能误判为存活——该方向是安全的（宁可超时也不回收）。
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
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
    const target = this.sessionPath(key);
    let raw: string;
    try {
      raw = await fs.readFile(target, 'utf-8');
    } catch {
      return null; // 文件不存在等读取失败 → 无会话
    }

    let session: StoredSession;
    try {
      session = JSON.parse(raw) as StoredSession;
    } catch {
      // 损坏的会话文件：改名 .corrupt 保留待抢救，避免静默当作"无会话"
      // 被下一次 save 直接覆盖，导致整段历史无痕丢失
      await fs.rename(target, `${target}.corrupt`).catch(() => {});
      return null;
    }

    if (this.maxAge && isExpired(session, this.maxAge)) {
      await this.delete(key);
      return null;
    }
    return session;
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

      // 顺带清理残留 .tmp（save 在 writeFile 与 rename 之间中断遗留）。
      // 仅清理 mtime 早于 lockStaleMs 的，避免误删正在写入的 tmp
      const staleBefore = Date.now() - this.lockStaleMs;
      await Promise.all(
        files
          .filter(f => f.endsWith('.tmp'))
          .map(async f => {
            const p = path.join(this.baseDir, f);
            const st = await fs.stat(p).catch(() => null);
            if (st && st.mtimeMs < staleBefore) await fs.unlink(p).catch(() => {});
          }),
      );

      // 并发读取判断过期（原为串行 N+1，会话多时列举慢）
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      const entries = await Promise.all(
        jsonFiles.map(async f => {
          try {
            const decoded = decodeKey(path.basename(f, '.json'));

            // 若配置了 maxAge，列举时顺带清理过期会话
            if (this.maxAge) {
              try {
                const raw = await fs.readFile(path.join(this.baseDir, f), 'utf-8');
                const session = JSON.parse(raw) as StoredSession;
                if (isExpired(session, this.maxAge)) {
                  await fs.unlink(path.join(this.baseDir, f)).catch(() => {});
                  return null;
                }
              } catch {
                // 损坏文件跳过，不阻塞列举
                return null;
              }
            }

            return decoded;
          } catch {
            return null; // 忽略无法解码的文件名
          }
        }),
      );
      return entries.filter((k): k is string => k !== null);
    } catch {
      return []; // 目录不存在
    }
  }

  // ─── 跨进程锁 ──────────────────────────────────────────────────

  /**
   * 跨进程互斥锁（文件锁）：
   * - 用 O_EXCL 独占创建锁文件实现互斥，多进程共享同一 baseDir 时生效
   * - 锁文件内容为 `pid\n时间戳\n唯一token\n`，release 时据此校验归属
   * - 竞争方指数退避 + jitter 重试，直到 lockWaitMs 超时
   * - 陈旧锁回收：超过 lockStaleMs 且持有进程已死亡（信号 0 探测）才接管；
   *   持有进程仍存活时不回收，避免长任务运行中锁被夺走导致双写
   */
  async acquireLock(key: string): Promise<StorageLock> {
    const lockFile = this.lockPath(key);
    await fs.mkdir(path.dirname(lockFile), { recursive: true });

    const deadline = Date.now() + this.lockWaitMs;
    let attempt = 0;
    for (;;) {
      const token = `${process.pid}\n${Date.now()}\n${randomUUID()}\n`;
      try {
        await fs.writeFile(
          lockFile,
          token,
          { flag: 'wx' }, // 独占创建：已存在则失败
        );
        let released = false;
        return {
          release: async () => {
            if (released) return;
            released = true;
            try {
              // 仅当内容仍为自己写入的 token 时才删除：
              // 若自己的锁已被陈旧回收且被他人接管，此处不误删他人的锁
              const content = await fs.readFile(lockFile, 'utf-8');
              if (content === token) {
                await fs.unlink(lockFile);
              }
            } catch {
              // 锁文件已不存在（被回收等）→ 无需处理
            }
          },
        };
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'EEXIST') throw err; // 非互斥类错误（权限等）直接抛出

        // 陈旧锁回收：持有进程崩溃留下的锁文件
        try {
          const st = await fs.stat(lockFile);
          if (Date.now() - st.mtimeMs > this.lockStaleMs) {
            // 仅当持有进程已死亡时才回收；存活则继续退避等待（安全方向：
            // 宁可等到 lockWaitMs 超时报错，也不冒双写风险）
            const raw = await fs.readFile(lockFile, 'utf-8').catch(() => null);
            const holderPid = raw ? Number.parseInt(raw.split('\n')[0], 10) : NaN;
            if (!isProcessAlive(holderPid)) {
              await fs.unlink(lockFile).catch(() => {});
              continue; // 持有进程已死：删除后立即重试
            }
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
