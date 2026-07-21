import { LocalTriggerStore } from './local_store.js';
import { LocalTriggerRunner } from './local_runner.js';
import type { LocalTrigger } from './local_types.js';
import crypto from 'crypto';

export class LocalTriggers {
  store: LocalTriggerStore;
  runner: LocalTriggerRunner;
  directory: string;

  constructor(directory: string) {
    this.directory = directory;
    this.store = new LocalTriggerStore(directory);
    this.runner = new LocalTriggerRunner(directory, this.store);
  }

  list(filter: Parameters<LocalTriggerStore['list']>[0] = {}) {
    return this.store.list(filter);
  }

  get(triggerId: string) {
    return this.store.get(triggerId);
  }

  create(trigger: Omit<LocalTrigger, 'trigger_id' | 'created_at' | 'updated_at' | 'last_fire_at' | 'fire_count' | '_etag'>): LocalTrigger {
    const id = crypto.randomBytes(8).toString('hex');
    const now = new Date().toISOString();
    const t: LocalTrigger = {
      ...trigger,
      trigger_id: id,
      created_at: now,
      updated_at: now,
      last_fire_at: null,
      fire_count: 0,
      _etag: '',
    };
    return this.store.put(t);
  }

  update(triggerId: string, patch: Partial<LocalTrigger>): LocalTrigger | null {
    const existing = this.store.get(triggerId);
    if (!existing) return null;
    const merged = { ...existing, ...patch };
    return this.store.put(merged);
  }

  delete(triggerId: string): boolean {
    return this.store.delete(triggerId);
  }

  enqueue(trigger: LocalTrigger, fireAt: string, payload?: Record<string, unknown>): string {
    return this.runner.enqueue(trigger, fireAt, payload);
  }

  async runQueue() {
    return await this.runner.runLocalTriggerQueue();
  }
}
