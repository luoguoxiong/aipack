/**
 * M4 入库（importCases）与 M5 L4 对比渲染（renderComparisonMarkdown）单元测试
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importCases } from '../src/core/import.ts';
import { compareModels, renderComparisonMarkdown } from '../src/core/compare.ts';
import { runEval } from '../src/core/runner.ts';
import type { EvalCase } from '../src/core/types.ts';
import type { StreamFn } from '@aipack-ai/agent';

// ─── importCases ──────────────────────────────────────────────────

const exportedCase = {
  id: 'trace-export/t-abc',
  suite: 'trace-export',
  description: 'trace 回流: model=deepseek/deepseek-chat status=success turns=2',
  mode: 'live',
  input: { message: '帮我把 a.txt 内容复制到 b.txt' },
  expected: {
    type: 'tool-call',
    calls: [
      { tool: 'readFile', isError: false },
      { tool: 'writeFile', isError: false },
    ],
    order: 'exact',
  },
  origin: 'trace',
  metadata: { tags: ['app1', 'deepseek-chat', 'success'], maxSteps: 12, timeoutMs: 60000 },
};

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'eval-import-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('importCases（M4 入库）', () => {
  it('导出数组入库：写 <out-dir>/<suite>/<id>.json', async () => {
    await withTmp(async (dir) => {
      const file = join(dir, 'export.json');
      await writeFile(file, JSON.stringify([exportedCase]), 'utf-8');
      const { written, errors } = await importCases({ file, outDir: join(dir, 'cases') });
      assert.deepEqual(errors, []);
      assert.deepEqual(written, ['trace-export/t-abc.json']);
      const saved = JSON.parse(
        await readFile(join(dir, 'cases', 'trace-export', 't-abc.json'), 'utf-8'),
      );
      assert.equal(saved.id, 'trace-export/t-abc');
      assert.equal(saved.origin, 'trace');
    });
  });

  it('{cases:[...]} 形态 + suite/origin/prefix 覆盖', async () => {
    await withTmp(async (dir) => {
      const file = join(dir, 'export.json');
      await writeFile(file, JSON.stringify({ cases: [exportedCase] }), 'utf-8');
      const { written, errors } = await importCases({
        file,
        outDir: join(dir, 'cases'),
        suite: 'bugfix-regression',
        origin: 'bugfix',
        prefix: 'bugfix',
      });
      assert.deepEqual(errors, []);
      assert.deepEqual(written, ['bugfix-regression/t-abc.json']);
      const saved = JSON.parse(
        await readFile(join(dir, 'cases', 'bugfix-regression', 't-abc.json'), 'utf-8'),
      );
      assert.equal(saved.id, 'bugfix/trace-export/t-abc');
      assert.equal(saved.origin, 'bugfix');
    });
  });

  it('校验失败的用例不写盘并进入 errors', async () => {
    await withTmp(async (dir) => {
      const file = join(dir, 'export.json');
      await writeFile(
        file,
        JSON.stringify([{ ...exportedCase, input: {} }]),
        'utf-8',
      );
      const { written, errors } = await importCases({ file, outDir: join(dir, 'cases') });
      assert.equal(written.length, 0);
      assert.ok(errors[0].includes('input.message'));
    });
  });

  it('dry-run 只校验不写盘；重名自动追加序号不覆盖', async () => {
    await withTmp(async (dir) => {
      const file = join(dir, 'export.json');
      await writeFile(file, JSON.stringify([exportedCase]), 'utf-8');
      const dry = await importCases({ file, outDir: join(dir, 'cases'), dryRun: true });
      assert.equal(dry.written.length, 1);
      const first = await importCases({ file, outDir: join(dir, 'cases') });
      assert.equal(first.written.length, 1);
      const second = await importCases({ file, outDir: join(dir, 'cases') });
      assert.deepEqual(second.written, ['trace-export/t-abc-1.json'], '不应覆盖已入库文件');
    });
  });
});

// ─── L4 compare ───────────────────────────────────────────────────

function makeCase(id: string, text: string): EvalCase {
  return {
    id,
    suite: 'cmp',
    mode: 'mock',
    origin: 'handwritten',
    input: {
      message: 'say',
      mock: { turns: [{ text }] },
    },
    expected: { type: 'contains', value: text },
  };
}

function fakeStreamFn(text: string): StreamFn {
  return (async function* () {
    yield {
      type: 'done' as const,
      message: {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text }],
        stopReason: 'stop',
        usage: { input: 1, output: 1, total: 2 },
        timestamp: Date.now(),
      },
    };
  }) as unknown as StreamFn;
}

describe('compareModels + renderComparisonMarkdown（L4）', () => {
  it('多模型各跑一遍并渲染对比表', async () => {
    const cases = [makeCase('cmp/a', 'alpha'), makeCase('cmp/b', 'beta')];
    // 注入不同 streamFn 模拟两个模型：A 总过，B 挂
    const reportA = await runEval(cases, { mode: 'mock', streamFn: fakeStreamFn('alpha') });
    const reportB = await runEval(cases, { mode: 'mock', streamFn: fakeStreamFn('总是同一句话') });

    const comparison = {
      startedAt: new Date().toISOString(),
      durationMs: 10,
      mode: 'mock' as const,
      suites: ['cmp'],
      entries: [
        { model: 'model-a', report: reportA },
        { model: 'model-b', report: reportB },
      ],
    };

    const md = renderComparisonMarkdown(comparison as never);
    assert.ok(md.includes('model-a'));
    assert.ok(md.includes('model-b'));
    assert.ok(md.includes('100.0%'));
    assert.ok(md.includes('分套件通过率'));
  });

  it('compareModels 空模型列表抛错', async () => {
    await assert.rejects(() => compareModels([], { mode: 'mock' }, []));
  });
});
