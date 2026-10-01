/**
 * packages/eval/src/core/compare.ts - L4 模型 / Provider 对比（M5）
 *
 * 同一组用例在多个被测模型上各跑一遍 runEval（顺序执行，各算各的
 * 预算与 repeats），汇总出通过率 / 平均分 / token 成本 / 延迟 /
 * 分套件通过率矩阵。judge / embed 装配沿用 base config（judge 异源
 * 校验对每个被测模型独立生效）。
 */

import { runEval } from './runner';
import type { EvalCase, EvalReport, RunConfig, SuiteSummary } from './types';

export interface ModelComparisonEntry {
  /** 被测模型标识（'provider/modelId'） */
  model: string;
  report: EvalReport;
}

export interface ComparisonReport {
  startedAt: string;
  durationMs: number;
  mode: 'mock' | 'live';
  suites: string[];
  entries: ModelComparisonEntry[];
}

/** 逐个模型跑同一组用例（顺序执行，避免跨模型并发互扰限流） */
export async function compareModels(
  cases: EvalCase[],
  base: RunConfig,
  models: string[],
): Promise<ComparisonReport> {
  if (models.length === 0) throw new Error('compareModels 需要至少一个模型');
  const startedAt = Date.now();
  const entries: ModelComparisonEntry[] = [];
  for (const model of models) {
    const report = await runEval(cases, { ...base, model });
    entries.push({ model, report });
  }
  return {
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    mode: base.mode,
    suites: base.suites ?? [],
    entries,
  };
}

// ─── Markdown 渲染 ────────────────────────────────────────────────

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/** 单模型平均每 case 耗时（含 repeats） */
function avgDurationMs(entry: ModelComparisonEntry): number {
  const rs = entry.report.results;
  if (rs.length === 0) return 0;
  return rs.reduce((a, r) => a + r.durationMs, 0) / rs.length;
}

function allSuites(entries: ModelComparisonEntry[]): string[] {
  const set = new Set<string>();
  for (const e of entries) for (const s of Object.keys(e.report.bySuite)) set.add(s);
  return [...set].sort();
}

/**
 * 对比表（报告按被测模型逐列对比；passRate 用 runEval 同一口径：
 * 跳过用例不计入分母）。
 */
export function renderComparisonMarkdown(cmp: ComparisonReport): string {
  const lines: string[] = [];
  lines.push('# L4 模型 / Provider 对比');
  lines.push('');
  lines.push(`- 模式: ${cmp.mode}`);
  lines.push(`- 开始: ${cmp.startedAt}`);
  lines.push(`- 总耗时: ${cmp.durationMs}ms`);
  lines.push('');

  // 总览
  lines.push('## 总览');
  lines.push('');
  lines.push('| 模型 | 用例 | 通过率 | 平均分 | token 总耗 | 平均耗时/case |');
  lines.push('|---|---|---|---|---|---|');
  for (const e of cmp.entries) {
    const t = e.report.totals;
    lines.push(
      `| ${e.model} | ${t.cases} | ${pct(t.passRate)} | ${t.avgScore.toFixed(3)} | ${t.usageTotal} | ${Math.round(avgDurationMs(e))}ms |`,
    );
  }
  lines.push('');

  // 分套件矩阵
  const suites = allSuites(cmp.entries);
  if (suites.length > 0) {
    lines.push('## 分套件通过率');
    lines.push('');
    lines.push(`| 套件 | ${cmp.entries.map((e) => e.model).join(' | ')} |`);
    lines.push(`|---|${cmp.entries.map(() => '---').join('|')}|`);
    for (const suite of suites) {
      const cells = cmp.entries.map((e) => {
        const s: SuiteSummary | undefined = e.report.bySuite[suite];
        return s ? `${pct(s.passRate)} (${s.passed}/${s.total})` : '—';
      });
      lines.push(`| ${suite} | ${cells.join(' | ')} |`);
    }
    lines.push('');
  }

  // 失败明细（每模型最多列 5 条，防报告爆炸）
  for (const e of cmp.entries) {
    const failed = e.report.results.filter((r) => !r.passed);
    if (failed.length === 0) continue;
    lines.push(`## 失败用例 — ${e.model}`);
    lines.push('');
    for (const r of failed.slice(0, 5)) {
      const reason = r.error ?? r.scores.find((s) => !s.passed)?.reason ?? '';
      lines.push(`- ${r.caseId}（score ${r.score.toFixed(3)}）: ${reason}`);
    }
    if (failed.length > 5) lines.push(`- …共 ${failed.length} 条失败`);
    lines.push('');
  }

  return lines.join('\n');
}
