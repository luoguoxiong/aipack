import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import type { LocalTrigger } from './local_types.js';

const _TRIGGERS_JSON = 'triggers.json';
const _VERSION = 1;

interface TriggerStoreRoot {
  version: number;
  triggers: Record<string, LocalTrigger>;
}

export class LocalTriggerStore {
  private _path: string;
  private _data: TriggerStoreRoot;

  constructor(directory: string) {
    this._path = path.join(directory, _TRIGGERS_JSON);
    this._data = { version: _VERSION, triggers: {} };
    this._load();
  }

  private _load(): void {
    if (!fs.existsSync(this._path)) {
      return;
    }
    try {
      const raw = fs.readFileSync(this._path, 'utf-8');
      const parsed = JSON.parse(raw) as TriggerStoreRoot;
      this._data = parsed;
    } catch (err) {
      logger.error({ err, path: this._path }, 'Failed to load triggers store');
      this._data = { version: _VERSION, triggers: {} };
    }
  }

  private _atomicSave(): void {
    const dir = path.dirname(this._path);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = this._path + '.tmp';
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(this._data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this._path);
    } catch (err) {
      logger.error({ err, path: this._path }, 'Failed to save triggers store');
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    }
  }

  list(filter: {
    channel?: string;
    account_identity?: string;
    type?: string;
    enabled?: boolean;
    user_id?: string;
  } = {}): LocalTrigger[] {
    let results = Object.values(this._data.triggers);

    if (filter.channel !== undefined) {
      results = results.filter(t => t.channel === filter.channel);
    }
    if (filter.account_identity !== undefined) {
      results = results.filter(t => t.account_identity === filter.account_identity);
    }
    if (filter.type !== undefined) {
      results = results.filter(t => t.type === filter.type);
    }
    if (filter.enabled !== undefined) {
      results = results.filter(t => t.enabled === filter.enabled);
    }
    if (filter.user_id !== undefined) {
      results = results.filter(t => t.user_id === filter.user_id);
    }

    results.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return a.created_at.localeCompare(b.created_at);
    });
    return results;
  }

  get(triggerId: string): LocalTrigger | null {
    return this._data.triggers[triggerId] || null;
  }

  put(trigger: LocalTrigger): LocalTrigger {
    const now = new Date().toISOString();
    const existing = this._data.triggers[trigger.trigger_id];
    if (existing) {
      trigger.created_at = existing.created_at;
      trigger.updated_at = now;
      trigger.fire_count = existing.fire_count;
      trigger.last_fire_at = existing.last_fire_at;
    } else {
      trigger.created_at = trigger.created_at || now;
      trigger.updated_at = now;
      trigger.fire_count = trigger.fire_count || 0;
      trigger.last_fire_at = trigger.last_fire_at || null;
    }
    trigger._etag = crypto.randomBytes(6).toString('hex');
    this._data.triggers[trigger.trigger_id] = trigger;
    this._atomicSave();
    return trigger;
  }

  delete(triggerId: string): boolean {
    if (!this._data.triggers[triggerId]) {
      return false;
    }
    delete this._data.triggers[triggerId];
    this._atomicSave();
    return true;
  }

  recordFire(triggerId: string): void {
    const t = this._data.triggers[triggerId];
    if (!t) return;
    t.fire_count++;
    t.last_fire_at = new Date().toISOString();
    t._etag = crypto.randomBytes(6).toString('hex');
    this._atomicSave();
  }
}
