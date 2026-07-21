import fs from 'fs/promises';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getProjectConfigDir } from '../config/paths.js';

export interface MemoryEntry {
  id: string;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

export interface DreamConfig {
  enabled: boolean;
  interval_h: number;
  model_override?: string;
  max_batch_size: number;
}

export class MemoryStore {
  private baseDir: string;
  private entries: Map<string, MemoryEntry> = new Map();
  private loaded = false;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || path.join(getProjectConfigDir(), 'memory');
  }

  async load(): Promise<void> {
    if (this.loaded) return;

    try {
      await fs.mkdir(this.baseDir, { recursive: true });
      const files = await fs.readdir(this.baseDir);
      
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const data = JSON.parse(
            await fs.readFile(path.join(this.baseDir, file), 'utf-8'),
          ) as MemoryEntry;
          this.entries.set(data.key, data);
        } catch (err) {
          logger.debug({ err, file }, 'Failed to load memory entry');
        }
      }
      
      this.loaded = true;
      logger.info({ count: this.entries.size }, 'Memory store loaded');
    } catch (err) {
      logger.error({ err }, 'Failed to load memory store');
    }
  }

  async set(key: string, value: string, metadata?: Record<string, unknown>): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.entries.get(key);
    
    const entry: MemoryEntry = {
      id: existing?.id || `mem_${Date.now()}`,
      key,
      value,
      created_at: existing?.created_at || now,
      updated_at: now,
      metadata: metadata || existing?.metadata,
    };
    
    this.entries.set(key, entry);
    await this.saveEntry(entry);
  }

  async get(key: string): Promise<MemoryEntry | undefined> {
    return this.entries.get(key);
  }

  async delete(key: string): Promise<boolean> {
    const entry = this.entries.get(key);
    if (!entry) return false;
    
    this.entries.delete(key);
    
    try {
      const filePath = path.join(this.baseDir, `${this.safeKey(key)}.json`);
      await fs.unlink(filePath);
    } catch (err) {
      logger.debug({ err, key }, 'Failed to delete memory file');
    }
    
    return true;
  }

  async search(query: string, limit = 10): Promise<MemoryEntry[]> {
    const q = query.toLowerCase();
    const results: MemoryEntry[] = [];
    
    for (const entry of this.entries.values()) {
      if (
        entry.key.toLowerCase().includes(q) ||
        entry.value.toLowerCase().includes(q)
      ) {
        results.push(entry);
        if (results.length >= limit) break;
      }
    }
    
    return results;
  }

  list(): string[] {
    return Array.from(this.entries.keys());
  }

  count(): number {
    return this.entries.size;
  }

  private async saveEntry(entry: MemoryEntry): Promise<void> {
    try {
      await fs.mkdir(this.baseDir, { recursive: true });
      const filePath = path.join(this.baseDir, `${this.safeKey(entry.key)}.json`);
      await fs.writeFile(filePath, JSON.stringify(entry, null, 2), 'utf-8');
    } catch (err) {
      logger.error({ err, key: entry.key }, 'Failed to save memory entry');
    }
  }

  private safeKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9_\-]/g, '_').toLowerCase().slice(0, 100);
  }
}
