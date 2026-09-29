/**
 * 历史趋势单测：JSONL 追加 / 读回 / 日环比渲染（M3 验收项）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEval } from '../src/core/runner.ts';
import {
  appendHistory,
  readHistory,
  renderHistoryTrend,
  reportToHistoryEntry,
  sparkline,
} from '../src/core/history.ts';
import type { EvalCase } from '../src/core/types.ts';

function mockCase(id: string): EvalCase {
  return {
    id,
    suite: 'unit-history',
    origin: 'handwritten',
    input: { message: 'hi', mock: { turns: [{ text: 'hello' }] } },
    expected: { type: 'exact', value: 'hello' },
  };
}

async function tmpFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aipack-eval-'));
  return join(dir, name);
}

describe('history JSONL', () => {
  it('追加两条后可读回，且保持时间序', async () => {
    const path = await tmpFile('history.jsonl');
    const r1 = await runEval([mockCase('unit-history/a')], { mode: 'mock' });
    const r2 = await runEval([mockCase('unit-history/b')], { mode: 'mock' });

    await appendHistory(r1, path);
    await appendHistory(r2, path);

    const raw = await readFile(path, 'utf-8');
    assert.equal(raw.trim().split('\n').length, 2);

    const entries = await readHistory(path);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].runId, r1.runId);
    assert.equal(entries[1].runId, r2.runId);
    assert.equal(entries[0].passRate, 1);
    assert.equal(entries[0].cases, 1);
  });

  it('文件不存在时返回空数组', async () => {
    assert.deepEqual(await readHistory('/tmp/definitely-not-exists.jsonl'), []);
  });

  it('坏行跳过，不影响其余记录', async () => {
    const path = await tmpFile('history.jsonl');
    const r = await runEval([mockCase('unit-history/c')], { mode: 'mock' });
    await appendHistory(r, path);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(path, '{not json}\n', 'utf-8');
    const entries = await readHistory(path);
    assert.equal(entries.length, 1);
  });

  it('reportToHistoryEntry 携带分组与指标', async () => {
    const r = await runEval([mockCase('unit-history/d')], { mode: 'mock' });
    const e = reportToHistoryEntry(r);
    assert.equal(e.mode, 'mock');
    assert.ok(e.bySuite['unit-history']);
    assert.equal(typeof e.durationMs, 'number');
  });
});

describe('趋势渲染', () => {
  it('sparkline 边界', () => {
    assert.equal(sparkline([]), '');
    assert.equal(sparkline([0, 1]), '▁█');
    assert.equal(sparkline([0.5, 0.5, 0.5]), '▅▅▅');
  });

  it('渲染含 sparkline 与环比 Δ', async () => {
    const path = await tmpFile('history.jsonl');
    const pass = await runEval([mockCase('unit-history/e')], { mode: 'mock' });
    const fail = await runEval(
      [
        {
          id: 'unit-history/f',
          suite: 'unit-history',
          origin: 'handwritten',
          input: { message: 'hi', mock: { turns: [{ text: 'nope' }] } },
          expected: { type: 'exact', value: 'hello' },
        },
      ],
      { mode: 'mock' },
    );
    await appendHistory(pass, path);
    await appendHistory(fail, path);

    const md = renderHistoryTrend(await readHistory(path));
    assert.match(md, /▁|█/);
    assert.match(md, /环比/);
    assert.match(md, /🔻/); // 100% → 0% 的下滑
    assert.match(md, /\| 时间\(UTC\) \|/);
    assert.match(md, /分套件环比/);
  });

  it('无历史时给出占位文案', () => {
    assert.match(renderHistoryTrend([]), /暂无历史记录/);
  });
});
