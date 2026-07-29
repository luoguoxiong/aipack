import path from 'path';
import { homedir } from 'os';
import type { StorageAdapter, SessionData, SessionTreeEntry, SessionMetadata, SessionStorage, SessionContext, MessageEntry } from './types';
import { createMemoryStorage, createMemorySessionStorage } from './memory';
import { createFileStorage } from './file';
import type { AgentMessage } from "../pi/agent";
import type { Usage } from "../pi/ai";

function resolveStoragePath(storagePath: string): string {
  if (storagePath.startsWith('~')) {
    return path.join(homedir(), storagePath.slice(1));
  }
  if (path.isAbsolute(storagePath)) {
    return storagePath;
  }
  return path.join(process.cwd(), storagePath);
}

export interface SessionManagerOptions {
  storage?: StorageAdapter;
  storageType?: 'memory' | 'file';
  storagePath?: string;
  maxAge?: number;
}

function deriveSessionContextState(pathEntries: readonly SessionTreeEntry[]): Omit<SessionContext, "messages"> {
  let model: { provider: string; modelId: string } | null = null;

  for (const entry of pathEntries) {
    if (entry.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      model = { provider: entry.message.provider as string, modelId: entry.message.model as string };
    }
  }

  return { model };
}

function buildSessionContext(pathEntries: readonly SessionTreeEntry[]): SessionContext {
  const state = deriveSessionContextState(pathEntries);
  const messages = pathEntries
    .filter((entry): entry is MessageEntry => entry.type === "message")
    .map(entry => entry.message);
  return { ...state, messages };
}

export class SessionManager {
  private storage: StorageAdapter;

  constructor(options: SessionManagerOptions = {}) {
    if (options.storage) {
      this.storage = options.storage;
    } else if (options.storageType === 'file' && options.storagePath) {
      const resolvedPath = resolveStoragePath(options.storagePath);
      this.storage = createFileStorage({ baseDir: resolvedPath });
    } else {
      this.storage = createMemoryStorage();
    }
  }

  getSessionStorage(sessionKey: string): SessionStorage<SessionMetadata> {
    return createMemorySessionStorage(this.storage, sessionKey);
  }

  async saveSession(key: string, messages: unknown[], metadata: Record<string, unknown> = {}): Promise<void> {
    const existing = await this.storage.loadSession(key);
    
    const session: SessionData = {
      key,
      entries: existing?.entries || [],
      leafId: existing?.leafId || null,
      metadata,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    await this.storage.saveSession(session);
  }

  async loadSession(key: string): Promise<SessionData | null> {
    return this.storage.loadSession(key);
  }

  async deleteSession(key: string): Promise<boolean> {
    return this.storage.deleteSession(key);
  }

  async listSessions(): Promise<string[]> {
    return this.storage.listSessions();
  }

  async getAllSessions(): Promise<SessionData[]> {
    return this.storage.getAllSessions();
  }

  async getSessionInfo(key: string): Promise<{ key: string; messageCount: number; createdAt: string; updatedAt: string } | null> {
    const session = await this.storage.loadSession(key);
    if (!session) return null;
    
    const messageCount = session.entries.filter(e => e.type === 'message').length;
    
    return {
      key: session.key,
      messageCount,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  async clearAll(): Promise<void> {
    const keys = await this.storage.listSessions();
    for (const key of keys) {
      await this.storage.deleteSession(key);
    }
  }

  getStorage(): StorageAdapter {
    return this.storage;
  }
}

export function createSessionManager(options?: SessionManagerOptions): SessionManager {
  return new SessionManager(options);
}
