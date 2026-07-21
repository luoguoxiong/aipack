import type { AgentLoop } from '../agent/loop.js';
import type { Session } from '../session/manager.js';
import { SessionSnapshot, SessionInfo } from './types.js';

const RESERVED_MESSAGE_KEYS = new Set(["role", "content", "runtime_context"]);
const VALID_ROLES = new Set(["user", "assistant", "tool", "system"]);

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function createSessionSnapshot(session: Session, includeRuntimeContext: boolean = false): SessionSnapshot {
  let messages = deepClone(session.messages) as unknown as Record<string, unknown>[];
  if (!includeRuntimeContext) {
    messages = messages.map(m => {
      const cleaned = { ...m };
      delete (cleaned as any).runtime_context;
      return cleaned;
    });
  }

  return {
    key: session.key,
    messages,
    metadata: deepClone(session.metadata),
    created_at: session.created_at || null,
    updated_at: session.updated_at || null,
    to_dict() {
      return {
        key: this.key,
        created_at: this.created_at,
        updated_at: this.updated_at,
        metadata: deepClone(this.metadata),
        messages: deepClone(this.messages),
      };
    },
  };
}

export class SessionClient {
  constructor(private _loop: AgentLoop) {}

  async ingest(
    session_key: string,
    messages: Iterable<Record<string, unknown>>,
    options?: {
      metadata?: Record<string, unknown>;
      source?: string;
      save?: boolean;
    },
  ): Promise<SessionSnapshot> {
    const sessions = (this._loop as any).sessionManager || this._loop.getSessionManager?.();
    const session = await sessions.getOrCreate?.(session_key);
    if (!session) throw new Error(`Could not get or create session: ${session_key}`);
    
    if (options?.metadata) {
      Object.assign(session.metadata, deepClone(options.metadata));
    }

    for (const raw of messages) {
      if (!raw.hasOwnProperty("role")) {
        throw new Error("ingested messages must include a role");
      }
      if (!raw.hasOwnProperty("content")) {
        throw new Error("ingested messages must include content");
      }
      const role = String(raw["role"]).trim();
      if (!VALID_ROLES.has(role)) {
        throw new Error(`unsupported message role: ${role}`);
      }
      const extra: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (!RESERVED_MESSAGE_KEYS.has(key)) {
          extra[key] = deepClone(value);
        }
      }
      if (options?.source && !extra.hasOwnProperty("source")) {
        extra["source"] = options.source;
      }
      session.messages.push({
        role,
        content: deepClone(raw["content"]),
        timestamp: new Date().toISOString(),
        ...extra,
      } as any);
    }

    if (options?.save !== false) {
      await sessions.save?.(session_key);
    }
    return createSessionSnapshot(session);
  }

  async get(session_key: string): Promise<SessionSnapshot | null> {
    const sessions = (this._loop as any).sessionManager || this._loop.getSessionManager?.();
    const session = await sessions.get?.(session_key);
    if (session) {
      return createSessionSnapshot(session);
    }
    return null;
  }

  async list(): Promise<SessionInfo[]> {
    const sessions = (this._loop as any).sessionManager || this._loop.getSessionManager?.();
    const rows = (await sessions.listSessions?.() || []) as Array<Record<string, unknown>>;
    return rows.map(row => ({
      key: String(row.key || ""),
      created_at: String(row.created_at || "") || null,
      updated_at: String(row.updated_at || "") || null,
      title: String(row.title || ""),
      preview: String(row.preview || ""),
      path: (row.path !== undefined && row.path !== null) ? String(row.path) : null,
      to_dict() {
        return {
          key: this.key,
          created_at: this.created_at,
          updated_at: this.updated_at,
          title: this.title,
          preview: this.preview,
          path: this.path,
        };
      },
    }));
  }

  async export(session_key: string): Promise<SessionSnapshot | null> {
    const sessions = (this._loop as any).sessionManager || this._loop.getSessionManager?.();
    const session = await sessions.get?.(session_key);
    if (session) {
      return createSessionSnapshot(session, true);
    }
    return null;
  }

  async restore(
    snapshot: SessionSnapshot,
    options?: {
      session_key?: string;
      save?: boolean;
    },
  ): Promise<SessionSnapshot> {
    const key = options?.session_key || snapshot.key;
    if (!key) {
      throw new Error("restored snapshots must include a session key");
    }
    const sessions = (this._loop as any).sessionManager || this._loop.getSessionManager?.();
    const session = await sessions.getOrCreate?.(key);
    if (!session) throw new Error(`Could not get or create session: ${key}`);
    
    if (session.messages.length > 0) {
      throw new Error(`restore target session is not empty: ${key}`);
    }

    const prepared: Array<[string, unknown, Record<string, unknown>]> = [];
    for (const raw of snapshot.messages) {
      if (!raw.hasOwnProperty("role") || !raw.hasOwnProperty("content")) {
        throw new Error("restored messages must include role and content");
      }
      const role = String(raw["role"]).trim();
      if (!VALID_ROLES.has(role)) {
        throw new Error(`unsupported message role: ${role}`);
      }
      const extra: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(raw)) {
        if (field !== "role" && field !== "content") {
          extra[field] = deepClone(value);
        }
      }
      prepared.push([role, deepClone(raw["content"]), extra]);
    }

    Object.assign(session.metadata, deepClone(snapshot.metadata));
    for (const [role, content, extra] of prepared) {
      session.messages.push({
        role,
        content,
        timestamp: new Date().toISOString(),
        ...extra,
      } as any);
    }

    if (options?.save !== false) {
      await sessions.save?.(key);
    }
    return createSessionSnapshot(session);
  }

  async clear(session_key: string): Promise<SessionSnapshot> {
    const sessions = (this._loop as any).sessionManager || this._loop.getSessionManager?.();
    const session = await sessions.getOrCreate?.(session_key);
    if (!session) throw new Error(`Could not get or create session: ${session_key}`);
    
    session.messages = [];
    await sessions.save?.(session_key);
    return createSessionSnapshot(session);
  }

  async delete(session_key: string): Promise<boolean> {
    const sessions = (this._loop as any).sessionManager || this._loop.getSessionManager?.();
    return (await sessions.deleteSession?.(session_key)) || false;
  }

  async flush(): Promise<number> {
    const sessions = (this._loop as any).sessionManager || this._loop.getSessionManager?.();
    return (await sessions.flushAll?.()) || 0;
  }

  private _snapshotFromPayload(
    payload: Record<string, unknown>,
    includeRuntimeContext: boolean = false,
  ): SessionSnapshot {
    const messages = ((payload.messages as Record<string, unknown>[]) || []).map(m => deepClone(m));
    if (!includeRuntimeContext) {
      messages.forEach(m => delete (m as any).runtime_context);
    }
    return {
      key: String(payload.key || ""),
      messages,
      metadata: deepClone(payload.metadata as Record<string, unknown> || {}),
      created_at: payload.created_at as string || null,
      updated_at: payload.updated_at as string || null,
      to_dict() {
        return {
          key: this.key,
          created_at: this.created_at,
          updated_at: this.updated_at,
          metadata: deepClone(this.metadata),
          messages: deepClone(this.messages),
        };
      },
    };
  }
}

export class MemoryClient {
  constructor(private _loop: AgentLoop) {}

  read(): string {
    return ((this._loop as any).context?.memory?.readMemory?.() as string) || "";
  }

  write(text: string): void {
    (this._loop as any).context?.memory?.writeMemory?.(text);
  }

  appendHistory(text: string, options?: { session_key?: string }): number {
    return ((this._loop as any).context?.memory?.appendHistory?.(text, options?.session_key) as number) || 0;
  }

  readHistory(options?: { session_key?: string }): Record<string, unknown>[] {
    const entries = ((this._loop as any).context?.memory?.readUnprocessedHistory?.(0) as Record<string, unknown>[]) || [];
    if (options?.session_key) {
      return entries.filter(entry => entry.session_key === options.session_key);
    }
    return deepClone(entries);
  }
}

export class RuntimeClient {
  constructor(private _loop: AgentLoop) {}

  get model(): string {
    return ((this._loop as any).model as string) || "";
  }

  get workspace(): string {
    return ((this._loop as any).workspace as string) || "";
  }

  async compactSession(session_key: string): Promise<SessionSnapshot> {
    const sessions = (this._loop as any).sessionManager || this._loop.getSessionManager?.();
    const session = await sessions.getOrCreate?.(session_key);
    if (!session) throw new Error(`Could not get or create session: ${session_key}`);
    
    const runtime = (this._loop as any).llmRuntime?.() || (this._loop as any).getLLMRuntime?.();
    const consolidator = (this._loop as any).consolidator;
    
    if (runtime && consolidator) {
      await consolidator.maybeConsolidateByTokens?.(session, runtime);
    }
    return createSessionSnapshot(session);
  }

  async compactIdleSession(session_key: string, options?: { max_suffix?: number }): Promise<string | null> {
    const runtime = (this._loop as any).llmRuntime?.() || (this._loop as any).getLLMRuntime?.();
    const consolidator = (this._loop as any).consolidator;
    
    if (!runtime || !consolidator) return null;
    return consolidator.compactIdleSession?.(session_key, runtime, options?.max_suffix || 8) || null;
  }
}