import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';

export interface ReadState {
  mtime: number;
  offset: number;
  limit: number | null;
  content_hash: string | null;
  can_dedup: boolean;
}

function hashFile(p: string): string | null {
  try {
    const content = fs.readFileSync(p);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

export class FileStates {
  private _state: Map<string, ReadState> = new Map();

  recordRead(filePath: string, offset = 1, limit: number | null = null): void {
    const p = path.resolve(filePath);
    let mtime: number;
    try {
      mtime = fs.statSync(p).mtimeMs;
    } catch {
      return;
    }
    this._state.set(p, {
      mtime,
      offset,
      limit,
      content_hash: hashFile(p),
      can_dedup: true,
    });
  }

  recordWrite(filePath: string): void {
    const p = path.resolve(filePath);
    let mtime: number;
    try {
      mtime = fs.statSync(p).mtimeMs;
    } catch {
      this._state.delete(p);
      return;
    }
    this._state.set(p, {
      mtime,
      offset: 1,
      limit: null,
      content_hash: hashFile(p),
      can_dedup: false,
    });
  }

  checkRead(filePath: string): string | null {
    const p = path.resolve(filePath);
    const entry = this._state.get(p);
    if (!entry) {
      return 'Warning: file has not been read yet. Read it first to verify content before editing.';
    }
    let currentMtime: number;
    try {
      currentMtime = fs.statSync(p).mtimeMs;
    } catch {
      return null;
    }
    if (currentMtime !== entry.mtime) {
      if (entry.content_hash && hashFile(p) === entry.content_hash) {
        entry.mtime = currentMtime;
        return null;
      }
      return 'Warning: file has been modified since last read. Re-read to verify content before editing.';
    }
    if (entry.content_hash && hashFile(p) !== entry.content_hash) {
      return 'Warning: file has been modified since last read. Re-read to verify content before editing.';
    }
    return null;
  }

  isUnchanged(filePath: string, offset = 1, limit: number | null = null): boolean {
    const p = path.resolve(filePath);
    const entry = this._state.get(p);
    if (!entry) return false;
    if (!entry.can_dedup) return false;
    if (entry.offset !== offset || entry.limit !== limit) return false;
    let currentMtime: number;
    try {
      currentMtime = fs.statSync(p).mtimeMs;
    } catch {
      return false;
    }
    if (currentMtime !== entry.mtime) {
      const currentHash = hashFile(p);
      if (currentHash !== entry.content_hash) {
        entry.can_dedup = false;
        return false;
      }
      entry.can_dedup = false;
      return true;
    }
    return true;
  }

  get(filePath: string): ReadState | null {
    return this._state.get(path.resolve(filePath)) ?? null;
  }

  clear(): void {
    this._state.clear();
  }
}

export class FileStateStore {
  private _states_by_key: Map<string, FileStates> = new Map();

  forSession(sessionKey: string | null): FileStates {
    const key = sessionKey ?? '__default__';
    let states = this._states_by_key.get(key);
    if (!states) {
      states = new FileStates();
      this._states_by_key.set(key, states);
    }
    return states;
  }

  clear(): void {
    this._states_by_key.clear();
  }
}

const _current_file_states = new AsyncLocalStorage<FileStates | null>();

export function currentFileStates(defaultStates: FileStates): FileStates {
  return _current_file_states.getStore() ?? defaultStates;
}

export function bindFileStates(fileStates: FileStates): void {
  _current_file_states.enterWith(fileStates);
}

export function runWithFileStates<T>(fileStates: FileStates, fn: () => T): T {
  return _current_file_states.run(fileStates, fn);
}

const _default = new FileStates();

export function recordRead(filePath: string, offset = 1, limit: number | null = null): void {
  _default.recordRead(filePath, offset, limit);
}

export function recordWrite(filePath: string): void {
  _default.recordWrite(filePath);
}

export function checkRead(filePath: string): string | null {
  return _default.checkRead(filePath);
}

export function isUnchanged(filePath: string, offset = 1, limit: number | null = null): boolean {
  return _default.isUnchanged(filePath, offset, limit);
}

export function clearFileStates(): void {
  _default.clear();
}
