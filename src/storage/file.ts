import fs from 'fs';
import path from 'path';
import type { StorageAdapter, SessionData, FileStorageOptions } from './types';
import { logger } from '../utils/logger';

export class FileStorage implements StorageAdapter {
  private baseDir: string;
  private maxAge: number;
  private locks = new Map<string, Promise<void>>();

  constructor(options: FileStorageOptions) {
    this.baseDir = options.baseDir;
    this.maxAge = options.maxAge || 0;
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  private getFilePath(key: string): string {
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.baseDir, `${safeKey}.json`);
  }

  private getLockFilePath(key: string): string {
    return `${this.getFilePath(key)}.lock`;
  }

  private async acquireLock(key: string): Promise<void> {
    const lockFile = this.getLockFilePath(key);
    let attempts = 0;
    const maxAttempts = 10;
    const delayMs = 100;

    while (attempts < maxAttempts) {
      try {
        await fs.promises.mkdir(path.dirname(lockFile), { recursive: true });
        await fs.promises.writeFile(lockFile, '', { flag: 'wx' });
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          attempts++;
          await new Promise(resolve => setTimeout(resolve, delayMs * attempts));
        } else {
          throw err;
        }
      }
    }

    throw new Error(`Failed to acquire lock for session ${key}`);
  }

  private async releaseLock(key: string): Promise<void> {
    const lockFile = this.getLockFilePath(key);
    try {
      await fs.promises.unlink(lockFile);
    } catch {
      // 如果锁文件不存在则忽略
    }
  }

  private validateJson(data: string): boolean {
    try {
      JSON.parse(data);
      return true;
    } catch {
      return false;
    }
  }

  async saveSession(session: SessionData): Promise<void> {
    const filePath = this.getFilePath(session.key);
    
    await this.acquireLock(session.key);
    try {
      const data = JSON.stringify(session, null, 2);
      
      const tempPath = `${filePath}.tmp`;
      await fs.promises.writeFile(tempPath, data, 'utf-8');
      await fs.promises.rename(tempPath, filePath);
    } finally {
      await this.releaseLock(session.key);
    }
  }

  async loadSession(key: string): Promise<SessionData | null> {
    const filePath = this.getFilePath(key);
    
    await this.acquireLock(key);
    try {
      try {
        const stats = await fs.promises.stat(filePath);
        if (this.maxAge > 0 && Date.now() - stats.mtime.getTime() > this.maxAge) {
          await fs.promises.unlink(filePath);
          return null;
        }
        
        const data = await fs.promises.readFile(filePath, 'utf-8');
        
        if (!this.validateJson(data)) {
          logger.warn({ filePath }, 'Session file contains invalid JSON, deleting');
          await fs.promises.unlink(filePath);
          return null;
        }
        
        return JSON.parse(data);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        
        logger.error({ filePath, err }, 'Failed to load session file, deleting corrupted file');
        try {
          await fs.promises.unlink(filePath);
        } catch {
          // 忽略删除错误
        }
        return null;
      }
    } finally {
      await this.releaseLock(key);
    }
  }

  async deleteSession(key: string): Promise<boolean> {
    const filePath = this.getFilePath(key);
    
    await this.acquireLock(key);
    try {
      try {
        await fs.promises.unlink(filePath);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return false;
        }
        throw err;
      }
    } finally {
      await this.releaseLock(key);
    }
  }

  async listSessions(): Promise<string[]> {
    try {
      const files = await fs.promises.readdir(this.baseDir);
      const sessions: string[] = [];
      
      for (const file of files) {
        if (file.endsWith('.json') && !file.endsWith('.tmp')) {
          const key = file.slice(0, -5);
          sessions.push(key);
        }
      }
      
      return sessions;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  async getAllSessions(): Promise<SessionData[]> {
    const keys = await this.listSessions();
    const sessions: SessionData[] = [];
    
    for (const key of keys) {
      const session = await this.loadSession(key);
      if (session) {
        sessions.push(session);
      }
    }
    
    return sessions;
  }

  async cleanupOldSessions(): Promise<void> {
    if (this.maxAge <= 0) return;
    
    const keys = await this.listSessions();
    for (const key of keys) {
      const filePath = this.getFilePath(key);
      
      try {
        const stats = await fs.promises.stat(filePath);
        if (Date.now() - stats.mtime.getTime() > this.maxAge) {
          await fs.promises.unlink(filePath);
        }
      } catch {
        // 忽略
      }
    }
  }
}

export function createFileStorage(options: FileStorageOptions): FileStorage {
  return new FileStorage(options);
}
