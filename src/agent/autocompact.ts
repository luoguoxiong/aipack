import { Session, SessionMessage } from '../session/manager.js';
import { LLMRuntime } from '../providers/base.js';
import { logger } from '../utils/logger.js';

const RECENT_SUFFIX_MESSAGES = 8;
const INTERNAL_SESSION_PREFIXES = ['dream:'];

export interface Consolidator {
  compactIdleSession(
    key: string,
    options: { runtime: LLMRuntime; maxSuffix: number },
  ): Promise<string | null>;
}

export interface SessionManagerLike {
  getOrCreate(key: string): Promise<Session> | Session;
  getSession(key: string): Promise<Session> | Session;
  listSessions(): Promise<string[]> | string[];
}

export interface SessionInfo {
  key: string;
  updated_at?: string;
  [key: string]: unknown;
}

export class AutoCompact {
  private sessions: SessionManagerLike;
  private consolidator: Consolidator;
  private _ttl: number;
  private _archiving: Set<string> = new Set();
  private _summaries: Map<string, { text: string; lastActive: Date }> = new Map();

  constructor(
    sessions: SessionManagerLike,
    consolidator: Consolidator,
    sessionTtlMinutes = 0,
  ) {
    this.sessions = sessions;
    this.consolidator = consolidator;
    this._ttl = sessionTtlMinutes;
  }

  private _isExpired(
    ts: string | Date | null | undefined,
    now: Date = new Date(),
  ): boolean {
    if (this._ttl <= 0 || !ts) return false;
    const date = typeof ts === 'string' ? new Date(ts) : ts;
    return (now.getTime() - date.getTime()) >= this._ttl * 60 * 1000;
  }

  private async _hasCompactableIdleTail(key: string): Promise<boolean> {
    const session = await this.sessions.getOrCreate(key);
    const tail = session.messages.slice(session.messages.length - RECENT_SUFFIX_MESSAGES);
    if (tail.length === 0) return false;
    const messagesToRemove = tail.length - RECENT_SUFFIX_MESSAGES;
    return messagesToRemove > 0;
  }

  private static _formatSummary(text: string, lastActive: Date): string {
    return `Previous conversation summary (last active ${lastActive.toISOString()}):\n${text}`;
  }

  private static _isInternalSession(key: string): boolean {
    return INTERNAL_SESSION_PREFIXES.some(prefix => key.startsWith(prefix));
  }

  checkExpired(
    scheduleBackground: (fn: Promise<void>) => void,
    resolveRuntime: () => LLMRuntime,
    activeSessionKeys: string[] = [],
  ): void {
    const now = new Date();
    this._listSessionInfos().then(infos => {
      for (const info of infos) {
        const key = info.key;
        if (!key || AutoCompact._isInternalSession(key) || this._archiving.has(key)) {
          continue;
        }
        if (activeSessionKeys.includes(key)) continue;
        const updatedAt = info.updated_at;
        if (this._isExpired(updatedAt, now)) {
          this._hasCompactableIdleTail(key).then(hasCompactable => {
            if (hasCompactable) {
              const runtime = resolveRuntime();
              this._archiving.add(key);
              scheduleBackground(this._archive(key, runtime));
            }
          });
        }
      }
    });
  }

  private async _listSessionInfos(): Promise<SessionInfo[]> {
    const keys = await this.sessions.listSessions();
    const infos: SessionInfo[] = [];
    for (const key of keys) {
      try {
        const session = await this.sessions.getSession(key);
        infos.push({
          key,
          updated_at: session.updated_at,
        });
      } catch {
        infos.push({ key });
      }
    }
    return infos;
  }

  private async _archive(key: string, runtime: LLMRuntime): Promise<void> {
    if (AutoCompact._isInternalSession(key)) {
      this._archiving.delete(key);
      return;
    }
    try {
      const summary = await this.consolidator.compactIdleSession(key, {
        runtime,
        maxSuffix: RECENT_SUFFIX_MESSAGES,
      });
      if (summary && summary !== '(nothing)') {
        const session = await this.sessions.getOrCreate(key);
        const meta = session.metadata['_last_summary'] as { text: string; last_active: string } | undefined;
        if (meta && typeof meta === 'object') {
          this._summaries.set(key, {
            text: meta.text,
            lastActive: new Date(meta.last_active),
          });
        }
      }
    } catch (err) {
      logger.error({ err, key }, 'Auto-compact: failed');
    } finally {
      this._archiving.delete(key);
    }
  }

  async prepareSession(session: Session, key: string): Promise<[Session, string | null]> {
    if (AutoCompact._isInternalSession(key)) {
      this._archiving.delete(key);
      this._summaries.delete(key);
      return [session, null];
    }
    if (this._archiving.has(key) || this._isExpired(session.updated_at)) {
      logger.info(
        { key, archiving: this._archiving.has(key) },
        'Auto-compact: reloading session',
      );
      session = await this.sessions.getOrCreate(key);
    }
    const entry = this._summaries.get(key);
    if (entry) {
      this._summaries.delete(key);
      return [session, AutoCompact._formatSummary(entry.text, entry.lastActive)];
    }
    const meta = session.metadata['_last_summary'] as { text: string; last_active: string } | undefined;
    if (meta && typeof meta === 'object') {
      return [session, AutoCompact._formatSummary(meta.text, new Date(meta.last_active))];
    }
    return [session, null];
  }
}
