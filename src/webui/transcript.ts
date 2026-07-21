import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { getProjectConfigDir } from '../config/paths.js';
import { WEBUI_TURN_METADATA_KEY, WEBUI_MESSAGE_SOURCE_METADATA_KEY } from './metadata.js';

export const WEBUI_TRANSCRIPT_SCHEMA_VERSION = 3;
export const WEBUI_FORK_MARKER_EVENT = 'fork_marker';
const MAX_TRANSCRIPT_FILE_BYTES = 8 * 1024 * 1024;
const TARGET_ACTIVE_TRANSCRIPT_BYTES = MAX_TRANSCRIPT_FILE_BYTES / 2;
const TRANSCRIPT_SEGMENT_MANIFEST_VERSION = 2;
const TRANSCRIPT_ACTIVE_CHUNK_ID = 'active';
const TRANSCRIPT_SEGMENT_RE = /^\d{6}\.jsonl$/;
const DEFAULT_TRANSCRIPT_PAGE_LIMIT = 160;
const MAX_TRANSCRIPT_PAGE_LIMIT = 1000;
const WEBUI_TURN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const INLINE_MARKDOWN_IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.svg',
]);
const INLINE_MARKDOWN_VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm']);
const INLINE_MARKDOWN_MEDIA_EXTS = new Set([
  ...INLINE_MARKDOWN_IMAGE_EXTS,
  ...INLINE_MARKDOWN_VIDEO_EXTS,
]);

function getWebuiDir(): string {
  return path.join(getProjectConfigDir(), 'webui');
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function webuiTranscriptPath(sessionKey: string): string {
  const stem = safeKey(sessionKey);
  return path.join(getWebuiDir(), `${stem}.jsonl`);
}

export function webuiTranscriptSegmentsDir(sessionKey: string): string {
  const stem = safeKey(sessionKey);
  return path.join(getWebuiDir(), `${stem}.segments`);
}

function webuiTranscriptManifestPath(sessionKey: string): string {
  return path.join(webuiTranscriptSegmentsDir(sessionKey), 'manifest.json');
}

function legacyWebuiThreadPath(sessionKey: string): string {
  const stem = safeKey(sessionKey);
  return path.join(getWebuiDir(), `${stem}.json`);
}

function recordJsonLine(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

function readTranscriptFile(filePath: string): Record<string, unknown>[] {
  const linesOut: Record<string, unknown>[] = [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (typeof obj === 'object' && obj !== null) {
          linesOut.push(obj);
        }
      } catch {
        logger.warn({ path: filePath, line: i + 1 }, 'bad jsonl');
      }
    }
  } catch (e) {
    logger.warn({ err: e, path: filePath }, 'read transcript failed');
    return [];
  }
  return linesOut;
}

function recordsBytes(records: Record<string, unknown>[]): number {
  let total = 0;
  for (const record of records) {
    total += Buffer.byteLength(recordJsonLine(record), 'utf-8') + 1;
  }
  return total;
}

function flattenTurns(turns: Record<string, unknown>[][]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const turn of turns) {
    result.push(...turn);
  }
  return result;
}

function writeRecordsToPath(
  filePath: string,
  rows: Record<string, unknown>[],
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp';
  try {
    let content = '';
    for (const row of rows) {
      const raw = recordJsonLine(row);
      if (Buffer.byteLength(raw, 'utf-8') > MAX_TRANSCRIPT_FILE_BYTES) {
        throw new Error('webui transcript line too large');
      }
      content += raw + '\n';
    }
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw e;
  }
}

function segmentFilePath(sessionKey: string, segmentId: string): string {
  return path.join(webuiTranscriptSegmentsDir(sessionKey), `${segmentId}.jsonl`);
}

function segmentIdsOnDisk(sessionKey: string): string[] {
  const directory = webuiTranscriptSegmentsDir(sessionKey);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    return [];
  }
  try {
    return fs
      .readdirSync(directory)
      .filter((f) => {
        const p = path.join(directory, f);
        return fs.statSync(p).isFile() && TRANSCRIPT_SEGMENT_RE.test(f);
      })
      .map((f) => path.basename(f, '.jsonl'))
      .sort();
  } catch {
    return [];
  }
}

function segmentManifestEntry(
  sessionKey: string,
  segmentId: string,
): Record<string, unknown> {
  const p = segmentFilePath(sessionKey, segmentId);
  const lines = readTranscriptFile(p);
  const stat = fs.existsSync(p) ? fs.statSync(p) : null;
  return {
    id: segmentId,
    bytes: stat?.size || 0,
    turn_count: splitTranscriptTurns(lines).length,
    user_count: lines.filter((line) => isUserTranscriptRow(line)).length,
  };
}

function nonNegativeInt(value: unknown): number | null {
  if (typeof value === 'boolean' || typeof value !== 'number' || value < 0 || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

function normalizeManifestEntry(
  sessionKey: string,
  entry: unknown,
): Record<string, unknown> | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  const segmentId = e.id;
  if (typeof segmentId !== 'string' || !TRANSCRIPT_SEGMENT_RE.test(`${segmentId}.jsonl`)) {
    return null;
  }
  const segmentPath = segmentFilePath(sessionKey, segmentId);
  const values: Record<string, number | null> = {};
  for (const key of ['bytes', 'turn_count', 'user_count']) {
    values[key] = nonNegativeInt(e[key]);
  }
  if (
    !fs.existsSync(segmentPath) ||
    values.bytes !== fs.statSync(segmentPath).size
  ) {
    return null;
  }
  if (values.turn_count === null || values.user_count === null) {
    return null;
  }
  return {
    id: segmentId,
    bytes: values.bytes,
    turn_count: values.turn_count,
    user_count: values.user_count,
  };
}

function writeSegmentManifest(sessionKey: string, segmentIds: string[]): void {
  const directory = webuiTranscriptSegmentsDir(sessionKey);
  fs.mkdirSync(directory, { recursive: true });
  const data = {
    version: TRANSCRIPT_SEGMENT_MANIFEST_VERSION,
    segments: segmentIds.map((id) => segmentManifestEntry(sessionKey, id)),
  };
  const filePath = webuiTranscriptManifestPath(sessionKey);
  const tmpPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw e;
  }
}

function rebuildSegmentManifest(sessionKey: string): string[] {
  const segmentIds = segmentIdsOnDisk(sessionKey);
  if (segmentIds.length > 0) {
    writeSegmentManifest(sessionKey, segmentIds);
  } else {
    const manifestPath = webuiTranscriptManifestPath(sessionKey);
    if (fs.existsSync(manifestPath)) {
      fs.unlinkSync(manifestPath);
    }
  }
  return segmentIds;
}

function rebuiltSegmentManifestEntries(
  sessionKey: string,
): Record<string, unknown>[] {
  return rebuildSegmentManifest(sessionKey).map((id) =>
    segmentManifestEntry(sessionKey, id),
  );
}

function readSegmentManifestEntries(sessionKey: string): Record<string, unknown>[] {
  const directory = webuiTranscriptSegmentsDir(sessionKey);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    return [];
  }
  const filePath = webuiTranscriptManifestPath(sessionKey);
  if (!fs.existsSync(filePath)) {
    return rebuiltSegmentManifestEntries(sessionKey);
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const rawSegments = data && typeof data === 'object' ? data.segments : null;
    if (
      data.version !== TRANSCRIPT_SEGMENT_MANIFEST_VERSION ||
      !Array.isArray(rawSegments)
    ) {
      return rebuiltSegmentManifestEntries(sessionKey);
    }
    const entries: Record<string, unknown>[] = [];
    for (const entry of rawSegments) {
      const normalized = normalizeManifestEntry(sessionKey, entry);
      if (normalized === null) {
        return rebuiltSegmentManifestEntries(sessionKey);
      }
      entries.push(normalized);
    }
    const entryIds = entries.map((e) => e.id as string);
    if (JSON.stringify(entryIds) !== JSON.stringify(segmentIdsOnDisk(sessionKey))) {
      return rebuiltSegmentManifestEntries(sessionKey);
    }
    return entries;
  } catch {
    return rebuiltSegmentManifestEntries(sessionKey);
  }
}

function readSegmentIds(sessionKey: string): string[] {
  return readSegmentManifestEntries(sessionKey).map((e) => e.id as string);
}

function appendSegmentTurns(
  sessionKey: string,
  turns: Record<string, unknown>[][],
): void {
  if (turns.length === 0) return;
  const segmentIds = readSegmentIds(sessionKey);
  let nextId = segmentIds.length > 0 ? parseInt(segmentIds[segmentIds.length - 1], 10) + 1 : 1;
  let batch: Record<string, unknown>[][] = [];
  let batchBytes = 0;

  for (const turn of turns) {
    const turnBytes = recordsBytes(turn);
    if (batch.length > 0 && batchBytes + turnBytes > MAX_TRANSCRIPT_FILE_BYTES) {
      const segmentId = String(nextId).padStart(6, '0');
      writeRecordsToPath(
        segmentFilePath(sessionKey, segmentId),
        flattenTurns(batch),
      );
      segmentIds.push(segmentId);
      nextId++;
      batch = [];
      batchBytes = 0;
    }
    batch.push(turn);
    batchBytes += turnBytes;
  }

  if (batch.length > 0) {
    const segmentId = String(nextId).padStart(6, '0');
    writeRecordsToPath(
      segmentFilePath(sessionKey, segmentId),
      flattenTurns(batch),
    );
    segmentIds.push(segmentId);
  }
  writeSegmentManifest(sessionKey, segmentIds);
}

function splitTranscriptTurns(
  lines: Record<string, unknown>[],
): Record<string, unknown>[][] {
  const turns: Record<string, unknown>[][] = [];
  let current: Record<string, unknown>[] = [];
  for (const rec of lines) {
    current.push(rec);
    if (rec.event === 'turn_end') {
      turns.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    turns.push(current);
  }
  return turns;
}

function rotateActiveTranscriptIfNeeded(sessionKey: string): void {
  const filePath = webuiTranscriptPath(sessionKey);
  if (!fs.existsSync(filePath)) return;
  try {
    if (fs.statSync(filePath).size <= MAX_TRANSCRIPT_FILE_BYTES) return;
  } catch {
    return;
  }

  const lines = readTranscriptFile(filePath);
  if (lines.length === 0) return;
  const turns = splitTranscriptTurns(lines);
  if (turns.length <= 1) return;

  let keepStart = turns.length - 1;
  let keepBytes = 0;
  for (let idx = turns.length - 1; idx >= 0; idx--) {
    const turnBytes = recordsBytes(turns[idx]);
    if (idx === turns.length - 1 || keepBytes + turnBytes <= TARGET_ACTIVE_TRANSCRIPT_BYTES) {
      keepStart = idx;
      keepBytes += turnBytes;
      continue;
    }
    break;
  }

  const moved = turns.slice(0, keepStart);
  const kept = turns.slice(keepStart);
  if (moved.length === 0) return;
  appendSegmentTurns(sessionKey, moved);
  writeRecordsToPath(filePath, flattenTurns(kept));
}

function chunkIds(sessionKey: string): string[] {
  rotateActiveTranscriptIfNeeded(sessionKey);
  const ids = readSegmentIds(sessionKey);
  if (fs.existsSync(webuiTranscriptPath(sessionKey))) {
    ids.push(TRANSCRIPT_ACTIVE_CHUNK_ID);
  }
  return ids;
}

function readChunkTurns(sessionKey: string, chunkId: string): Record<string, unknown>[][] {
  let filePath: string;
  if (chunkId === TRANSCRIPT_ACTIVE_CHUNK_ID) {
    filePath = webuiTranscriptPath(sessionKey);
  } else {
    filePath = segmentFilePath(sessionKey, chunkId);
  }
  if (!fs.existsSync(filePath)) return [];
  return splitTranscriptTurns(readTranscriptFile(filePath));
}

function encodePageCursor(beforeTurnOrdinal: number): string {
  const raw = JSON.stringify({ before_turn: beforeTurnOrdinal });
  return Buffer.from(raw).toString('base64url').replace(/=+$/, '');
}

function decodePageCursor(value: string | null | undefined): number | null {
  if (!value) return null;
  try {
    const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
    const data = JSON.parse(Buffer.from(padded, 'base64url').toString('utf-8'));
    if (!data || typeof data !== 'object') return null;
    const beforeTurn = data.before_turn;
    if (
      typeof beforeTurn === 'boolean' ||
      typeof beforeTurn !== 'number' ||
      beforeTurn < 0 ||
      !Number.isInteger(beforeTurn)
    ) {
      return null;
    }
    return beforeTurn;
  } catch {
    return null;
  }
}

function coercePageLimit(limit: number | null | undefined): number {
  if (limit === null || limit === undefined) {
    return DEFAULT_TRANSCRIPT_PAGE_LIMIT;
  }
  return Math.max(1, Math.min(MAX_TRANSCRIPT_PAGE_LIMIT, Math.floor(limit)));
}

function isUserTranscriptRow(row: Record<string, unknown>): boolean {
  return row.event === 'user' || row.role === 'user';
}

function isAutomationKind(kind: unknown): boolean {
  return typeof kind === 'string' && ['cron', 'dream', 'automation'].includes(kind);
}

export function webuiMessageSource(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, string> | null {
  const raw = (metadata || {})[WEBUI_MESSAGE_SOURCE_METADATA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const rawObj = raw as Record<string, unknown>;
  const kind = rawObj.kind;
  if (!isAutomationKind(kind)) return null;
  const source: Record<string, string> = { kind: kind as string };
  const label = rawObj.label;
  if (typeof label === 'string' && label.trim()) {
    source.label = label.trim();
  }
  return source;
}

export function normalizeWebuiTurnId(value: unknown): string {
  if (typeof value === 'string') {
    const candidate = value.trim();
    if (WEBUI_TURN_ID_RE.test(candidate)) {
      return candidate;
    }
  }
  return crypto.randomUUID();
}

export class WebUITranscriptRecorder {
  private log: typeof logger;
  private turnSequences: Map<string, number> = new Map();

  constructor(log = logger) {
    this.log = log;
  }

  clientTurnMetadata(value: unknown): Record<string, string> {
    return { [WEBUI_TURN_METADATA_KEY]: normalizeWebuiTurnId(value) };
  }

  prepareEvent(
    chatId: string,
    event: Record<string, unknown>,
    options: {
      metadata?: Record<string, unknown> | null;
      phase?: string | null;
      includeSource?: boolean;
    } = {},
  ): void {
    if (options.includeSource) {
      const source = webuiMessageSource(options.metadata);
      if (source) {
        event.source = source;
      }
    }
    this.annotateTurn(chatId, event, options.metadata, options.phase);
  }

  prepareAndAppend(
    chatId: string,
    event: Record<string, unknown>,
    options: {
      metadata?: Record<string, unknown> | null;
      phase?: string | null;
      includeSource?: boolean;
      transcriptOverrides?: Record<string, unknown> | null;
    } = {},
  ): void {
    this.prepareEvent(chatId, event, options);
    const record = { ...event };
    if (options.transcriptOverrides) {
      Object.assign(record, options.transcriptOverrides);
    }
    this.append(chatId, record);
  }

  appendUserMessage(
    chatId: string,
    text: string,
    options: {
      metadata: Record<string, unknown>;
      mediaPaths?: string[] | null;
      cliApps?: Record<string, unknown>[] | null;
      mcpPresets?: Record<string, unknown>[] | null;
    },
  ): void {
    if (text.trim() === '/stop' && !options.mediaPaths) {
      return;
    }
    const payload = buildUserTranscriptEvent(chatId, text, {
      mediaPaths: options.mediaPaths,
      cliApps: options.cliApps,
      mcpPresets: options.mcpPresets,
    });
    if (!payload) return;
    this.prepareAndAppend(chatId, payload, {
      metadata: options.metadata,
      phase: 'user',
    });
  }

  append(chatId: string, event: Record<string, unknown>): void {
    try {
      const dup = JSON.parse(JSON.stringify(event));
      appendTranscriptObject(`websocket:${chatId}`, dup);
    } catch (e) {
      this.log.warn({ err: e }, 'webui transcript append failed');
    }
  }

  private nextTurnSeq(chatId: string, turnId: string): number {
    const key = `${chatId}:${turnId}`;
    const seq = (this.turnSequences.get(key) || 0) + 1;
    this.turnSequences.set(key, seq);
    return seq;
  }

  private annotateTurn(
    chatId: string,
    event: Record<string, unknown>,
    metadata: Record<string, unknown> | null | undefined,
    phase: string | null | undefined,
  ): void {
    if (!phase) return;
    const turnId = (metadata || {})[WEBUI_TURN_METADATA_KEY];
    if (typeof turnId !== 'string' || !turnId) return;
    event.turn_id = turnId;
    event.turn_phase = phase;
    event.turn_seq = this.nextTurnSeq(chatId, turnId);
    if (phase === 'complete') {
      this.turnSequences.delete(`${chatId}:${turnId}`);
    }
  }
}

function chatIdFromSessionKey(sessionKey: string): string | null {
  if (!sessionKey.startsWith('websocket:')) return null;
  const chatId = sessionKey.split(':', 1)[1]?.trim();
  return chatId || null;
}

function nowMs(): number {
  return Date.now();
}

function validCreatedAtMs(value: unknown): number | null {
  if (typeof value === 'boolean') return null;
  if (typeof value === 'number' && value >= 0 && value < 10_000_000_000_000_000) {
    return Math.floor(value);
  }
  return null;
}

function recordForAppend(obj: Record<string, unknown>): Record<string, unknown> {
  if (validCreatedAtMs(obj.created_at_ms) !== null) {
    return obj;
  }
  const record = { ...obj };
  record.created_at_ms = nowMs();
  return record;
}

function appendToActiveTranscript(
  sessionKey: string,
  obj: Record<string, unknown>,
): void {
  const raw = recordJsonLine(obj);
  if (Buffer.byteLength(raw, 'utf-8') > MAX_TRANSCRIPT_FILE_BYTES) {
    throw new Error('webui transcript line too large');
  }
  const filePath = webuiTranscriptPath(sessionKey);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const line = raw + '\n';
  fs.appendFileSync(filePath, line, 'utf-8');
}

export function appendTranscriptObject(
  sessionKey: string,
  obj: Record<string, unknown>,
): void {
  const record = recordForAppend(obj);
  appendToActiveTranscript(sessionKey, record);
  if (record.event === 'turn_end') {
    rotateActiveTranscriptIfNeeded(sessionKey);
  }
}

export function readTranscriptLines(sessionKey: string): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  for (const chunkId of chunkIds(sessionKey)) {
    if (chunkId === TRANSCRIPT_ACTIVE_CHUNK_ID) {
      lines.push(...readTranscriptFile(webuiTranscriptPath(sessionKey)));
    } else {
      lines.push(...readTranscriptFile(segmentFilePath(sessionKey, chunkId)));
    }
  }
  return lines;
}

function writeTranscriptLines(
  sessionKey: string,
  rows: Record<string, unknown>[],
): void {
  deleteWebuiTranscript(sessionKey);
  const filePath = webuiTranscriptPath(sessionKey);
  writeRecordsToPath(filePath, rows);
  rotateActiveTranscriptIfNeeded(sessionKey);
}

export function forkTranscriptBeforeUserIndex(
  sourceKey: string,
  targetKey: string,
  beforeUserIndex: number,
): boolean {
  if (beforeUserIndex < 0) return false;
  const lines = readTranscriptLines(sourceKey);
  if (lines.length === 0) return false;

  const targetChatId = chatIdFromSessionKey(targetKey);
  const copied: Record<string, unknown>[] = [];
  let userIndex = 0;
  let foundTarget = false;

  for (const row of lines) {
    if (row.event === WEBUI_FORK_MARKER_EVENT) continue;
    if (isUserTranscriptRow(row)) {
      if (userIndex === beforeUserIndex) {
        foundTarget = true;
        break;
      }
      userIndex++;
    }
    const dup = JSON.parse(JSON.stringify(row));
    if (targetChatId !== null) {
      dup.chat_id = targetChatId;
    }
    copied.push(dup);
  }

  if (userIndex === beforeUserIndex) {
    foundTarget = true;
  }
  if (!foundTarget) return false;

  writeTranscriptLines(targetKey, copied);
  return true;
}

export function appendForkMarker(sessionKey: string): void {
  appendTranscriptObject(sessionKey, {
    event: WEBUI_FORK_MARKER_EVENT,
    chat_id: chatIdFromSessionKey(sessionKey),
  });
}

function isHiddenHistoryMessage(_item: Record<string, unknown>): boolean {
  return false;
}

function publicHistoryMessage(msg: Record<string, unknown>): Record<string, unknown> {
  return { ...msg };
}

export function writeSessionMessagesAsTranscript(
  targetKey: string,
  messages: Record<string, unknown>[],
): void {
  const targetChatId = chatIdFromSessionKey(targetKey);
  const rows: Record<string, unknown>[] = [];
  for (const msg of messages) {
    if (isHiddenHistoryMessage(msg)) continue;
    const m = publicHistoryMessage(msg);
    const role = m.role;
    const content = m.content;
    const text = typeof content === 'string' ? content : '';
    if (role === 'user') {
      const row: Record<string, unknown> = {
        event: 'user',
        chat_id: targetChatId,
        text,
      };
      const media = m.media;
      if (Array.isArray(media) && media.length > 0) {
        row.media_paths = media.filter((p) => typeof p === 'string' && p).map(String);
      }
      for (const key of ['cli_apps', 'mcp_presets']) {
        const value = (m as Record<string, unknown>)[key];
        if (Array.isArray(value) && value.length > 0) {
          row[key] = JSON.parse(JSON.stringify(value));
        }
      }
      rows.push(row);
    } else if (role === 'assistant' && typeof text === 'string' && text.trim()) {
      const row: Record<string, unknown> = {
        event: 'message',
        chat_id: targetChatId,
        text,
      };
      const media = m.media;
      if (Array.isArray(media) && media.length > 0) {
        row.media = media.filter((p) => typeof p === 'string' && p).map(String);
      }
      rows.push(row);
    }
  }
  writeTranscriptLines(targetKey, rows);
}

export function deleteWebuiTranscript(sessionKey: string): boolean {
  let removed = false;
  for (const p of [
    webuiTranscriptPath(sessionKey),
    legacyWebuiThreadPath(sessionKey),
  ]) {
    if (!fs.existsSync(p)) continue;
    try {
      fs.unlinkSync(p);
      removed = true;
    } catch (e) {
      logger.warn({ err: e, path: p }, 'Failed to delete webui transcript');
    }
  }
  const segmentsDir = webuiTranscriptSegmentsDir(sessionKey);
  if (fs.existsSync(segmentsDir) && fs.statSync(segmentsDir).isDirectory()) {
    try {
      fs.rmSync(segmentsDir, { recursive: true });
      removed = true;
    } catch (e) {
      logger.warn({ err: e, path: segmentsDir }, 'Failed to delete webui transcript segments');
    }
  }
  return removed;
}

export function buildUserTranscriptEvent(
  chatId: string,
  text: string,
  options: {
    mediaPaths?: unknown[] | null;
    cliApps?: unknown[] | null;
    mcpPresets?: unknown[] | null;
  } = {},
): Record<string, unknown> | null {
  const paths = (options.mediaPaths || [])
    .filter((p) => p)
    .map(String);
  if (!text && paths.length === 0) return null;
  const event: Record<string, unknown> = {
    event: 'user',
    chat_id: chatId,
    text,
  };
  if (paths.length > 0) {
    event.media_paths = paths;
  }
  const apps = (options.cliApps || [])
    .filter((app) => app && typeof app === 'object')
    .map((app) => ({ ...(app as Record<string, unknown>) }));
  if (apps.length > 0) {
    event.cli_apps = apps;
  }
  const presets = (options.mcpPresets || [])
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({ ...(p as Record<string, unknown>) }));
  if (presets.length > 0) {
    event.mcp_presets = presets;
  }
  return event;
}

export function replayTranscriptToUiMessages(
  lines: Record<string, unknown>[],
  _options: {
    augmentUserMedia?: (paths: string[]) => Array<Record<string, unknown>>;
    augmentAssistantMedia?: (paths: string[]) => Array<Record<string, unknown>>;
    augmentAssistantText?: (text: string) => string;
  } = {},
): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  let bufferParts: string[] = [];
  let idx = 0;

  for (const rec of lines) {
    idx++;
    const event = rec.event;
    if (event === 'user') {
      messages.push({
        id: `user-${idx}-${crypto.randomBytes(4).toString('hex')}`,
        role: 'user',
        content: rec.text || '',
        createdAt: rec.created_at_ms || Date.now() + idx,
      });
      bufferParts = [];
    } else if (event === 'message' || event === 'delta') {
      const text = typeof rec.text === 'string' ? rec.text : '';
      bufferParts.push(text);
      if (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
        const last = messages[messages.length - 1];
        last.content = bufferParts.join('');
      } else {
        messages.push({
          id: `as-${idx}-${crypto.randomBytes(4).toString('hex')}`,
          role: 'assistant',
          content: text,
          isStreaming: event === 'delta',
          createdAt: rec.created_at_ms || Date.now() + idx,
        });
      }
    } else if (event === 'stream_end' || event === 'turn_end') {
      if (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
        messages[messages.length - 1].isStreaming = false;
      }
    }
  }
  return messages;
}
