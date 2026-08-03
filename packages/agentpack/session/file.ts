/**
 * packages/session/file.ts - 文件会话存储
 *
 * 每个会话一个 JSON 文件，默认存储到 <pwd>/.agentpack/sessions/。
 * 写入采用 temp + rename 原子替换，防止进程中断损坏会话。
 * 支持 maxAge 过期清理（加载时惰性删除）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type {
  SessionStorage,
  StoredSession,
  FileSessionStorageOptions,
} from '../core';

function resolveBaseDir(baseDir?: string): string {
  if (baseDir) {
    if (baseDir.startsWith('~')) return path.join(os.homedir(), baseDir.slice(1));
    if (path.isAbsolute(baseDir)) return baseDir;
    return path.join(process.cwd(), baseDir);
  }
  return path.join(process.cwd(), '.agentpack', 'sessions');
}

/** 将任意 sessionKey 编码为安全文件名 */
function encodeKey(key: string): string {
  return encodeURIComponent(key);
}

function decodeKey(fileName: string): string {
  return decodeURIComponent(fileName);
}

export class FileSessionStorage implements SessionStorage {
  private baseDir: string;
  private maxAge?: number;

  constructor(options: FileSessionStorageOptions = {}) {
    this.baseDir = resolveBaseDir(options.baseDir);
    this.maxAge = options.maxAge;
  }

  get dir(): string {
    return this.baseDir;
  }

  private sessionPath(key: string): string {
    return path.join(this.baseDir, `${encodeKey(key)}.json`);
  }

  async load(key: string): Promise<StoredSession | null> {
    try {
      const raw = await fs.readFile(this.sessionPath(key), 'utf-8');
      const session = JSON.parse(raw) as StoredSession;

      if (this.maxAge) {
        const updated = Date.parse(session.updatedAt);
        if (!Number.isNaN(updated) && Date.now() - updated > this.maxAge) {
          await this.delete(key);
          return null;
        }
      }
      return session;
    } catch {
      return null; // 文件不存在或损坏，视为无会话
    }
  }

  async save(key: string, session: StoredSession): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    const target = this.sessionPath(key);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(session, null, 2), 'utf-8');
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
          keys.push(decodeKey(path.basename(f, '.json')));
        } catch {
          // 忽略无法解码的文件名
        }
      }
      return keys;
    } catch {
      return []; // 目录不存在
    }
  }
}

export function createFileSessionStorage(options?: FileSessionStorageOptions): SessionStorage {
  return new FileSessionStorage(options);
}
