/**
 * packages/eval/src/core/report.ts - 报告渲染与 baseline 门禁
 *
 * - JSON + Markdown 双格式输出到报告目录（缺省 ./eval-results）
 * - baseline：对比整体与分套件通过率，回归超阈值判失败
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { appendHistory, readHistory, renderHistoryTrend } from './history';
import type { HistoryEntry } from './history';
import type {
  BaselineComparison,
  BaselineFile,
  EvalReport,
  RunConfig,
  SuiteSummary,
} from './types';

// ─── Markdown 渲染 ────────────────────────────────────────────────

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function renderSummaryTable(
  byKey: Record<string, SuiteSummary>,
  keyHeader: string,
): string {
  const rows = Object.entries(byKey)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([k, s]) =>
        `| ${k} | ${s.total} | ${s.passed} | ${pct(s.passRate)} | ${s.avgScore.toFixed(2)} |`,
    );
  return [
    `| ${keyHeader} | 用例数 | 通过 | 通过率 | 平均分 |`,
    `|---|---|---|---|---|`,
    ...rows,
  ].join('\n');
}

export interface RenderOptions {
  /** 历史条目（含本次）→ 渲染通过率日环比趋势段 */
  history?: HistoryEntry[];
}

export function renderMarkdown(report: EvalReport, opts: RenderOptions = {}): string {
  const lines: string[] = [];
  lines.push(`# aipack Eval 报告`);
  lines.push('');
  lines.push(
    `- Run: \`${report.runId}\`（mode: ${report.mode}${report.model ? `, model: ${report.model}` : ''}）`,
  );
  lines.push(
    `- 总览: **${report.totals.passed}/${report.totals.cases} 通过（${pct(report.totals.passRate)}）**，平均分 ${report.totals.avgScore.toFixed(2)}，耗时 ${(report.durationMs / 1000).toFixed(2)}s`,
  );
  if (report.totals.skipped > 0) {
    lines.push(`- 跳过: ${report.totals.skipped} 个用例（模式不匹配，不计入通过率）`);
  }
  lines.push('');
  lines.push(`## 按套件`);
  lines.push('');
  lines.push(renderSummaryTable(report.bySuite, '套件'));
  lines.push('');
  lines.push(`## 按来源（分布漂移诊断）`);
  lines.push('');
  lines.push(renderSummaryTable(report.byOrigin, 'origin'));
  lines.push('');

  if (opts.history && opts.history.length > 0) {
    lines.push(`## 通过率趋势（环比）`);
    lines.push('');
    lines.push(renderHistoryTrend(opts.history));
    lines.push('');
  }

  const skipped = report.skipped ?? [];
  if (skipped.length > 0) {
    lines.push(`## 跳过用例（${skipped.length}）`);
    lines.push('');
    for (const s of skipped) lines.push(`- \`${s.caseId}\`: ${s.reason}`);
    lines.push('');
  }

  const failures = report.results.filter((r) => !r.passed);
  if (failures.length === 0) {
    lines.push(`## 失败用例`);
    lines.push('');
    lines.push(`无 ✅`);
  } else {
    lines.push(`## 失败用例（${failures.length}）`);
    lines.push('');
    for (const f of failures) {
      lines.push(`### ${f.caseId}`);
      lines.push('');
      if (f.error) lines.push(`- 运行错误: ${f.error}`);
      for (const s of f.scores) {
        if (!s.passed) lines.push(`- [${s.scorer}] ${s.reason}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

// ─── 报告写盘 ─────────────────────────────────────────────────────

export async function writeReport(
  report: EvalReport,
  reportDir: string,
  opts: RenderOptions = {},
): Promise<{ jsonPath: string; mdPath: string }> {
  const dir = resolve(reportDir);
  await mkdir(dir, { recursive: true });
  const jsonPath = join(dir, `${report.runId}.json`);
  const mdPath = join(dir, `${report.runId}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
  await writeFile(mdPath, renderMarkdown(report, opts), 'utf-8');
  return { jsonPath, mdPath };
}

// ─── Baseline ─────────────────────────────────────────────────────

export function reportToBaseline(report: EvalReport): BaselineFile {
  return {
    runId: report.runId,
    updatedAt: new Date().toISOString(),
    totals: {
      cases: report.totals.cases,
      passed: report.totals.passed,
      passRate: report.totals.passRate,
    },
    bySuite: Object.fromEntries(
      Object.entries(report.bySuite).map(([k, s]) => [
        k,
        { total: s.total, passed: s.passed, passRate: s.passRate },
      ]),
    ),
  };
}

export async function writeBaseline(
  report: EvalReport,
  baselinePath: string,
): Promise<string> {
  const path = resolve(baselinePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify(reportToBaseline(report), null, 2),
    'utf-8',
  );
  return path;
}

/**
 * 对比当前报告与 baseline。
 * ok = 整体通过率不低于 baseline - threshold，且无套件回归超阈值。
 */
export function compareBaseline(
  report: EvalReport,
  baseline: BaselineFile,
  threshold = 0.02,
): BaselineComparison {
  const overallDelta = report.totals.passRate - baseline.totals.passRate;
  const regressions: BaselineComparison['regressions'] = [];

  for (const [suite, b] of Object.entries(baseline.bySuite)) {
    const cur = report.bySuite[suite];
    if (!cur) continue; // baseline 中存在但本次未跑的套件不判回归
    const delta = cur.passRate - b.passRate;
    if (delta < -threshold) {
      regressions.push({
        suite,
        baseline: b.passRate,
        current: cur.passRate,
        delta,
      });
    }
  }

  return {
    ok: overallDelta >= -threshold && regressions.length === 0,
    overallDelta,
    regressions,
  };
}

export async function readBaseline(
  baselinePath: string,
): Promise<BaselineFile | undefined> {
  const { readFile } = await import('node:fs/promises');
  try {
    return JSON.parse(await readFile(resolve(baselinePath), 'utf-8')) as BaselineFile;
  } catch {
    return undefined;
  }
}

// ─── 便捷：跑完即出报告 ───────────────────────────────────────────

export async function finalizeReport(
  report: EvalReport,
  config: RunConfig,
): Promise<{
  jsonPath?: string;
  mdPath?: string;
  baseline?: BaselineFile;
  comparison?: BaselineComparison;
  historyPath?: string;
  history?: HistoryEntry[];
}> {
  const out: {
    jsonPath?: string;
    mdPath?: string;
    baseline?: BaselineFile;
    comparison?: BaselineComparison;
    historyPath?: string;
    history?: HistoryEntry[];
  } = {};

  // 先写盘再读回：趋势段包含本次运行
  if (config.historyPath) {
    out.historyPath = await appendHistory(report, config.historyPath);
    out.history = await readHistory(out.historyPath);
  }

  if (config.reportDir) {
    const { jsonPath, mdPath } = await writeReport(report, config.reportDir, {
      history: out.history,
    });
    out.jsonPath = jsonPath;
    out.mdPath = mdPath;
  }

  if (config.updateBaseline && config.baselinePath) {
    await writeBaseline(report, config.baselinePath);
  } else if (config.baselinePath) {
    const baseline = await readBaseline(config.baselinePath);
    if (baseline) {
      out.baseline = baseline;
      out.comparison = compareBaseline(
        report,
        baseline,
        config.regressionThreshold ?? 0.02,
      );
    }
  }

  return out;
}
