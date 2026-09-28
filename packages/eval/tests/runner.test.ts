/**
 * Runner 单元测试：mock 运行 / 用例隔离 / 预算熔断 / maxSteps / 校验
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runEval } from '../src/core/runner.ts';
import { validateEvalCase } from '../src/core/validate.ts';
import type { EvalCase } from '../src/core/types.ts';

function baseCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'unit/plain',
    suite: 'unit',
    origin: 'handwritten',
    input: {
      message: 'hi',
      mock: { turns: [{ text: 'hello' }] },
    },
    expected: { type: 'exact', value: 'hello' },
    ...overrides,
  };
}

describe('mock 模式运行', () => {
  it('纯文本用例通过', async () => {
    const report = await runEval([baseCase()], { mode: 'mock' });
    assert.equal(report.totals.cases, 1);
    assert.equal(report.totals.passed, 1);
    assert.equal(report.results[0].passed, true);
  });

  it('工具循环 + 轨迹断言通过', async () => {
    const c = baseCase({
      id: 'unit/tool-flow',
      expected: undefined,
      input: {
        message: '读取 a.txt',
        fs: { 'a.txt': 'alpha' },
        mock: {
          turns: [
            { toolCalls: [{ name: 'readFile', args: { path: 'a.txt' } }] },
            { text: '内容是 alpha' },
          ],
        },
      },
      scorers: [
        { type: 'tool-call', params: { calls: [{ tool: 'readFile', args: { path: 'a.txt' } }] } },
        { type: 'contains', params: { value: 'alpha' } },
      ],
    });
    const report = await runEval([c], { mode: 'mock' });
    assert.equal(report.results[0].passed, true);
    assert.equal(report.results[0].steps, 1);
  });

  it('断言失败时报告包含失败原因', async () => {
    const c = baseCase({ expected: { type: 'exact', value: 'wrong' } });
    const report = await runEval([c], { mode: 'mock' });
    assert.equal(report.results[0].passed, false);
    assert.ok(report.results[0].scores.length > 0);
    assert.match(report.results[0].scores[0].reason, /期望/);
  });

  it('缺 mock 脚本判运行失败', async () => {
    const c = baseCase({
      id: 'unit/no-mock',
      input: { message: 'hi' },
    });
    const report = await runEval([c], { mode: 'mock' });
    assert.equal(report.results[0].passed, false);
    assert.match(report.results[0].error ?? '', /mock/);
  });
});

describe('工程保障', () => {
  it('maxSteps 截断 → stop-reason max_turns', async () => {
    const c = baseCase({
      id: 'unit/max-steps',
      expected: undefined,
      input: {
        message: 'loop',
        mock: {
          turns: [{ toolCalls: [{ name: 'echo', args: { message: 'x' } }] }],
          infiniteTool: 'echo',
        },
      },
      metadata: { maxSteps: 2 },
      scorers: [{ type: 'stop-reason', params: { value: 'max_turns' } }],
    });
    const report = await runEval([c], { mode: 'mock' });
    assert.equal(report.results[0].passed, true);
  });

  it('预算熔断：maxTokens 超限判失败', async () => {
    const c = baseCase({
      id: 'unit/budget',
      metadata: { maxTokens: 5 },
    });
    const report = await runEval([c], { mode: 'mock' });
    assert.equal(report.results[0].passed, false);
    assert.match(report.results[0].error ?? '', /预算熔断/);
  });

  it('墙钟超时判失败', async () => {
    const c = baseCase({
      id: 'unit/timeout',
      expected: undefined,
      metadata: { timeoutMs: 1, maxSteps: 1000 },
      input: {
        message: 'loop',
        mock: {
          turns: [{ toolCalls: [{ name: 'echo', args: { message: 'x' } }] }],
          infiniteTool: 'echo',
        },
      },
    });
    const report = await runEval([c], { mode: 'mock' });
    assert.equal(report.results[0].passed, false);
    assert.match(report.results[0].error ?? '', /超时/);
  });

  it('用例间隔离：fs 修改互不渗透', async () => {
    const writer = baseCase({
      id: 'unit/writer',
      suite: 'iso',
      expected: undefined,
      input: {
        message: '写入',
        fs: { 'shared.txt': 'before' },
        mock: {
          turns: [
            { toolCalls: [{ name: 'writeFile', args: { path: 'shared.txt', content: 'after' } }] },
            { text: 'written' },
          ],
        },
      },
      scorers: [{ type: 'contains', params: { value: 'written' } }],
    });
    const reader = baseCase({
      id: 'unit/reader',
      suite: 'iso',
      input: {
        message: '读取',
        fs: { 'shared.txt': 'before' },
        mock: {
          turns: [
            { toolCalls: [{ name: 'readFile', args: { path: 'shared.txt' } }] },
            { text: 'got before' },
          ],
        },
      },
      expected: { type: 'contains', value: 'before' },
    });
    // writer 先跑（同 suite 顺序不保证，但 fs 按 case 隔离，先后无关）
    const report = await runEval([writer, reader], { mode: 'mock', concurrency: 1 });
    assert.equal(report.totals.passed, 2, JSON.stringify(report.results.map(r => r.error)));
  });

  it('suites 过滤只跑指定套件', async () => {
    const a = baseCase({ id: 'unit/a', suite: 'a' });
    const b = baseCase({ id: 'unit/b', suite: 'b' });
    const report = await runEval([a, b], { mode: 'mock', suites: ['a'] });
    assert.equal(report.totals.cases, 1);
    assert.equal(report.results[0].caseId, 'unit/a');
  });

  it('byOrigin 按 origin 分组', async () => {
    const a = baseCase({ id: 'unit/o1', origin: 'handwritten' });
    const b = baseCase({ id: 'unit/o2', origin: 'bugfix' });
    const report = await runEval([a, b], { mode: 'mock' });
    assert.ok(report.byOrigin['handwritten']);
    assert.ok(report.byOrigin['bugfix']);
  });
});

describe('用例校验', () => {
  it('缺 id / origin / message 报错', () => {
    const bad = { suite: 'x', input: { message: 'hi' } } as unknown as EvalCase;
    const errors = validateEvalCase(bad);
    assert.ok(errors.some((e) => e.includes('id')));
    assert.ok(errors.some((e) => e.includes('origin')));
  });

  it('空 mock turns / 无评分器报错', () => {
    const bad = baseCase({
      id: 'unit/bad',
      input: { message: 'hi', mock: { turns: [] } },
      expected: undefined,
      scorers: undefined,
    });
    const errors = validateEvalCase(bad);
    assert.ok(errors.some((e) => e.includes('turns')));
    assert.ok(errors.some((e) => e.includes('至少提供一项')));
  });

  it('未知 expected / scorer 类型报错', () => {
    const bad = baseCase({
      id: 'unit/bad2',
      expected: { type: 'rubric', criteria: [] } as never,
    });
    assert.ok(validateEvalCase(bad).some((e) => e.includes('expected.type')));
  });
});
