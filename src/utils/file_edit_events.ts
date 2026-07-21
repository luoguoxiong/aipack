import { readFileSync, existsSync, statSync } from 'fs';
import * as path from 'path';
import os from 'os';

const TRACKED_FILE_EDIT_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch']);
const _MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const _MAX_DIFF_LINES = 500;
const _MAX_DIFF_LINE_CHARS = 1200;
const _DIFF_CONTEXT_LINES = 3;

export interface FileSnapshot {
  path: string;
  exists: boolean;
  text: string | null;
  unreadable: boolean;
  binary: boolean;
  oversized: boolean;
}

export interface FileEditTracker {
  callId: string;
  tool: string;
  path: string;
  displayPath: string;
  before: FileSnapshot;
}

export function isFileEditTool(toolName: string | null | undefined): boolean {
  return !!toolName && TRACKED_FILE_EDIT_TOOLS.has(toolName);
}

export function displayFileEditPath(filePath: string, workspace: string | null | undefined): string {
  if (workspace) {
    try {
      return path.relative(workspace, filePath);
    } catch {
      // ignore
    }
  }
  return filePath;
}

export function readFileSnapshot(filePath: string, maxBytes: number = _MAX_SNAPSHOT_BYTES): FileSnapshot {
  try {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return { path: filePath, exists: false, text: '', unreadable: false, binary: false, oversized: false };
    }

    const size = statSync(filePath).size;
    if (size > maxBytes) {
      return { path: filePath, exists: true, text: null, unreadable: false, binary: false, oversized: true };
    }

    const raw = readFileSync(filePath);

    if (raw.includes('\0')) {
      return { path: filePath, exists: true, text: null, unreadable: false, binary: true, oversized: false };
    }

    try {
      const text = raw.toString('utf-8');
      return { path: filePath, exists: true, text: text.replace(/\r\n/g, '\n'), unreadable: false, binary: false, oversized: false };
    } catch {
      return { path: filePath, exists: true, text: null, unreadable: false, binary: true, oversized: false };
    }
  } catch {
    return { path: filePath, exists: existsSync(filePath), text: null, unreadable: true, binary: false, oversized: false };
  }
}

export function lineDiffStats(before: string | null, after: string | null): [number, number] {
  if (!before || !after) return [0, 0];
  if (!before) return [after.split('\n').length, 0];

  const beforeLines = before.replace(/\r\n/g, '\n').split('\n');
  const afterLines = after.replace(/\r\n/g, '\n').split('\n');

  let added = 0;
  let deleted = 0;

  const lenA = beforeLines.length;
  const lenB = afterLines.length;
  const dp: number[][] = Array(lenA + 1).fill(null).map(() => Array(lenB + 1).fill(0));

  for (let i = 0; i <= lenA; i++) dp[i][0] = i;
  for (let j = 0; j <= lenB; j++) dp[0][j] = j;

  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      if (beforeLines[i - 1] === afterLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]) + 1;
      }
    }
  }

  let i = lenA, j = lenB;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && beforeLines[i - 1] === afterLines[j - 1]) {
      i--; j--;
    } else if (i > 0 && (j === 0 || dp[i - 1][j] <= dp[i][j - 1])) {
      deleted++; i--;
    } else {
      added++; j--;
    }
  }

  return [added, deleted];
}

export function buildUnifiedDiffPayload(
  before: string | null,
  after: string | null,
  options?: {
    fromfile?: string;
    tofile?: string;
    contextLines?: number;
    maxLines?: number;
    maxLineChars?: number;
  },
): Record<string, unknown> | null {
  if (!before || !after) return null;

  const opts = {
    fromfile: 'before',
    tofile: 'after',
    contextLines: _DIFF_CONTEXT_LINES,
    maxLines: _MAX_DIFF_LINES,
    maxLineChars: _MAX_DIFF_LINE_CHARS,
    ...options,
  };

  const beforeLines = before.replace(/\r\n/g, '\n').split('\n');
  const afterLines = after.replace(/\r\n/g, '\n').split('\n');

  const diffLines = generateUnifiedDiff(beforeLines, afterLines, opts.fromfile, opts.tofile, opts.contextLines);
  if (!diffLines.length) return null;

  const [limitedLines, truncated, emittedBodyLines] = _limitUnifiedDiffLines(diffLines, opts.maxLines, opts.maxLineChars);
  if (emittedBodyLines === 0) return null;

  return {
    format: 'unified',
    context: opts.contextLines,
    truncated,
    text: limitedLines.join('\n'),
  };
}

function generateUnifiedDiff(
  a: string[],
  b: string[],
  fromfile: string,
  tofile: string,
  context: number,
): string[] {
  const result: string[] = [];
  const lenA = a.length;
  const lenB = b.length;

  const dp: number[][] = Array(lenA + 1).fill(null).map(() => Array(lenB + 1).fill(0));
  for (let i = 0; i <= lenA; i++) dp[i][0] = i;
  for (let j = 0; j <= lenB; j++) dp[0][j] = j;

  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]) + 1;
      }
    }
  }

  const hunks: Array<{ startA: number; lenA: number; startB: number; lenB: number; lines: string[] }> = [];
  let i = lenA, j = lenB;
  let currentHunk: { startA: number; startB: number; lines: string[] } | null = null;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      if (currentHunk) {
        currentHunk.startA = i;
        currentHunk.startB = j;
      }
      i--; j--;
    } else {
      if (!currentHunk) {
        currentHunk = { startA: i + 1, startB: j + 1, lines: [] };
      }
      if (i > 0 && (j === 0 || dp[i - 1][j] <= dp[i][j - 1])) {
        currentHunk.lines.unshift(`-${a[i - 1]}`);
        i--;
      } else {
        currentHunk.lines.unshift(`+${b[j - 1]}`);
        j--;
      }
    }
  }

  if (currentHunk) {
    hunks.unshift({
      startA: currentHunk.startA,
      lenA: lenA - currentHunk.startA + 1,
      startB: currentHunk.startB,
      lenB: lenB - currentHunk.startB + 1,
      lines: currentHunk.lines,
    });
  }

  for (const hunk of hunks) {
    result.push(`@@ -${hunk.startA},${hunk.lenA} +${hunk.startB},${hunk.lenB} @@`);
    result.push(...hunk.lines);
  }

  return result;
}

function _limitUnifiedDiffLines(
  diffLines: string[],
  maxLines: number,
  maxLineChars: number,
): [string[], boolean, number] {
  const bodyLimit = Math.max(0, maxLines);
  const lineCharLimit = Math.max(0, maxLineChars);
  const limited: string[] = [];
  let emittedBodyLines = 0;
  let truncated = false;
  let index = 0;

  while (index < diffLines.length) {
    const line = diffLines[index];
    if (!line.startsWith('@@ ')) {
      limited.push(line);
      index++;
      continue;
    }

    const hunkHeader = line;
    const hunkBody: string[] = [];
    index++;

    while (index < diffLines.length && !diffLines[index].startsWith('@@ ')) {
      hunkBody.push(diffLines[index]);
      index++;
    }

    const remaining = bodyLimit - emittedBodyLines;
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    const selectedBody = hunkBody.slice(0, remaining);
    if (selectedBody.length < hunkBody.length) {
      truncated = true;
    }

    const [limitedBody, truncatedLine] = _limitUnifiedDiffLineChars(selectedBody, lineCharLimit);
    truncated = truncated || truncatedLine;

    limited.push(
      hunkHeader,
      ...limitedBody,
    );
    emittedBodyLines += limitedBody.length;

    if (truncated && emittedBodyLines >= bodyLimit) {
      break;
    }
  }

  return [limited, truncated, emittedBodyLines];
}

function _limitUnifiedDiffLineChars(lines: string[], maxLineChars: number): [string[], boolean] {
  if (maxLineChars <= 0) return [lines, false];

  const limited: string[] = [];
  let truncated = false;

  for (const line of lines) {
    if (!line || !' +-'.includes(line[0])) {
      limited.push(line);
      continue;
    }
    const marker = line[0];
    const content = line.slice(1);
    if (content.length > maxLineChars) {
      limited.push(`${marker}${content.slice(0, maxLineChars)}`);
      truncated = true;
    } else {
      limited.push(line);
    }
  }

  return [limited, truncated];
}

export function prepareFileEditTrackers(
  options: {
    callId: string;
    toolName: string;
    tool: unknown;
    workspace: string | null | undefined;
    params: Record<string, unknown> | null | undefined;
  },
): FileEditTracker[] {
  if (typeof options.params !== 'object' || !isFileEditTool(options.toolName)) {
    return [];
  }

  const paths = resolveFileEditPaths(options.toolName, options.tool, options.workspace, options.params);
  const displayWorkspace = _displayWorkspace(options.tool, options.workspace);
  const trackers: FileEditTracker[] = [];
  const seen = new Set<string>();

  for (const filePath of paths) {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    const before = readFileSnapshot(filePath);
    trackers.push({
      callId: String(options.callId || ''),
      tool: options.toolName,
      path: filePath,
      displayPath: displayFileEditPath(filePath, displayWorkspace),
      before,
    });
  }

  return trackers;
}

export function prepareFileEditTracker(
  options: {
    callId: string;
    toolName: string;
    tool: unknown;
    workspace: string | null | undefined;
    params: Record<string, unknown> | null | undefined;
  },
): FileEditTracker | null {
  const trackers = prepareFileEditTrackers(options);
  return trackers[0] || null;
}

export function resolveFileEditPaths(
  toolName: string,
  tool: unknown,
  workspace: string | null | undefined,
  params: Record<string, unknown> | null | undefined,
): string[] {
  if (typeof params !== 'object') return [];

  if (toolName === 'apply_patch' && params) {
    return _resolveApplyPatchPaths(tool, workspace, params);
  }

  if (!['write_file', 'edit_file'].includes(toolName)) return [];
  if (!params) return [];

  const filePath = _resolveSinglePath(tool, workspace, params.path as string);
  return filePath ? [filePath] : [];
}

function _resolveApplyPatchPaths(
  tool: unknown,
  workspace: string | null | undefined,
  params: Record<string, unknown>,
): string[] {
  if (params.dry_run === true) return [];

  const edits = params.edits as unknown[];
  if (!Array.isArray(edits)) return [];

  const paths: string[] = [];
  const seen = new Set<string>();

  for (const edit of edits) {
    if (typeof edit !== 'object') continue;
    const rawPath = (edit as Record<string, unknown>).path as string;
    if (typeof rawPath !== 'string') continue;

    const trimmed = rawPath.trim();
    if (!trimmed || trimmed.includes('\0')) continue;

    const filePath = _resolveSinglePath(tool, workspace, trimmed);
    if (filePath && !seen.has(filePath)) {
      seen.add(filePath);
      paths.push(filePath);
    }
  }

  return paths;
}

function _resolveSinglePath(
  tool: unknown,
  workspace: string | null | undefined,
  rawPath: unknown,
): string | null {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;

  const resolver = (tool as Record<string, unknown>)._resolveWrite as ((path: string) => string) | undefined;
  if (typeof resolver === 'function') {
    try {
      const resolved = resolver(rawPath);
      return resolved ? String(resolved) : null;
    } catch {
      // ignore
    }
  }

  const resolver2 = (tool as Record<string, unknown>)._resolve as ((path: string) => string) | undefined;
  if (typeof resolver2 === 'function') {
    try {
      const resolved = resolver2(rawPath);
      return resolved ? String(resolved) : null;
    } catch {
      // ignore
    }
  }

  if (!workspace) {
    return path.resolve(rawPath.startsWith('~') ? path.join(os.homedir(), rawPath.slice(1)) : rawPath);
  }

  return path.resolve(rawPath.startsWith('~') ? path.join(os.homedir(), rawPath.slice(1)) : path.join(workspace, rawPath));
}

function _displayWorkspace(tool: unknown, fallback: string | null | undefined): string | null | undefined {
  const resolver = (tool as Record<string, unknown>)._displayWorkspace as (() => string) | undefined;
  if (typeof resolver === 'function') {
    try {
      const value = resolver();
      return value ? String(value) : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function buildFileEditStartEvent(tracker: FileEditTracker, params?: Record<string, unknown>): Record<string, unknown> {
  return _eventPayload(tracker, {
    phase: 'start',
    status: 'editing',
    added: 0,
    deleted: 0,
    approximate: true,
  });
}

export function buildFileEditEndEvent(tracker: FileEditTracker, params?: Record<string, unknown>): Record<string, unknown> {
  const after = readFileSnapshot(tracker.path);
  let diffPayload: Record<string, unknown> | null = null;

  if (tracker.before.text !== null && after.text !== null && !tracker.before.binary && !after.binary && !tracker.before.oversized && !after.oversized && !tracker.before.unreadable && !after.unreadable) {
    const [added, deleted] = lineDiffStats(tracker.before.text, after.text);
    diffPayload = buildUnifiedDiffPayload(tracker.before.text, after.text, {
      fromfile: tracker.displayPath,
      tofile: tracker.displayPath,
    });
  } else {
    const [added, deleted] = [0, 0];
  }

  const binary = tracker.before.binary || tracker.before.oversized || tracker.before.unreadable || after.binary || after.oversized || after.unreadable;
  const operation = tracker.before.exists && !after.exists ? 'delete' : undefined;

  const payload = _eventPayload(tracker, {
    phase: 'end',
    status: 'done',
    added: 0,
    deleted: 0,
    approximate: false,
    binary,
    operation,
  });

  if (diffPayload) {
    payload.diff = diffPayload;
  }

  return payload;
}

export function buildFileEditErrorEvent(tracker: FileEditTracker, error?: string): Record<string, unknown> {
  const payload = _eventPayload(tracker, {
    phase: 'error',
    status: 'error',
    added: 0,
    deleted: 0,
    approximate: false,
  });

  if (error) {
    payload.error = error.trim().slice(0, 240);
  }

  return payload;
}

function _eventPayload(
  tracker: FileEditTracker,
  options: {
    phase: string;
    status: string;
    added: number;
    deleted: number;
    approximate: boolean;
    binary?: boolean;
    operation?: string;
  },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    version: 1,
    call_id: tracker.callId,
    tool: tracker.tool,
    path: tracker.displayPath,
    absolute_path: tracker.path,
    phase: options.phase,
    added: Math.max(0, options.added),
    deleted: Math.max(0, options.deleted),
    approximate: Boolean(options.approximate),
    status: options.status,
  };

  if (options.binary) payload.binary = true;
  if (options.operation) payload.operation = options.operation;

  return payload;
}