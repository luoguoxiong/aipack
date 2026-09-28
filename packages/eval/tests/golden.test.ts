/**
 * M1 验收：全部 golden 用例在 mock 模式下跑通（< 1 分钟）
 * 同时验证用例加载无错误、数量达到 M1 目标（>= 30）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadCases } from '../src/core/loader.ts';
import { runEval } from '../src/core/runner.ts';
import { renderMarkdown } from '../src/core/report.ts';

describe('golden 用例集（M1 验收）', () => {
  it('加载无错误且数量达标（>= 30）', async () => {
    const { cases, errors } = await loadCases();
    assert.deepEqual(errors, []);
    assert.ok(cases.length >= 30, `golden 用例应 >= 30，实际 ${cases.length}`);
  });

  it('全部用例 mock 模式通过', { timeout: 60_000 }, async () => {
    const { cases } = await loadCases();
    const startedAt = Date.now();
    const report = await runEval(cases, { mode: 'mock' });
    const durationMs = Date.now() - startedAt;

    const failures = report.results.filter((r) => !r.passed);
    const detail = failures
      .map(
        (f) =>
          `\n  ${f.caseId}: ${f.error ?? f.scores.filter((s) => !s.passed).map((s) => s.reason).join(' | ')}`,
      )
      .join('');

    assert.equal(
      failures.length,
      0,
      `${failures.length}/${report.totals.cases} 个用例失败:${detail}`,
    );
    assert.ok(durationMs < 60_000, `总耗时 ${durationMs}ms 应 < 60s`);
  });

  it('Markdown 报告可渲染且含分组统计', async () => {
    const { cases } = await loadCases();
    const report = await runEval(cases, { mode: 'mock' });
    const md = renderMarkdown(report);
    assert.match(md, /# aipack Eval 报告/);
    assert.match(md, /按套件/);
    assert.match(md, /按来源/);
    assert.match(md, /agent-e2e/);
    assert.match(md, /tool-calling/);
    assert.match(md, /text-output/);
  });
});
