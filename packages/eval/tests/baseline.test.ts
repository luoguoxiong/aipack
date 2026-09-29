/**
 * baseline 回归门禁单测（M3 验收项）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEval } from '../src/core/runner.ts';
import {
  compareBaseline,
  readBaseline,
  reportToBaseline,
  writeBaseline,
} from '../src/core/report.ts';
import type { EvalCase, EvalReport } from '../src/core/types.ts';

function mockCase(id: string, text = 'hello'): EvalCase {
  return {
    id,
    suite: 'unit-baseline',
    origin: 'handwritten',
    input: { message: 'hi', mock: { turns: [{ text }] } },
    expected: { type: 'exact', value: 'hello' },
  };
}

async function reportOf(cases: EvalCase[]): Promise<EvalReport> {
  return runEval(cases, { mode: 'mock' });
}

describe('baseline 写读', () => {
  it('写入后可原样读回', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aipack-eval-'));
    const path = join(dir, 'eval-baseline.json');
    const report = await reportOf([mockCase('unit-baseline/a')]);
    await writeBaseline(report, path);

    const baseline = await readBaseline(path);
    assert.ok(baseline);
    assert.equal(baseline.runId, report.runId);
    assert.equal(baseline.totals.passRate, 1);
    assert.equal(baseline.bySuite['unit-baseline'].total, 1);
  });

  it('文件不存在返回 undefined', async () => {
    assert.equal(await readBaseline('/tmp/no-such-baseline.json'), undefined);
  });
});

describe('门禁判定', () => {
  it('通过率持平 → ok', async () => {
    const baseline = reportToBaseline(await reportOf([mockCase('unit-baseline/b')]));
    const current = await reportOf([mockCase('unit-baseline/b')]);
    const cmp = compareBaseline(current, baseline, 0.02);
    assert.equal(cmp.ok, true);
    assert.equal(cmp.overallDelta, 0);
    assert.deepEqual(cmp.regressions, []);
  });

  it('整体下降超阈值 → 不 ok', async () => {
    const baseline = reportToBaseline(await reportOf([mockCase('unit-baseline/c')]));
    const current = await reportOf([mockCase('unit-baseline/c', 'nope')]);
    const cmp = compareBaseline(current, baseline, 0.02);
    assert.equal(cmp.ok, false);
    assert.equal(cmp.overallDelta, -1);
    assert.equal(cmp.regressions.length, 1);
    assert.equal(cmp.regressions[0].suite, 'unit-baseline');
  });

  it('阈值内的小幅抖动 → 仍 ok', async () => {
    // 4 个用例挂 1 个 = -25%？构造 100 个太慢，这里直接校验阈值比较逻辑
    const baseline = reportToBaseline(await reportOf([mockCase('unit-baseline/d')]));
    const current = await reportOf([
      mockCase('unit-baseline/d1'),
      mockCase('unit-baseline/d2'),
      mockCase('unit-baseline/d3'),
      mockCase('unit-baseline/d4'),
      mockCase('unit-baseline/d5', 'bad'),
    ]);
    // baseline 里没有本次的 5 个用例（按 id 无关，按 suite 聚合）：
    // baseline 的 unit-baseline 通过率 100%，本次 80% → -20% 超阈值
    const cmp = compareBaseline(current, baseline, 0.02);
    assert.equal(cmp.ok, false);
    const tolerant = compareBaseline(current, baseline, 0.5);
    assert.equal(tolerant.ok, true, '阈值放宽到 50% 后应放行');
  });

  it('本次未跑的套件不判回归', async () => {
    const baseline = reportToBaseline(
      await reportOf([mockCase('unit-baseline/e'), { ...mockCase('unit-baseline/f'), suite: 'other' }]),
    );
    const current = await reportOf([mockCase('unit-baseline/e')]);
    const cmp = compareBaseline(current, baseline, 0.02);
    assert.equal(cmp.ok, true);
    assert.deepEqual(cmp.regressions, []);
  });

  it('通过率提升 → ok 且 delta 为正', async () => {
    const baseline = reportToBaseline(await reportOf([mockCase('unit-baseline/g', 'nope')]));
    const current = await reportOf([mockCase('unit-baseline/g')]);
    const cmp = compareBaseline(current, baseline, 0.02);
    assert.equal(cmp.ok, true);
    assert.equal(cmp.overallDelta, 1);
  });
});
