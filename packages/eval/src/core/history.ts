/**
 * packages/eval/src/core/history.ts - 历史趋势（日环比可视化）
 *
 * 每次运行向 JSONL 追加一行（append-only，天然按时间序），
 * 读回后渲染 Markdown：趋势 sparkline + 逐次通过率 + 环比 Δ。
 *
 * 为什么用 JSONL 而不是单文件 JSON：cron 场景下并发/追加写更安全，
 * 且 diff 友好（一行一次运行）。
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { EvalReport, SuiteSummary } from './types';

/** 每次运行落一行（JSONL） */
export interface HistoryEntry {
  runId: string;
  /** ISO 时间 */
  at: string;
  mode: 'mock' | 'live';
  model?: string;
  cases: number;
  passed: number;
  skipped: number;
  passRate: number;
  avgScore: number;
  durationMs: number;
  usageTotal: number;
  bySuite: Record<string, Pick<SuiteSummary, 'total' | 'passed' | 'passRate'>>;
}

/** 报告 → 历史条目 */
export function reportToHistoryEntry(report: EvalReport): HistoryEntry {
  return {
    runId: report.runId,
    at: report.startedAt,
    mode: report.mode,
    model: report.model,
    cases: report.totals.cases,
    passed: report.totals.passed,
    skipped: report.totals.skipped,
    passRate: report.totals.passRate,
    avgScore: report.totals.avgScore,
    durationMs: report.durationMs,
    usageTotal: report.totals.usageTotal,
    bySuite: Object.fromEntries(
      Object.entries(report.bySuite).map(([k, s]) => [
        k,
        { total: s.total, passed: s.passed, passRate: s.passRate },
      ]),
    ),
  };
}

/** 追加一次运行记录（JSONL，一行一条） */
export async function appendHistory(
  report: EvalReport,
  historyPath: string,
): Promise<string> {
  const path = resolve(historyPath);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(reportToHistoryEntry(report))}\n`, 'utf-8');
  return path;
}

/** 读取历史（最新在最后）；文件不存在返回空数组 */
export async function readHistory(
  historyPath: string,
  limit = 30,
): Promise<HistoryEntry[]> {
  const path = resolve(historyPath);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return [];
  }
  const entries: HistoryEntry[] = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      entries.push(JSON.parse(s) as HistoryEntry);
    } catch {
      // 坏行跳过（不因一行损坏丢掉整份历史）
    }
  }
  return limit > 0 ? entries.slice(-limit) : entries;
}

// ─── 可视化 ───────────────────────────────────────────────────────

const SPARK_CHARS = '▁▂▃▄▅▆▇█';

/** 0~1 序列 → sparkline 字符串 */
export function sparkline(values: number[], width = 20): string {
  if (values.length === 0) return '';
  const seq = values.slice(-width);
  return seq
    .map((v) => {
      const clamped = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
      const idx = Math.round(clamped * (SPARK_CHARS.length - 1));
      return SPARK_CHARS[idx];
    })
    .join('');
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function deltaCell(cur: number, prev: number | undefined): string {
  if (prev === undefined) return '—';
  const d = (cur - prev) * 100;
  if (Math.abs(d) < 0.05) return '±0.0%';
  const sign = d > 0 ? '+' : '';
  const icon = d < 0 ? '🔻' : '🔺';
  return `${icon}${sign}${d.toFixed(1)}%`;
}

function shortAt(iso: string): string {
  // 2026-09-29T03:12:44.123Z → 09-29 03:12
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

/**
 * 渲染通过率趋势（Markdown）。
 * 环比定义：与上一次运行对比（cron 每日跑 → 即日环比）。
 */
export function renderHistoryTrend(entries: HistoryEntry[], limit = 15): string {
  if (entries.length === 0) return '（暂无历史记录）';

  const rows = entries.slice(-limit);
  const lines: string[] = [];
  const rates = rows.map((e) => e.passRate);
  const latest = rows[rows.length - 1];
  const prev = rows.length > 1 ? rows[rows.length - 2] : undefined;

  lines.push(`\`${sparkline(rates)}\`  最近 ${rows.length} 次：${pct(latest.passRate)}（环比 ${deltaCell(latest.passRate, prev?.passRate)}）`);
  lines.push('');
  lines.push(`| 时间(UTC) | 模式 | 模型 | 通过 | 通过率 | 环比 Δ | 平均分 | 耗时 |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  rows.forEach((e, i) => {
    lines.push(
      `| ${shortAt(e.at)} | ${e.mode} | ${e.model ?? '—'} | ${e.passed}/${e.cases} | ${pct(e.passRate)} | ${deltaCell(e.passRate, i > 0 ? rows[i - 1].passRate : undefined)} | ${e.avgScore.toFixed(2)} | ${(e.durationMs / 1000).toFixed(1)}s |`,
    );
  });

  // 分套件环比：定位是哪一组掉了
  const suiteDeltas: string[] = [];
  if (prev) {
    for (const [suite, cur] of Object.entries(latest.bySuite)) {
      const before = prev.bySuite[suite];
      if (!before) continue;
      const d = (cur.passRate - before.passRate) * 100;
      if (Math.abs(d) >= 0.05) {
        suiteDeltas.push(`  - ${suite}: ${pct(before.passRate)} → ${pct(cur.passRate)}（${d > 0 ? '+' : ''}${d.toFixed(1)}%）`);
      }
    }
  }
  if (suiteDeltas.length > 0) {
    lines.push('');
    lines.push(`分套件环比:`);
    lines.push(...suiteDeltas);
  }

  return lines.join('\n');
}
