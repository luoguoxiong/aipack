import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getProjectConfigDir } from '../config/paths.js';

export const TOKEN_USAGE_SCHEMA_VERSION = 1;
const MAX_STATE_FILE_BYTES = 512 * 1024;
const MAX_DAYS_RETAINED = 400;
const USAGE_KEYS = [
  'prompt_tokens',
  'completion_tokens',
  'cached_tokens',
  'total_tokens',
  'provider_tokens',
  'estimated_tokens',
] as const;
const REQUEST_KEYS = ['requests', 'provider_requests', 'estimated_requests'] as const;
const SOURCE_KEYS = ['user', 'api', 'cron', 'dream', 'system'] as const;

type UsageKey = typeof USAGE_KEYS[number];
type RequestKey = typeof REQUEST_KEYS[number];
type SourceKey = typeof SOURCE_KEYS[number];

export interface UsageRow {
  date: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  provider_tokens: number;
  estimated_tokens: number;
  requests: number;
  provider_requests: number;
  estimated_requests: number;
  sources: Record<string, UsageRow>;
}

export interface TokenUsageState {
  schema_version: number;
  days: Record<string, UsageRow>;
  updated_at: string | null;
}

function getWebuiDir(): string {
  return path.join(getProjectConfigDir(), 'webui');
}

export function tokenUsageStatePath(): string {
  return path.join(getWebuiDir(), 'token-usage.json');
}

export function defaultTokenUsageState(): TokenUsageState {
  return {
    schema_version: TOKEN_USAGE_SCHEMA_VERSION,
    days: {},
    updated_at: null,
  };
}

function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

function localDay(timezoneName?: string): string {
  const now = new Date();
  if (!timezoneName) {
    return now.toISOString().split('T')[0];
  }
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezoneName,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().split('T')[0];
  }
}

function cleanInt(value: unknown): number {
  try {
    const num = Number(value || 0);
    return Math.max(0, Math.floor(num));
  } catch {
    return 0;
  }
}

function cleanSource(value: string | null | undefined): SourceKey {
  return (SOURCE_KEYS as readonly string[]).includes(value || '')
    ? (value as SourceKey)
    : 'system';
}

function sourceFromSessionKey(sessionKey: string | null | undefined): string {
  const key = sessionKey || '';
  if (key.startsWith('dream:')) return 'dream';
  if (key === 'heartbeat' || key.startsWith('cron:')) return 'cron';
  if (key.startsWith('api:')) return 'api';
  if (key.startsWith('system:')) return 'system';
  return 'user';
}

function normalizeUsage(raw: Record<string, unknown> | null | undefined): Record<UsageKey, number> {
  if (!raw || typeof raw !== 'object') {
    return {} as Record<UsageKey, number>;
  }
  const usage = {} as Record<UsageKey, number>;
  for (const key of USAGE_KEYS) {
    usage[key] = cleanInt(raw[key]);
  }
  const fallbackTotal = usage.prompt_tokens + usage.completion_tokens;
  if (usage.total_tokens <= 0) {
    usage.total_tokens = fallbackTotal;
  }
  if (usage.estimated_tokens <= 0 && usage.provider_tokens <= 0) {
    usage.provider_tokens = usage.total_tokens;
  } else if (usage.estimated_tokens > 0 && usage.provider_tokens <= 0) {
    usage.estimated_tokens = Math.min(usage.estimated_tokens, usage.total_tokens);
  } else if (usage.provider_tokens > 0 && usage.estimated_tokens <= 0) {
    usage.provider_tokens = Math.min(usage.provider_tokens, usage.total_tokens);
  }
  return usage.total_tokens > 0 ? usage : ({} as Record<UsageKey, number>);
}

function normalizeUsageRow(row: Record<string, unknown>): UsageRow & { date: string } {
  const cleaned = {} as Record<UsageKey, number>;
  for (const key of USAGE_KEYS) {
    cleaned[key] = cleanInt(row[key]);
  }
  if (cleaned.total_tokens <= 0) {
    cleaned.total_tokens = cleaned.prompt_tokens + cleaned.completion_tokens;
  }
  if (cleaned.provider_tokens <= 0 && cleaned.estimated_tokens <= 0) {
    cleaned.provider_tokens = cleaned.total_tokens;
  }
  const requests = {} as Record<RequestKey, number>;
  for (const key of REQUEST_KEYS) {
    requests[key] = cleanInt(row[key]);
  }
  if (
    requests.requests > 0 &&
    requests.provider_requests <= 0 &&
    requests.estimated_requests <= 0
  ) {
    if (cleaned.estimated_tokens > 0 && cleaned.provider_tokens <= 0) {
      requests.estimated_requests = requests.requests;
    } else {
      requests.provider_requests = requests.requests;
    }
  }
  return {
    date: typeof row.date === 'string' ? row.date : '',
    ...cleaned,
    ...requests,
    sources: {},
  } as UsageRow;
}

function normalizeSources(
  raw: unknown,
  fallback: Record<UsageKey | RequestKey, number>,
): Record<string, UsageRow> {
  const sources: Record<string, UsageRow> = {};
  if (raw && typeof raw === 'object') {
    for (const [source, row] of Object.entries(raw as Record<string, unknown>)) {
      if (!row || typeof row !== 'object') continue;
      const normalized = normalizeUsageRow(row as Record<string, unknown>);
      if (normalized.total_tokens <= 0 && normalized.requests <= 0) continue;
      const sourceKey = cleanSource(source);
      const current = sources[sourceKey];
      if (!current) {
        sources[sourceKey] = normalized;
      } else {
        for (const key of [...USAGE_KEYS, ...REQUEST_KEYS]) {
          (current as unknown as Record<string, number>)[key] =
            cleanInt((current as unknown as Record<string, number>)[key]) +
            (normalized as unknown as Record<string, number>)[key];
        }
      }
    }
  }
  if (
    Object.keys(sources).length === 0 &&
    (fallback.total_tokens > 0 || (fallback as unknown as Record<string, number>).requests > 0)
  ) {
    sources['user'] = { ...fallback } as UsageRow;
  }
  return sources;
}

export function normalizeTokenUsageState(raw: unknown): TokenUsageState {
  const state = defaultTokenUsageState();
  if (!raw || typeof raw !== 'object') {
    return state;
  }
  const r = raw as Record<string, unknown>;
  const daysRaw = r.days;
  if (!daysRaw || typeof daysRaw !== 'object') {
    return state;
  }

  const days: Record<string, UsageRow> = {};
  const entries = Object.entries(daysRaw as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-MAX_DAYS_RETAINED);

  for (const [date, row] of entries) {
    if (typeof date !== 'string' || date.length !== 10 || !row || typeof row !== 'object') {
      continue;
    }
    const normalized = normalizeUsageRow(row as Record<string, unknown>);
    if (normalized.total_tokens <= 0 && normalized.requests <= 0) continue;
    days[date] = {
      ...normalized,
      date,
      sources: normalizeSources(
        (row as Record<string, unknown>).sources,
        normalized as unknown as Record<UsageKey | RequestKey, number>,
      ),
    };
  }

  state.days = days;
  const updatedAt = r.updated_at;
  state.updated_at = typeof updatedAt === 'string' ? updatedAt : null;
  return state;
}

export function readTokenUsageState(): TokenUsageState {
  const filePath = tokenUsageStatePath();
  if (!fs.existsSync(filePath)) {
    return defaultTokenUsageState();
  }
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_STATE_FILE_BYTES) {
      logger.warn({ path: filePath }, 'token usage state too large, ignoring');
      return defaultTokenUsageState();
    }
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return normalizeTokenUsageState(raw);
  } catch (err) {
    logger.warn({ err, path: filePath }, 'read token usage state failed');
    return defaultTokenUsageState();
  }
}

export function writeTokenUsageState(raw: Partial<TokenUsageState>): TokenUsageState {
  const state = normalizeTokenUsageState(raw);
  state.updated_at = utcNowIso();
  const encoded = Buffer.from(JSON.stringify(state, null, 2) + '\n', 'utf-8');
  if (encoded.length > MAX_STATE_FILE_BYTES) {
    throw new Error('token usage state is too large');
  }

  const filePath = tokenUsageStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, encoded);
  fs.renameSync(tmpPath, filePath);
  return state;
}

let writeLock = false;

export function recordTokenUsage(
  usage: Record<string, unknown> | null | undefined,
  options: {
    source?: string;
    timezoneName?: string;
    now?: Date;
  } = {},
): TokenUsageState {
  const normalized = normalizeUsage(usage);
  if (Object.keys(normalized).length === 0) {
    return readTokenUsageState();
  }

  while (writeLock) {
    // Simple spin lock for synchronous operations
    // In production, we'd use async locks, but for simplicity:
    break;
  }
  writeLock = true;
  try {
    const state = readTokenUsageState();
    const day = localDay(options.timezoneName);
    const existing = state.days[day] || { date: day, requests: 0 } as UsageRow;
    const row = { ...existing };

    for (const key of USAGE_KEYS) {
      (row as unknown as Record<string, number>)[key] =
        cleanInt((row as unknown as Record<string, number>)[key]) +
        (normalized[key] || 0);
    }
    row.requests = cleanInt(row.requests) + 1;

    if ((normalized.estimated_tokens || 0) > 0 && (normalized.provider_tokens || 0) <= 0) {
      row.estimated_requests = cleanInt(row.estimated_requests) + 1;
    } else {
      row.provider_requests = cleanInt(row.provider_requests) + 1;
    }

    const sourceKey = cleanSource(options.source);
    const sources = { ...(row.sources || {}) };
    const sourceRow = { ...(sources[sourceKey] || { requests: 0 }) } as UsageRow;
    for (const key of USAGE_KEYS) {
      (sourceRow as unknown as Record<string, number>)[key] =
        cleanInt((sourceRow as unknown as Record<string, number>)[key]) +
        (normalized[key] || 0);
    }
    sourceRow.requests = cleanInt(sourceRow.requests) + 1;
    if ((normalized.estimated_tokens || 0) > 0 && (normalized.provider_tokens || 0) <= 0) {
      sourceRow.estimated_requests = cleanInt(sourceRow.estimated_requests) + 1;
    } else {
      sourceRow.provider_requests = cleanInt(sourceRow.provider_requests) + 1;
    }
    sources[sourceKey] = sourceRow;
    row.sources = sources;

    state.days[day] = row;

    const dayKeys = Object.keys(state.days).sort();
    if (dayKeys.length > MAX_DAYS_RETAINED) {
      const kept = dayKeys.slice(-MAX_DAYS_RETAINED);
      const newDays: Record<string, UsageRow> = {};
      for (const k of kept) {
        newDays[k] = state.days[k];
      }
      state.days = newDays;
    }

    return writeTokenUsageState(state);
  } finally {
    writeLock = false;
  }
}

export function tokenUsagePayload(options: {
  days?: number;
  timezoneName?: string;
  now?: Date;
} = {}): Record<string, unknown> {
  const state = readTokenUsageState();
  const daysCount = options.days ?? 371;
  const todayStr = localDay(options.timezoneName);
  const today = new Date(todayStr);
  const start = new Date(today);
  start.setDate(start.getDate() - Math.max(1, daysCount) + 1);
  const startStr = start.toISOString().split('T')[0];

  const dayRows: UsageRow[] = [];
  const sortedDays = Object.entries(state.days).sort(([a], [b]) => a.localeCompare(b));
  for (const [date, row] of sortedDays) {
    if (date >= startStr && date <= todayStr) {
      dayRows.push(row);
    }
  }

  const last30Start = new Date(today);
  last30Start.setDate(last30Start.getDate() - 29);
  const last30StartStr = last30Start.toISOString().split('T')[0];
  const last30 = Object.values(state.days).filter(
    (row) => row.date >= last30StartStr && row.date <= todayStr,
  );

  const last365Start = new Date(today);
  last365Start.setDate(last365Start.getDate() - 364);
  const last365StartStr = last365Start.toISOString().split('T')[0];
  const last365 = Object.values(state.days).filter(
    (row) => row.date >= last365StartStr && row.date <= todayStr,
  );

  const activeDates = new Set<string>();
  for (const [date, row] of Object.entries(state.days)) {
    if (cleanInt(row.total_tokens) > 0) {
      activeDates.add(date);
    }
  }

  let currentStreak = 0;
  let cursor = new Date(today);
  while (activeDates.has(cursor.toISOString().split('T')[0])) {
    currentStreak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  let longestStreak = 0;
  let runningStreak = 0;
  let prevDate: Date | null = null;
  for (const dateStr of Array.from(activeDates).sort()) {
    const date = new Date(dateStr);
    if (prevDate) {
      const diffTime = date.getTime() - prevDate.getTime();
      const diffDays = diffTime / (1000 * 60 * 60 * 24);
      if (diffDays === 1) {
        runningStreak++;
      } else {
        runningStreak = 1;
      }
    } else {
      runningStreak = 1;
    }
    longestStreak = Math.max(longestStreak, runningStreak);
    prevDate = date;
  }

  const allRows = Object.values(state.days);
  return {
    days: dayRows,
    total_tokens: allRows.reduce((sum, row) => sum + cleanInt(row.total_tokens), 0),
    total_tokens_30d: last30.reduce((sum, row) => sum + cleanInt(row.total_tokens), 0),
    total_tokens_365d: last365.reduce((sum, row) => sum + cleanInt(row.total_tokens), 0),
    peak_day_tokens: Math.max(0, ...allRows.map((row) => cleanInt(row.total_tokens))),
    current_streak_days: currentStreak,
    longest_streak_days: longestStreak,
    active_days_30d: last30.filter((row) => cleanInt(row.total_tokens) > 0).length,
    requests_30d: last30.reduce((sum, row) => sum + cleanInt(row.requests), 0),
    updated_at: state.updated_at,
  };
}
