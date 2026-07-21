import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getProjectConfigDir } from '../config/paths.js';

const INDEX_VERSION = 2;
const INDEX_FILENAME = '.webui_session_index.json';
const WEBUI_ACTIVITY_MTIME_NS = 'webui_activity_mtime_ns';
const WEBUI_ACTIVITY_SIZE = 'webui_activity_size';
const VISIBLE_TRANSCRIPT_ROLES = new Set(['user', 'assistant']);
const SESSION_LIST_PREVIEW_MAX_CHARS = 500;
const SESSION_LIST_PREVIEW_MAX_RECORDS = 20;

export interface WebUISessionRow {
  key: string;
  created_at: string;
  updated_at: string;
  title: string;
  preview: string;
  path: string;
}

interface IndexedRow extends WebUISessionRow {
  file: string;
  mtime_ns: number;
  size: number;
  [WEBUI_ACTIVITY_MTIME_NS]: number;
  [WEBUI_ACTIVITY_SIZE]: number;
}

function getWebuiDir(): string {
  return path.join(getProjectConfigDir(), 'webui');
}

function getSessionsDir(): string {
  return path.join(getProjectConfigDir(), 'sessions');
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function isHiddenHistoryMessage(_item: Record<string, unknown>): boolean {
  return false;
}

function messagePreviewText(item: Record<string, unknown>): string {
  const content = item.content;
  if (typeof content === 'string') {
    return content.slice(0, 200);
  }
  return '';
}

function metadataTitle(metadata: Record<string, unknown>): string {
  const title = metadata?.title;
  if (typeof title === 'string' && title.trim()) {
    return title.trim();
  }
  return '';
}

function indexPath(sessionsDir: string): string {
  return path.join(sessionsDir, INDEX_FILENAME);
}

function readIndexRows(sessionsDir: string): IndexedRow[] | null {
  const filePath = indexPath(sessionsDir);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!data || typeof data !== 'object' || data.version !== INDEX_VERSION) {
      return null;
    }
    const rows = data.sessions;
    if (!Array.isArray(rows) || !rows.every((row) => typeof row === 'object')) {
      return null;
    }
    return rows as IndexedRow[];
  } catch (err) {
    logger.debug({ err }, 'Failed to read WebUI session list index');
    return null;
  }
}

function writeIndexRows(sessionsDir: string, rows: IndexedRow[]): void {
  const filePath = indexPath(sessionsDir);
  const tmpPath = filePath + '.tmp';
  const data = { version: INDEX_VERSION, sessions: rows };
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data) + '\n', 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    logger.debug({ err }, 'Failed to write WebUI session list index');
  }
}

function fileSignature(filePath: string): { mtime_ns: number; size: number } {
  const stat = fs.statSync(filePath);
  return {
    mtime_ns: stat.mtimeMs * 1_000_000,
    size: stat.size,
  };
}

function indexedRowMatchesFile(row: IndexedRow, filePath: string): boolean {
  if (
    !(
      typeof row.key === 'string' &&
      typeof row.created_at === 'string' &&
      typeof row.updated_at === 'string'
    )
  ) {
    return false;
  }
  if (!(typeof row.title === 'string' && typeof row.preview === 'string')) {
    return false;
  }
  if (row.file !== path.basename(filePath)) return false;
  try {
    const signature = fileSignature(filePath);
    const activitySignature = webuiActivitySignature(row.key);
    return (
      row.mtime_ns === signature.mtime_ns &&
      row.size === signature.size &&
      row[WEBUI_ACTIVITY_MTIME_NS] === activitySignature[WEBUI_ACTIVITY_MTIME_NS] &&
      row[WEBUI_ACTIVITY_SIZE] === activitySignature[WEBUI_ACTIVITY_SIZE]
    );
  } catch {
    return false;
  }
}

function publicRow(sessionsDir: string, row: IndexedRow): WebUISessionRow {
  return {
    key: row.key,
    created_at: row.created_at,
    updated_at: row.updated_at,
    title: row.title || '',
    preview: row.preview || '',
    path: path.join(sessionsDir, row.file || ''),
  };
}

function webuiActivityPaths(sessionKey: string): string[] {
  const stem = safeKey(sessionKey);
  const webuiDir = getWebuiDir();
  return [path.join(webuiDir, `${stem}.jsonl`), path.join(webuiDir, `${stem}.json`)];
}

function webuiActivitySignature(
  sessionKey: string,
): { [WEBUI_ACTIVITY_MTIME_NS]: number; [WEBUI_ACTIVITY_SIZE]: number } {
  let latestMtimeNs = 0;
  let totalSize = 0;
  for (const p of webuiActivityPaths(sessionKey)) {
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile()) continue;
      latestMtimeNs = Math.max(latestMtimeNs, stat.mtimeMs * 1_000_000);
      totalSize += stat.size;
    } catch {
      continue;
    }
  }
  return {
    [WEBUI_ACTIVITY_MTIME_NS]: latestMtimeNs,
    [WEBUI_ACTIVITY_SIZE]: totalSize,
  };
}

function webuiActivityUpdatedAt(
  signature: { [WEBUI_ACTIVITY_MTIME_NS]: number },
): string | null {
  const mtimeNs = signature[WEBUI_ACTIVITY_MTIME_NS] || 0;
  if (mtimeNs <= 0) return null;
  return new Date(mtimeNs / 1_000_000).toISOString();
}

function timestamp(value: string | null | undefined): number {
  if (!value) return 0;
  try {
    return new Date(value).getTime();
  } catch {
    return 0;
  }
}

function latestUpdatedAt(
  stored: string | null | undefined,
  activity: string | null | undefined,
): string | null {
  if (timestamp(activity) > timestamp(stored)) {
    return activity || null;
  }
  return stored || null;
}

function visibleMessageTimestamp(item: Record<string, unknown>): string | null {
  if (isHiddenHistoryMessage(item)) return null;
  const role = item.role;
  if (typeof role !== 'string' || !VISIBLE_TRANSCRIPT_ROLES.has(role)) {
    return null;
  }
  const ts = item.timestamp;
  return typeof ts === 'string' ? ts : null;
}

function lastVisibleMessageAt(messages: Record<string, unknown>[]): string | null {
  let latest: string | null = null;
  for (const item of messages) {
    const ts = visibleMessageTimestamp(item);
    if (ts !== null) {
      latest = latestUpdatedAt(latest, ts);
    }
  }
  return latest;
}

function visibleActivityUpdatedAt(
  stored: string | null | undefined,
  visibleMessageAt: string | null,
  webuiActivity: string | null,
): string | null {
  return (
    latestUpdatedAt(visibleMessageAt, webuiActivity) || (stored as string | null)
  );
}

function previewFromMessages(messages: Record<string, unknown>[]): string {
  let fallbackPreview = '';
  let scannedRecords = 0;
  let scannedChars = 0;
  for (const item of messages) {
    scannedRecords++;
    scannedChars += JSON.stringify(item).length + 1;
    if (
      scannedRecords > SESSION_LIST_PREVIEW_MAX_RECORDS ||
      scannedChars > SESSION_LIST_PREVIEW_MAX_CHARS
    ) {
      break;
    }
    if (isHiddenHistoryMessage(item)) continue;
    const text = messagePreviewText(item);
    if (!text) continue;
    if (item.role === 'user') return text;
    if (!fallbackPreview && item.role === 'assistant') {
      fallbackPreview = text;
    }
  }
  return fallbackPreview;
}

function decodeStorageKey(stem: string): string | null {
  try {
    return stem.replace('_', ':');
  } catch {
    return null;
  }
}

function scanSessionRow(
  _sessionManager: any,
  filePath: string,
): IndexedRow | null {
  const stem = path.basename(filePath, path.extname(filePath));
  const fallbackKey = decodeStorageKey(stem) || stem.replace('_', ':');
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return null;

    let firstLineData: Record<string, unknown>;
    try {
      firstLineData = JSON.parse(lines[0]);
    } catch {
      return null;
    }

    if (firstLineData._type !== 'metadata') {
      return null;
    }

    let preview = '';
    let fallbackPreview = '';
    let visibleMessageAt: string | null = null;
    let previewDone = false;
    let scannedRecords = 0;
    let scannedChars = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      let item: Record<string, unknown>;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = visibleMessageTimestamp(item);
      if (ts !== null) {
        visibleMessageAt = latestUpdatedAt(visibleMessageAt, ts);
      }
      if (!previewDone) {
        scannedRecords++;
        scannedChars += line.length;
        if (
          scannedRecords > SESSION_LIST_PREVIEW_MAX_RECORDS ||
          scannedChars > SESSION_LIST_PREVIEW_MAX_CHARS
        ) {
          previewDone = true;
          continue;
        }
        if (item._type === 'metadata') continue;
        if (isHiddenHistoryMessage(item)) continue;
        const text = messagePreviewText(item);
        if (!text) continue;
        if (item.role === 'user') {
          preview = text;
          previewDone = true;
          continue;
        }
        if (!fallbackPreview && item.role === 'assistant') {
          fallbackPreview = text;
        }
      }
    }

    const signature = fileSignature(filePath);
    const createdAtS = firstLineData.created_at;
    const updatedAtS = firstLineData.updated_at;
    const fallbackTime = new Date(signature.mtime_ns / 1_000_000).toISOString();
    const createdAt = (createdAtS as string) || fallbackTime;
    const updatedAt = (updatedAtS as string) || fallbackTime;
    const key = (firstLineData.key as string) || fallbackKey;
    const activitySignature = webuiActivitySignature(key);
    const activityUpdatedAt = webuiActivityUpdatedAt(activitySignature);

    return {
      key,
      created_at: createdAt,
      updated_at: visibleActivityUpdatedAt(updatedAt, visibleMessageAt, activityUpdatedAt) || updatedAt,
      title: metadataTitle((firstLineData.metadata as Record<string, unknown>) || {}),
      preview: preview || fallbackPreview,
      path: filePath,
      file: path.basename(filePath),
      mtime_ns: signature.mtime_ns,
      size: signature.size,
      ...activitySignature,
    };
  } catch {
    return null;
  }
}

export function reconcileIndex(sessionManager?: any): [IndexedRow[], boolean] {
  const sessionsDir = getSessionsDir();
  const existingRows = readIndexRows(sessionsDir);
  const existingByFile: Record<string, IndexedRow> = {};
  if (existingRows) {
    for (const row of existingRows) {
      if (typeof row.file === 'string') {
        existingByFile[row.file] = row;
      }
    }
  }

  let paths: string[] = [];
  try {
    paths = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => path.join(sessionsDir, f));
  } catch {
    paths = [];
  }

  const rows: IndexedRow[] = [];
  let changed = existingRows === null;

  for (const p of paths) {
    const row = existingByFile[path.basename(p)];
    if (row && indexedRowMatchesFile(row, p)) {
      rows.push(row);
      continue;
    }
    changed = true;
    const scanned = scanSessionRow(sessionManager, p);
    if (scanned) {
      rows.push(scanned);
    }
  }

  const existingFiles = new Set(Object.keys(existingByFile));
  const currentFiles = new Set(paths.map((p) => path.basename(p)));
  if (existingFiles.size !== currentFiles.size) {
    changed = true;
  } else {
    for (const f of existingFiles) {
      if (!currentFiles.has(f)) {
        changed = true;
        break;
      }
    }
  }

  if (existingRows !== null && JSON.stringify(rows) !== JSON.stringify(existingRows)) {
    changed = true;
  }

  return [rows, changed];
}

export function listWebuiSessions(sessionManager?: any): WebUISessionRow[] {
  const sessionsDir = getSessionsDir();
  const [rows, changed] = reconcileIndex(sessionManager);
  if (changed) {
    try {
      writeIndexRows(sessionsDir, rows);
    } catch (e) {
      logger.debug({ err: e }, 'Failed to write WebUI session list index');
    }
  }
  const sessions = rows.map((row) => publicRow(sessionsDir, row));
  return sessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
