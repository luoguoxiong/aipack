import type { StorageAdapter, SessionData, SessionTreeEntry, SessionMetadata, SessionStorage } from './types';

export class MemoryStorageAdapter implements StorageAdapter {
  private sessions = new Map<string, SessionData>();

  async loadSession(key: string): Promise<SessionData | null> {
    return this.sessions.get(key) || null;
  }

  async saveSession(session: SessionData): Promise<void> {
    this.sessions.set(session.key, session);
  }

  async deleteSession(key: string): Promise<boolean> {
    return this.sessions.delete(key);
  }

  async listSessions(): Promise<string[]> {
    return Array.from(this.sessions.keys());
  }

  async getAllSessions(): Promise<SessionData[]> {
    return Array.from(this.sessions.values());
  }
}

export class MemorySessionStorage implements SessionStorage<SessionMetadata> {
  private adapter: StorageAdapter;
  private sessionKey: string;

  constructor(adapter: StorageAdapter, sessionKey: string) {
    this.adapter = adapter;
    this.sessionKey = sessionKey;
  }

  async getMetadata(): Promise<SessionMetadata> {
    const session = await this.adapter.loadSession(this.sessionKey);
    return {
      id: this.sessionKey,
      createdAt: session?.createdAt || new Date().toISOString(),
      updatedAt: session?.updatedAt || new Date().toISOString(),
    };
  }

  async getLeafId(): Promise<string | null> {
    const session = await this.adapter.loadSession(this.sessionKey);
    return session?.leafId || null;
  }

  async setLeafId(leafId: string | null): Promise<void> {
    let session = await this.adapter.loadSession(this.sessionKey);
    if (!session) {
      session = {
        key: this.sessionKey,
        entries: [],
        leafId: null,
        metadata: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    session.leafId = leafId;
    session.updatedAt = new Date().toISOString();
    await this.adapter.saveSession(session);
  }

  async createEntryId(): Promise<string> {
    return `${this.sessionKey}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  async appendEntry(entry: SessionTreeEntry): Promise<void> {
    let session = await this.adapter.loadSession(this.sessionKey);
    if (!session) {
      session = {
        key: this.sessionKey,
        entries: [],
        leafId: null,
        metadata: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    session.entries.push(entry);
    session.leafId = entry.id;
    session.updatedAt = new Date().toISOString();
    await this.adapter.saveSession(session);
  }

  async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    const session = await this.adapter.loadSession(this.sessionKey);
    return session?.entries.find(e => e.id === id);
  }

  async findEntries<TType extends SessionTreeEntry["type"]>(
    type: TType,
  ): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
    const session = await this.adapter.loadSession(this.sessionKey);
    return (session?.entries || []).filter(e => e.type === type) as Array<Extract<SessionTreeEntry, { type: TType }>>;
  }

  async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
    const session = await this.adapter.loadSession(this.sessionKey);
    if (!session || !leafId) return [];

    const entries: SessionTreeEntry[] = [];
    let currentId: string | null = leafId;

    while (currentId) {
      const entry = session.entries.find(e => e.id === currentId);
      if (!entry) break;
      entries.unshift(entry);
      currentId = entry.parentId;
    }

    return entries;
  }

  async getEntries(): Promise<SessionTreeEntry[]> {
    const session = await this.adapter.loadSession(this.sessionKey);
    return session?.entries || [];
  }
}

export function createMemoryStorage(): MemoryStorageAdapter {
  return new MemoryStorageAdapter();
}

export function createMemorySessionStorage(adapter: StorageAdapter, sessionKey: string): MemorySessionStorage {
  return new MemorySessionStorage(adapter, sessionKey);
}
