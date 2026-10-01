/**
 * M5 评分器单元测试：semantic（stub embedding）+ llm-judge（stub judge）
 * + 分发链路跳过语义 + judge 异源校验
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cosineSimilarity,
  runSemanticScorer,
} from '../src/core/scorer/semantic.ts';
import {
  buildJudgePrompt,
  parseJudgeResponse,
  runLlmJudge,
  JUDGE_PROMPT_VERSION,
} from '../src/core/scorer/llm-judge.ts';
import { scoreTrace, ALL_SCORER_TYPES } from '../src/core/scorer/index.ts';
import { assertJudgeDistinct, resolveJudgeSpec } from '../src/core/live.ts';
import { createCompleteFromStreamFn } from '../src/core/judge-llm.ts';
import type { RunTrace } from '../src/core/types.ts';
import type { StreamFn } from '@aipack-ai/agent';

function makeTrace(content = 'answer is 42'): RunTrace {
  return {
    caseId: 't/test',
    suite: 't',
    origin: 'handwritten',
    result: {
      content,
      toolsUsed: ['echo'],
      usage: { input: 10, output: 5, total: 15 },
      stopReason: 'completed',
      metadata: {},
      success: true,
    },
    trajectory: [{ id: 'tc1', name: 'echo', args: { message: 'hi' }, isError: false }],
    messages: [],
    durationMs: 1,
    usageTotal: 15,
    turns: 1,
  };
}

// ─── semantic ─────────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('相同向量 = 1，正交 = 0，反向 = -1，零向量 = 0，维度不等 = 0', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9);
    assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
    assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-9);
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
    assert.equal(cosineSimilarity([1], [1, 1]), 0);
  });
});

describe('runSemanticScorer', () => {
  const embed = async (text: string): Promise<number[]> =>
    text.includes('42') ? [1, 0, 0] : [0, 1, 0];

  it('相似度过阈值 → passed，score=相似度', async () => {
    const r = await runSemanticScorer(makeTrace('answer is 42'), { expected: 'the answer 42', threshold: 0.5 }, embed);
    assert.ok(r);
    assert.equal(r.passed, true);
    assert.equal(r.score, 1);
  });

  it('低于阈值 → 不通过，score=0', async () => {
    const r = await runSemanticScorer(makeTrace('unrelated'), { expected: 'answer 42', threshold: 0.5 }, embed);
    assert.ok(r);
    assert.equal(r.passed, false);
    assert.equal(r.score, 0);
  });

  it('缺 embed 注入点 → 跳过（undefined）', async () => {
    const r = await runSemanticScorer(makeTrace(), { expected: 'x' });
    assert.equal(r, undefined);
  });

  it('embedding 抛错 → 跳过（不判用例失败）', async () => {
    const r = await runSemanticScorer(makeTrace(), { expected: 'x' }, async () => {
      throw new Error('provider down');
    });
    assert.equal(r, undefined);
  });
});

// ─── llm-judge ────────────────────────────────────────────────────

describe('buildJudgePrompt / parseJudgeResponse', () => {
  it('prompt 含 rubric、输出与轨迹，并带 prompt 版本', () => {
    const prompt = buildJudgePrompt(
      { criteria: ['回答正确', '语气友好'] },
      'answer',
      [{ id: '1', name: 'echo', args: { a: 1 }, isError: false }],
    );
    assert.ok(prompt.includes(`v${JUDGE_PROMPT_VERSION}`));
    assert.ok(prompt.includes('1. 回答正确'));
    assert.ok(prompt.includes('2. 语气友好'));
    assert.ok(prompt.includes('answer'));
    assert.ok(prompt.includes('echo'));
  });

  it('解析合法 JSON（含前后噪音文本）', () => {
    const v = parseJudgeResponse('好的，结果如下：\n{"score": 0.8, "reason": "基本正确", "evidence": "42"}\n完毕');
    assert.ok(v);
    assert.equal(v.score, 0.8);
    assert.equal(v.reason, '基本正确');
    assert.equal(v.evidence, '42');
  });

  it('score 越界收敛到 0~1；缺 reason 给占位', () => {
    assert.equal(parseJudgeResponse('{"score": 3, "reason": "x"}')?.score, 1);
    assert.equal(parseJudgeResponse('{"score": -2}')?.score, 0);
    assert.ok(parseJudgeResponse('{"score": 0.5}')?.reason.includes('judge'));
  });

  it('非法输出 → undefined（scorer 自身错误 → 跳过）', () => {
    assert.equal(parseJudgeResponse('我觉得不错'), undefined);
    assert.equal(parseJudgeResponse('{"score": "high"}'), undefined);
  });
});

describe('runLlmJudge', () => {
  const deps = {
    complete: async () => '{"score": 1, "reason": "完全符合 rubric", "evidence": "42"}',
    modelLabel: 'other/gpt-judge',
  };

  it('judge 通过 → score=1，reason 带 judge 标识与版本', async () => {
    const r = await runLlmJudge(makeTrace(), { criteria: ['正确'] }, deps);
    assert.ok(r);
    assert.equal(r.passed, true);
    assert.equal(r.score, 1);
    assert.ok(r.reason.includes('other/gpt-judge'));
  });

  it('judge 未装配 → 跳过', async () => {
    assert.equal(await runLlmJudge(makeTrace(), { criteria: ['x'] }), undefined);
  });

  it('judge 调用失败 / 输出非法 → 跳过（不判用例失败）', async () => {
    assert.equal(
      await runLlmJudge(makeTrace(), { criteria: ['x'] }, { complete: async () => { throw new Error('429'); } }),
      undefined,
    );
    assert.equal(
      await runLlmJudge(makeTrace(), { criteria: ['x'] }, { complete: async () => '好' }),
      undefined,
    );
  });

  it('criteria 缺失 → 评分器自身失败（不跳过）', async () => {
    const r = await runLlmJudge(makeTrace(), {} as never, deps);
    assert.ok(r);
    assert.equal(r.passed, false);
    assert.ok(r.reason.includes('criteria'));
  });
});

// ─── 分发链路 ─────────────────────────────────────────────────────

describe('scoreTrace 分发（M5）', () => {
  it('ALL_SCORER_TYPES 含 semantic / llm-judge', () => {
    assert.ok(ALL_SCORER_TYPES.includes('semantic'));
    assert.ok(ALL_SCORER_TYPES.includes('llm-judge'));
  });

  it('rule + semantic 混合：加权合成，semantic 参与 pass 判定', async () => {
    const embed = async (t: string): Promise<number[]> => (t.includes('42') ? [1, 0] : [0, 1]);
    const r = await scoreTrace(
      makeTrace(),
      [
        { type: 'contains', params: { value: '42' }, weight: 1 },
        { type: 'semantic', params: { expected: 'answer 42', threshold: 0.5 }, weight: 3 },
      ],
      { embed },
    );
    assert.equal(r.passed, true);
    assert.equal(r.skippedScorers.length, 0);
    // (1*1 + 1*3) / 4 = 1
    assert.ok(Math.abs(r.score - 1) < 1e-9);
  });

  it('缺装配时 semantic / llm-judge 跳过，不影响规则判定', async () => {
    const r = await scoreTrace(
      makeTrace(),
      [
        { type: 'contains', params: { value: '42' } },
        { type: 'semantic', params: { expected: 'x' } },
        { type: 'llm-judge', params: { criteria: ['x'] } },
      ],
    );
    assert.equal(r.passed, true);
    assert.deepEqual(r.skippedScorers.sort(), ['llm-judge', 'semantic']);
    assert.equal(r.scores.length, 1);
  });

  it('llm-judge 正常装配时参与判定（失败 → 用例失败）', async () => {
    const r = await scoreTrace(
      makeTrace(),
      [{ type: 'llm-judge', params: { criteria: ['必须提到 7'] } }],
      { judge: { complete: async () => '{"score": 0, "reason": "没有提到"}' } },
    );
    assert.equal(r.passed, false);
    assert.equal(r.score, 0);
  });
});

// ─── judge 装配 ───────────────────────────────────────────────────

describe('assertJudgeDistinct 异源校验', () => {
  it('同 provider + 同 modelId → 抛错', () => {
    assert.throws(
      () => assertJudgeDistinct({ provider: 'deepseek', modelId: 'deepseek-chat' }, { provider: 'deepseek', modelId: 'deepseek-chat' }),
      /异源/,
    );
  });

  it('同 provider 不同 modelId → 允许（告警）', () => {
    assert.doesNotThrow(() =>
      assertJudgeDistinct({ provider: 'deepseek', modelId: 'deepseek-chat' }, { provider: 'deepseek', modelId: 'deepseek-reasoner' }),
    );
  });

  it('跨 provider → 允许', () => {
    assert.doesNotThrow(() =>
      assertJudgeDistinct({ provider: 'deepseek', modelId: 'deepseek-chat' }, { provider: 'openai', modelId: 'gpt-4o-mini' }),
    );
  });

  it('被测模型未知（mock / 注入）→ 不校验', () => {
    assert.doesNotThrow(() => assertJudgeDistinct(undefined, { provider: 'openai', modelId: 'gpt-4o-mini' }));
  });
});

describe('resolveJudgeSpec env 装配', () => {
  it('缺 model 配置 → 抛可操作错误', () => {
    const old = process.env.AIPACK_EVAL_JUDGE_MODEL;
    delete process.env.AIPACK_EVAL_JUDGE_MODEL;
    try {
      assert.throws(() => resolveJudgeSpec({}), /judge-model/);
    } finally {
      if (old !== undefined) process.env.AIPACK_EVAL_JUDGE_MODEL = old;
    }
  });

  it('显式 model 参数优先并强制 temperature 0', () => {
    const old = process.env.AIPACK_EVAL_JUDGE_MODEL;
    process.env.AIPACK_EVAL_JUDGE_MODEL = 'openai/gpt-judge-env';
    try {
      const spec = resolveJudgeSpec({ model: 'anthropic/claude-judge', apiKey: 'k' });
      assert.equal(spec.provider, 'anthropic');
      assert.equal(spec.modelId, 'claude-judge');
      assert.equal(spec.temperature, 0);
    } finally {
      if (old !== undefined) process.env.AIPACK_EVAL_JUDGE_MODEL = old;
      else delete process.env.AIPACK_EVAL_JUDGE_MODEL;
    }
  });
});

describe('createCompleteFromStreamFn', () => {
  it('聚合 text_delta 为完整回复', async () => {
    const streamFn = (async function* () {
      yield { type: 'text_delta' as const, delta: '你好', contentIndex: 0 };
      yield { type: 'text_delta' as const, delta: '，世界', contentIndex: 0 };
      yield {
        type: 'done' as const,
        reason: 'stop' as const,
        message: {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: '你好，世界' }],
          stopReason: 'stop',
          usage: { input: 1, output: 1, total: 2 },
          timestamp: Date.now(),
        },
      };
    }) as unknown as StreamFn;
    const complete = createCompleteFromStreamFn(streamFn, undefined);
    assert.equal(await complete('hi'), '你好，世界');
  });

  it('error 事件 → 抛错', async () => {
    const streamFn = (async function* () {
      yield { type: 'error' as const, reason: 'aborted' as const, error: {} as never };
    }) as unknown as StreamFn;
    const complete = createCompleteFromStreamFn(streamFn, undefined);
    await assert.rejects(() => complete('hi'), /judge/);
  });
});
