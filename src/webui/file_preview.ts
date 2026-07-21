import fs from 'fs';
import path from 'path';
import { URL } from 'url';

export const MAX_FILE_PREVIEW_BYTES = 384 * 1024;

export class WebUIFilePreviewError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'WebUIFilePreviewError';
  }
}

export interface FilePreviewPayload {
  path: string;
  display_path: string;
  project_path: string;
  language: string;
  content: string;
  size: number;
  truncated: boolean;
}

export interface WorkspaceScope {
  project_path: string;
  restrict_to_workspace: boolean;
}

function cleanPreviewPath(rawPath: string | null | undefined): string {
  if (!rawPath) return '';
  let value = rawPath.trim();
  if (!value) return '';
  if (value.startsWith('file://')) {
    const parsed = new URL(value);
    value = decodeURIComponent(parsed.pathname);
    if (/^\/[A-Za-z]:[\\/]/.test(value)) {
      value = value.slice(1);
    }
  } else {
    value = decodeURIComponent(value);
  }
  value = value.split('?')[0].split('#')[0].trim();
  if (!/^[A-Za-z]:[\\/]/.test(value)) {
    value = value.replace(/:\d+(?::\d+)?$/, '');
  }
  return value;
}

function displayPath(filePath: string, root: string): string {
  try {
    const rel = path.relative(root, filePath);
    if (rel.startsWith('..')) {
      return filePath.split(path.sep).join('/');
    }
    return rel.split(path.sep).join('/');
  } catch {
    return filePath.split(path.sep).join('/');
  }
}

function languageForPath(filePath: string): string {
  const name = path.basename(filePath).toLowerCase();
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  if (name === 'dockerfile') return 'dockerfile';
  const langMap: Record<string, string> = {
    cjs: 'javascript',
    css: 'css',
    cts: 'typescript',
    html: 'html',
    js: 'javascript',
    json: 'json',
    jsonl: 'json',
    jsx: 'jsx',
    md: 'markdown',
    mdx: 'markdown',
    mjs: 'javascript',
    mts: 'typescript',
    py: 'python',
    pyi: 'python',
    scss: 'scss',
    sh: 'bash',
    toml: 'toml',
    ts: 'typescript',
    tsx: 'tsx',
    yaml: 'yaml',
    yml: 'yaml',
  };
  return langMap[ext] || ext || 'text';
}

function resolveAllowedPath(
  inputPath: string,
  options: {
    workspace: string;
    allowedRoot?: string | null;
    strict?: boolean;
  },
): string {
  let resolved: string;
  if (path.isAbsolute(inputPath)) {
    resolved = path.resolve(inputPath);
  } else {
    resolved = path.resolve(options.workspace, inputPath);
  }

  if (options.allowedRoot) {
    const rel = path.relative(options.allowedRoot, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new WebUIFilePreviewError(403, 'file is outside the current workspace');
    }
  }

  if (!fs.existsSync(resolved)) {
    throw new WebUIFilePreviewError(404, 'file not found');
  }

  return resolved;
}

function resolvePreviewPath(
  rawPath: string | null | undefined,
  scope: WorkspaceScope,
): string {
  const p = cleanPreviewPath(rawPath);
  if (!p) throw new WebUIFilePreviewError(400, 'missing path');
  if (p.length > 4096) throw new WebUIFilePreviewError(400, 'path is too long');

  try {
    const resolved = resolveAllowedPath(p, {
      workspace: scope.project_path,
      allowedRoot: scope.restrict_to_workspace ? scope.project_path : null,
      strict: true,
    });
    if (!fs.statSync(resolved).isFile()) {
      throw new WebUIFilePreviewError(404, 'file not found');
    }
    return resolved;
  } catch (err) {
    if (err instanceof WebUIFilePreviewError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WebUIFilePreviewError(404, 'file not found');
    }
    throw new WebUIFilePreviewError(400, 'invalid path');
  }
}

export function filePreviewPayload(
  rawPath: string | null | undefined,
  options: {
    scope: WorkspaceScope;
    maxBytes?: number;
  },
): FilePreviewPayload {
  const maxBytes = options.maxBytes ?? MAX_FILE_PREVIEW_BYTES;
  const resolved = resolvePreviewPath(rawPath, options.scope);

  let raw: Buffer;
  try {
    const fd = fs.openSync(resolved, 'r');
    raw = Buffer.alloc(maxBytes + 1);
    const bytesRead = fs.readSync(fd, raw, 0, maxBytes + 1, 0);
    fs.closeSync(fd);
    raw = raw.slice(0, bytesRead);
  } catch {
    throw new WebUIFilePreviewError(500, 'failed to read file');
  }

  const prefix = raw.slice(0, 4096);
  if (prefix.includes('\0')) {
    throw new WebUIFilePreviewError(415, 'binary files cannot be previewed');
  }

  const truncated = raw.length > maxBytes;
  const previewBytes = raw.slice(0, maxBytes);
  let content: string;
  try {
    content = previewBytes.toString('utf-8');
  } catch {
    content = previewBytes.toString('utf-8');
  }

  const displayPathStr = displayPath(resolved, options.scope.project_path);
  const stat = fs.statSync(resolved);
  return {
    path: resolved,
    display_path: displayPathStr,
    project_path: options.scope.project_path,
    language: languageForPath(resolved),
    content,
    size: stat.size,
    truncated,
  };
}

export function filePreviewAvailabilityPayload(
  rawPath: string | null | undefined,
  options: { scope: WorkspaceScope },
): { available: boolean } {
  const resolved = resolvePreviewPath(rawPath, options.scope);
  let prefix: Buffer;
  try {
    const fd = fs.openSync(resolved, 'r');
    prefix = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, prefix, 0, 4096, 0);
    fs.closeSync(fd);
    prefix = prefix.slice(0, bytesRead);
  } catch {
    throw new WebUIFilePreviewError(500, 'failed to read file');
  }
  if (prefix.includes('\0')) {
    throw new WebUIFilePreviewError(415, 'binary files cannot be previewed');
  }
  return { available: true };
}
