import fs from 'fs/promises';
import path from 'path';
import { logger } from './logger.js';
import { getProjectConfigDir } from '../config/paths.js';

export interface SearchUsageRecord {
  query: string;
  timestamp: string;
  results_count: number;
  duration_ms: number;
}

export interface SearchUsageStats {
  total_queries: number;
  avg_duration_ms: number;
  top_queries: { query: string; count: number }[];
  today_queries: number;
}

const _usageRecords: SearchUsageRecord[] = [];
const _QUERY_LIMIT = 1000;

export function recordSearchUsage(opts: {
  query: string;
  resultsCount: number;
  durationMs: number;
}): void {
  const record: SearchUsageRecord = {
    query: opts.query,
    timestamp: new Date().toISOString(),
    results_count: opts.resultsCount,
    duration_ms: opts.durationMs,
  };
  _usageRecords.push(record);
  if (_usageRecords.length > _QUERY_LIMIT) {
    _usageRecords.shift();
  }
}

export function getSearchUsageStats(): SearchUsageStats {
  const total = _usageRecords.length;
  const today = new Date().toISOString().split('T')[0];
  
  let totalDuration = 0;
  const queryCounts = new Map<string, number>();
  let todayCount = 0;

  for (const record of _usageRecords) {
    totalDuration += record.duration_ms;
    queryCounts.set(record.query, (queryCounts.get(record.query) || 0) + 1);
    if (record.timestamp.startsWith(today)) {
      todayCount++;
    }
  }

  const topQueries = Array.from(queryCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([query, count]) => ({ query, count }));

  return {
    total_queries: total,
    avg_duration_ms: total > 0 ? Math.round(totalDuration / total) : 0,
    top_queries: topQueries,
    today_queries: todayCount,
  };
}

export async function persistSearchUsage(): Promise<void> {
  const dir = path.join(getProjectConfigDir(), 'stats');
  const filePath = path.join(dir, 'search_usage.json');
  
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(_usageRecords, null, 2));
  } catch (err) {
    logger.debug({ err }, 'Failed to persist search usage');
  }
}

export async function loadSearchUsage(): Promise<void> {
  const dir = path.join(getProjectConfigDir(), 'stats');
  const filePath = path.join(dir, 'search_usage.json');
  
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    const records = JSON.parse(data) as SearchUsageRecord[];
    for (const record of records) {
      _usageRecords.push(record);
    }
    if (_usageRecords.length > _QUERY_LIMIT) {
      _usageRecords.splice(0, _usageRecords.length - _QUERY_LIMIT);
    }
  } catch {
    // File not found or corrupted, ignore
  }
}