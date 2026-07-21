import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { LocalTriggerStore } from './local_store.js';
import { buildTriggerTurnContext, type TriggerTurnContext } from './local_turns.js';
import type { LocalTrigger } from './local_types.js';

const _QUEUE_SUBDIR = 'queue';
const _CLAIM_SUBDIR = 'claimed';

interface TriggerQueueEntry {
  entry_id: string;
  trigger_id: string;
  fire_at: string;
  payload: Record<string, unknown> | null;
  session_id: string | null;
}

export class LocalTriggerRunner {
  private _queueDir: string;
  private _claimedDir: string;
  private _store: LocalTriggerStore;

  constructor(directory: string, store: LocalTriggerStore) {
    this._queueDir = path.join(directory, _QUEUE_SUBDIR);
    this._claimedDir = path.join(directory, _CLAIM_SUBDIR);
    this._store = store;
    fs.mkdirSync(this._queueDir, { recursive: true });
    fs.mkdirSync(this._claimedDir, { recursive: true });
  }

  enqueue(trigger: LocalTrigger, fireAt: string, payload?: Record<string, unknown>): string {
    const entryId = crypto.randomBytes(8).toString('hex');
    const entry: TriggerQueueEntry = {
      entry_id: entryId,
      trigger_id: trigger.trigger_id,
      fire_at: fireAt,
      payload: payload || null,
      session_id: trigger.session_id,
    };
    const filePath = path.join(this._queueDir, `${entryId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
    logger.debug({ trigger_id: trigger.trigger_id, entry_id: entryId, fire_at: fireAt }, 'Trigger enqueued');
    return entryId;
  }

  peekDueEntries(now: Date): TriggerQueueEntry[] {
    const entries: TriggerQueueEntry[] = [];
    const files = fs.readdirSync(this._queueDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(this._queueDir, file), 'utf-8');
        const entry = JSON.parse(raw) as TriggerQueueEntry;
        const fireAt = new Date(entry.fire_at);
        if (fireAt.getTime() <= now.getTime()) {
          entries.push(entry);
        }
      } catch {
        // skip corrupt entries
      }
    }
    entries.sort((a, b) => new Date(a.fire_at).getTime() - new Date(b.fire_at).getTime());
    return entries;
  }

  claim(entryId: string): TriggerQueueEntry | null {
    const src = path.join(this._queueDir, `${entryId}.json`);
    if (!fs.existsSync(src)) return null;
    try {
      const raw = fs.readFileSync(src, 'utf-8');
      const entry = JSON.parse(raw) as TriggerQueueEntry;
      const dest = path.join(this._claimedDir, `${entryId}.json`);
      fs.renameSync(src, dest);
      return entry;
    } catch {
      return null;
    }
  }

  async runLocalTriggerQueue(): Promise<TriggerTurnContext[]> {
    const now = new Date();
    const due = this.peekDueEntries(now);
    const ctxs: TriggerTurnContext[] = [];

    for (const entry of due) {
      const claimed = this.claim(entry.entry_id);
      if (!claimed) continue;

      const trigger = this._store.get(claimed.trigger_id);
      if (!trigger) {
        logger.debug({ entry_id: claimed.entry_id }, 'Trigger not found, skipping');
        continue;
      }
      if (!trigger.enabled) {
        logger.debug({ trigger_id: trigger.trigger_id }, 'Trigger disabled, skipping');
        continue;
      }

      const ctx = buildTriggerTurnContext(trigger, claimed.fire_at);
      ctxs.push(ctx);
      this._store.recordFire(trigger.trigger_id);
    }

    return ctxs;
  }

  clearCompleted(entryId: string): void {
    const dest = path.join(this._claimedDir, `${entryId}.json`);
    try {
      if (fs.existsSync(dest)) {
        fs.unlinkSync(dest);
      }
    } catch {
      // ignore
    }
  }
}
