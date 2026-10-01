/**
 * 评分器单元测试：正例 + 负例（验证判别力）+ expected 归一化
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  expectedToScorers,
  resolveScorers,
  scoreTrace,
  partialMatch,
} from '../src/core/scorer/index.ts';
import type { RunTrace } from '../src/core/types.ts';

// ─── 构造最小 RunTrace ───────────────────────────────────────────

function makeTrace(overrides: Partial<RunTrace> = {}): RunTrace {
  return {
    caseId: 't/test',
    suite: 't',
    origin: 'handwritten',
    result: {
      content: 'answer is 42',
      toolsUsed: ['echo'],
      usage: { input: 10, output: 5, total: 15 },
      stopReason: 'completed',
      metadata: {},
      success: true,
    },
    trajectory: [
      { id: 'tc1', name: 'echo', args: { message: 'hi', extra: 1 }, isError: false },
      { id: 'tc2', name: 'fail', args: {}, isError: true },
    ],
    messages: [],
    durationMs: 1,
    usageTotal: 15,
    turns: 1,
    ...overrides,
  };
}

describe('expectedToScorers 归一化', () => {
  it('八种 expected 类型都映射到规则评分器', () => {
    const cases = [
      { type: 'exact', value: 'x' },
      { type: 'contains', value: 'x' },
      { type: 'regex', value: 'x' },
      { type: 'tool-call', calls: [{ tool: 't' }] },
      { type: 'tools-used', tools: ['t'] },
      { type: 'json-field', path: 'a', value: 1 },
      { type: 'success' },
      { type: 'stop-reason', value: 'stop' },
    ] as const;
    for (const e of cases) {
      const scorers = expectedToScorers(e as never);
      assert.equal(scorers.length, 1);
      assert.equal(scorers[0].type, e.type);
    }
  });

  it('resolveScorers 合并 expected 与显式 scorers', () => {
    const merged = resolveScorers(
      { type: 'contains', value: 'x' },
      [{ type: 'success', params: { value: true } }],
    );
    assert.equal(merged.length, 2);
  });
});

describe('partialMatch 部分匹配', () => {
  it('未列出字段不比较', () => {
    assert.ok(partialMatch({ message: 'hi' }, { message: 'hi', extra: 1 }));
  });
  it('字段值不等则失败', () => {
    assert.ok(!partialMatch({ message: 'hi' }, { message: 'no' }));
  });
  it('嵌套对象递归比较', () => {
    assert.ok(partialMatch({ a: { b: 1 } }, { a: { b: 1, c: 2 }, d: 3 }));
    assert.ok(!partialMatch({ a: { b: 1 } }, { a: { b: 2 } }));
  });
  it('数组长度必须相等', () => {
    assert.ok(partialMatch([1, 2], [1, 2]));
    assert.ok(!partialMatch([1], [1, 2]));
  });
  it('undefined 视为通配', () => {
    assert.ok(partialMatch(undefined, 'anything'));
  });
});

describe('文本评分器', () => {
  it('exact 正负例', async () => {
    const t = makeTrace();
    assert.ok((await scoreTrace(t, [{ type: 'exact', params: { value: 'answer is 42' } }])).passed);
    assert.ok(!(await scoreTrace(t, [{ type: 'exact', params: { value: 'nope' } }])).passed);
  });

  it('contains 正负例', async () => {
    const t = makeTrace();
    assert.ok((await scoreTrace(t, [{ type: 'contains', params: { value: '42' } }])).passed);
    assert.ok(!(await scoreTrace(t, [{ type: 'contains', params: { value: '43' } }])).passed);
  });

  it('regex 正负例 + flags', async () => {
    const t = makeTrace();
    assert.ok((await scoreTrace(t, [{ type: 'regex', params: { value: '\\d+' } }])).passed);
    assert.ok(!(await scoreTrace(t, [{ type: 'regex', params: { value: '^\\d+$' } }])).passed);
    assert.ok(
      (await scoreTrace(t, [{ type: 'regex', params: { value: '^ANSWER', flags: 'i' } }])).passed,
    );
  });

  it('json-field：合法 JSON / 非法 JSON / 路径缺失', async () => {
    const ok = makeTrace({ result: { ...makeTrace().result, content: '{"a":{"b":1}}' } });
    assert.ok(
      (await scoreTrace(ok, [{ type: 'json-field', params: { path: 'a.b', value: 1 } }])).passed,
    );
    const badJson = makeTrace({ result: { ...makeTrace().result, content: 'not json' } });
    assert.ok(
      !(await scoreTrace(badJson, [{ type: 'json-field', params: { path: 'a' } }])).passed,
    );
    const missing = makeTrace({ result: { ...makeTrace().result, content: '{"a":1}' } });
    assert.ok(
      !(await scoreTrace(missing, [{ type: 'json-field', params: { path: 'a.b' } }])).passed,
    );
  });
});

describe('轨迹评分器', () => {
  it('tool-call subset：乱序插入不影响子序列命中', async () => {
    const t = makeTrace();
    // 实际轨迹: echo, fail
    const s = await scoreTrace(t, [
      { type: 'tool-call', params: { calls: [{ tool: 'echo' }] } },
    ]);
    assert.ok(s.passed);
  });

  it('tool-call subset：顺序颠倒失败', async () => {
    const t = makeTrace(); // echo → fail
    const s = await scoreTrace(t, [
      { type: 'tool-call', params: { calls: [{ tool: 'fail' }, { tool: 'echo' }] } },
    ]);
    assert.ok(!s.passed);
  });

  it('tool-call exact：数量不符失败', async () => {
    const t = makeTrace(); // 2 条
    const s = await scoreTrace(t, [
      { type: 'tool-call', params: { calls: [{ tool: 'echo' }], order: 'exact' } },
    ]);
    assert.ok(!s.passed);
  });

  it('tool-call isError 断言', async () => {
    const t = makeTrace();
    assert.ok(
      (
        await scoreTrace(t, [
          { type: 'tool-call', params: { calls: [{ tool: 'fail', isError: true }] } },
        ])
      ).passed,
    );
    assert.ok(
      !(
        await scoreTrace(t, [
          { type: 'tool-call', params: { calls: [{ tool: 'echo', isError: true }] } },
        ])
      ).passed,
    );
  });

  it('tools-used 集合相等断言', async () => {
    const t = makeTrace();
    assert.ok(
      (await scoreTrace(t, [{ type: 'tools-used', params: { tools: ['echo'] } }])).passed,
    );
    assert.ok(
      !(await scoreTrace(t, [{ type: 'tools-used', params: { tools: ['echo', 'other'] } }])).passed,
    );
  });
});

describe('状态评分器', () => {
  it('success / stop-reason 正负例', async () => {
    const t = makeTrace();
    assert.ok((await scoreTrace(t, [{ type: 'success', params: {} }])).passed);
    assert.ok(!(await scoreTrace(t, [{ type: 'success', params: { value: false } }])).passed);
    assert.ok(!(await scoreTrace(t, [{ type: 'stop-reason', params: { value: 'max_turns' } }])).passed);
  });

  it('未知评分器类型判失败而非抛出', async () => {
    const s = await scoreTrace(makeTrace(), [
      { type: 'no-such-scorer' as never, params: {} },
    ]);
    assert.ok(!s.passed);
    assert.match(s.scores[0].reason, /未知评分器类型/);
  });

  it('多评分器全部通过才 passed，加权分正确', async () => {
    const t = makeTrace();
    const s = await scoreTrace(t, [
      { type: 'contains', params: { value: '42' } },
      { type: 'success', params: {} },
    ]);
    assert.ok(s.passed);
    assert.equal(s.score, 1);
    const mixed = await scoreTrace(t, [
      { type: 'contains', params: { value: '42' }, weight: 3 },
      { type: 'contains', params: { value: '43' }, weight: 1 },
    ]);
    assert.ok(!mixed.passed);
    assert.equal(mixed.score, 0.75);
  });
});
