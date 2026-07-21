import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { getProjectConfigDir } from '../config/paths.js';

export interface SessionMessage {
  role: string;
  content: string | unknown[];
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface Session {
  key: string;
  messages: SessionMessage[];
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
}

const UNIFIED_SESSION_KEY = 'unified:default';

export class SessionStore {
  private sessions: Map<string, Session> = new Map();
  private baseDir: string;
  private persist: boolean;

  constructor(baseDir?: string, persist = true) {
    this.baseDir = baseDir || path.join(getProjectConfigDir(), 'sessions');
    this.persist = persist;
  }

  async getOrCreate(sessionKey: string): Promise<Session> {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = await this.loadFromDisk(sessionKey);
      if (!session) {
        session = {
          key: sessionKey,
          messages: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          metadata: {},
        };
      }
      this.sessions.set(sessionKey, session);
    }
    return session;
  }

  async get(sessionKey: string): Promise<Session | undefined> {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = await this.loadFromDisk(sessionKey);
      if (session) {
        this.sessions.set(sessionKey, session);
      }
    }
    return session;
  }

  async appendMessage(sessionKey: string, message: Omit<SessionMessage, 'timestamp'>): Promise<void> {
    const session = await this.getOrCreate(sessionKey);
    const msg: SessionMessage = {
      ...message,
      timestamp: new Date().toISOString(),
    };
    session.messages.push(msg);
    session.updated_at = new Date().toISOString();
    await this.save(sessionKey);
  }

  async appendMessages(sessionKey: string, messages: Omit<SessionMessage, 'timestamp'>[]): Promise<void> {
    const session = await this.getOrCreate(sessionKey);
    const now = new Date().toISOString();
    for (const msg of messages) {
      session.messages.push({ ...msg, timestamp: now });
    }
    session.updated_at = now;
    await this.save(sessionKey);
  }

  async setMessages(sessionKey: string, messages: SessionMessage[]): Promise<void> {
    const session = await this.getOrCreate(sessionKey);
    session.messages = messages;
    session.updated_at = new Date().toISOString();
    await this.save(sessionKey);
  }

  async save(sessionKey: string): Promise<void> {
    if (!this.persist) return;

    const session = this.sessions.get(sessionKey);
    if (!session) return;

    try {
      await fs.mkdir(this.baseDir, { recursive: true });
      const filePath = this.getSessionPath(sessionKey);
      await fs.writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
    } catch (err) {
      logger.error({ err, session_key: sessionKey }, 'Failed to persist session');
    }
  }

  async delete(sessionKey: string): Promise<boolean> {
    this.sessions.delete(sessionKey);
    if (!this.persist) return true;

    try {
      const filePath = this.getSessionPath(sessionKey);
      await fs.unlink(filePath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return true;
      }
      logger.error({ err, session_key: sessionKey }, 'Failed to delete session');
      return false;
    }
  }

  async list(): Promise<string[]> {
    const fromMemory = Array.from(this.sessions.keys());

    if (this.persist) {
      try {
        const files = await fs.readdir(this.baseDir);
        const fromDisk: string[] = [];
        for (const f of files) {
          if (!f.endsWith('.json')) continue;
          try {
            const filePath = path.join(this.baseDir, f);
            const data = await fs.readFile(filePath, 'utf-8');
            const session = JSON.parse(data) as Session;
            if (session && typeof session.key === 'string' && session.key) {
              fromDisk.push(session.key);
            }
          } catch {
            // skip invalid or unreadable session file
          }
        }
        return [...new Set([...fromMemory, ...fromDisk])];
      } catch {
        return fromMemory;
      }
    }

    return fromMemory;
  }

  private getSessionPath(sessionKey: string): string {
    const safeKey = crypto.createHash('sha256').update(sessionKey).digest('hex').slice(0, 32);
    return path.join(this.baseDir, `${safeKey}.json`);
  }

  private async loadFromDisk(sessionKey: string): Promise<Session | undefined> {
    if (!this.persist) return undefined;

    try {
      const filePath = this.getSessionPath(sessionKey);
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as Session;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.debug({ err, session_key: sessionKey }, 'Failed to load session from disk');
      }
      return undefined;
    }
  }
}

export class SessionManager {
  private store: SessionStore;
  private maxMessages: number;
  private autoCompact: boolean;

  constructor(options?: {
    baseDir?: string;
    persist?: boolean;
    maxMessages?: number;
    autoCompact?: boolean;
  }) {
    this.store = new SessionStore(options?.baseDir, options?.persist);
    this.maxMessages = options?.maxMessages ?? 200;
    this.autoCompact = options?.autoCompact ?? true;
  }

  async getSession(sessionKey: string): Promise<Session> {
    return this.store.getOrCreate(sessionKey);
  }

  async getMessages(sessionKey: string): Promise<SessionMessage[]> {
    const session = await this.store.getOrCreate(sessionKey);
    return [...session.messages];
  }

  async addMessage(sessionKey: string, message: Omit<SessionMessage, 'timestamp'>): Promise<void> {
    await this.store.appendMessage(sessionKey, message);
    await this.maybeCompact(sessionKey);
  }

  async addMessages(sessionKey: string, messages: Omit<SessionMessage, 'timestamp'>[]): Promise<void> {
    await this.store.appendMessages(sessionKey, messages);
    await this.maybeCompact(sessionKey);
  }

  async replaceMessages(sessionKey: string, messages: SessionMessage[]): Promise<void> {
    await this.store.setMessages(sessionKey, messages);
  }

  async deleteSession(sessionKey: string): Promise<boolean> {
    return this.store.delete(sessionKey);
  }

  async listSessions(): Promise<string[]> {
    return this.store.list();
  }

  private async maybeCompact(sessionKey: string): Promise<void> {
    if (!this.autoCompact) return;
    
    const session = await this.store.getOrCreate(sessionKey);
    if (session.messages.length > this.maxMessages) {
      logger.debug(
        { session_key: sessionKey, count: session.messages.length, max: this.maxMessages },
        'Session message count exceeds limit, compacting',
      );
      const keep = Math.floor(this.maxMessages * 0.6);
      const toRemove = session.messages.length - keep;
      session.messages = session.messages.slice(toRemove);
      session.updated_at = new Date().toISOString();
      await this.store.save(sessionKey);
    }
  }
}

export { UNIFIED_SESSION_KEY };
