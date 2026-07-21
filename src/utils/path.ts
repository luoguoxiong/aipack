import path from 'path';
import os from 'os';

export function normalizePath(p: string): string {
  return path.normalize(p);
}

export function isAbsolutePath(p: string): boolean {
  return path.isAbsolute(p);
}

export function ensureAbsolutePath(p: string, cwd?: string): string {
  if (isAbsolutePath(p)) {
    return normalizePath(p);
  }
  return normalizePath(path.join(cwd || process.cwd(), p));
}

export function resolveHomePath(p: string): string {
  if (p.startsWith('~')) {
    return normalizePath(path.join(os.homedir(), p.slice(1)));
  }
  return normalizePath(p);
}

export function relativePath(from: string, to: string): string {
  return path.relative(from, to);
}

export function commonPrefix(paths: string[]): string {
  if (paths.length === 0) {
    return '';
  }
  let prefix = paths[0];
  for (let i = 1; i < paths.length; i++) {
    while (paths[i].indexOf(prefix) !== 0) {
      prefix = prefix.slice(0, -1);
      if (!prefix) {
        return '';
      }
    }
  }
  const lastSlash = prefix.lastIndexOf(path.sep);
  return prefix.slice(0, lastSlash + 1);
}

export function safeBasename(p: string): string {
  const name = path.basename(p);
  return name.replace(/[\\/:*?"<>|]/g, '_');
}

export function safeDirname(p: string): string {
  const dir = path.dirname(p);
  return dir.replace(/[\\/:*?"<>|]/g, '_');
}

export function escapePathForRegex(p: string): string {
  return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function hasPathTraversal(p: string): boolean {
  const normalized = normalizePath(p);
  return normalized.includes('..');
}

export function truncatePath(p: string, maxLength: number): string {
  if (p.length <= maxLength) {
    return p;
  }
  const separator = path.sep;
  const parts = p.split(separator);
  let result = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    const candidate = part + separator + result;
    if (candidate.length <= maxLength) {
      result = candidate;
    } else {
      result = '...' + separator + result;
      break;
    }
  }
  return result.trimEnd();
}

export function abbreviatePath(p: string, maxLen: number): string {
  if (p.length <= maxLen) return p;
  return truncatePath(p, maxLen);
}