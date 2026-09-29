/**
 * live 模式单测（不联网）：
 *   - 模型规格解析 / env 覆盖 / 装配（createLiveLlm 只建闭包，不发请求）
 *   - Runner live 分支（注入假 streamFn）：repeats、pass@k、模式跳过
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runEval, skipReason } from '../src/core/runner.ts';
import { createMockStreamFn } from '../src/core/mock-stream.ts';
import {
  assertLiveReady,
  createLiveLlm,
  describeLiveLlm,
  parseModelSpec,
  resolveLiveSpec,
} from '../src/core/live.ts';
import type { EvalCase } from '../src/core/types.ts';

function liveCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'unit-live/plain',
    suite: 'unit-live',
    mode: 'live',
    origin: 'handwritten',
    input: { message: 'hi' },
    expected: { type: 'contains', value: 'pong' },
    ...overrides,
  };
}

describe('模型规格解析', () => {
  it('provider/modelId 拆分', () => {
    assert.deepEqual(parseModelSpec('deepseek/deepseek-chat'), {
      provider: 'deepseek',
      modelId: 'deepseek-chat',
    });
  });

  it('仅 modelId 时回退 AIPACK_EVAL_PROVIDER', () => {
    const key = 'AIPACK_EVAL_PROVIDER';
    const old = process.env[key];
    process.env[key] = 'openai';
    try {
      assert.deepEqual(parseModelSpec('gpt-4o-mini'), {
        provider: 'openai',
        modelId: 'gpt-4o-mini',
      });
    } finally {
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    }
  });

  it('resolveLiveSpec：env 生效 + temperature 缺省 0', () => {
    const key = 'AIPACK_EVAL_MODEL';
    const old = process.env[key];
    process.env[key] = 'deepseek/deepseek-chat';
    try {
      const spec = resolveLiveSpec({ baseUrl: 'https://proxy.local/v1' });
      assert.equal(spec.provider, 'deepseek');
      assert.equal(spec.modelId, 'deepseek-chat');
      assert.equal(spec.temperature, 0);
      assert.equal(spec.baseUrl, 'https://proxy.local/v1');
    } finally {
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    }
  });

  it('resolveLiveSpec：未指定模型时报可操作错误', () => {
    const key = 'AIPACK_EVAL_MODEL';
    const old = process.env[key];
    delete process.env[key];
    try {
      assert.throws(() => resolveLiveSpec(), /--model/);
    } finally {
      if (old !== undefined) process.env[key] = old;
    }
  });
});

describe('live 装配', () => {
  it('内置模型命中目录并产出 model + streamFn', () => {
    const llm = createLiveLlm({
      provider: 'deepseek',
      modelId: 'deepseek-chat',
      apiKey: 'sk-test',
    });
    assert.equal(llm.aiModel.provider, 'deepseek');
    assert.match(llm.aiModel.baseUrl, /api\.deepseek\.com/);
    assert.equal(llm.model.id, 'deepseek-chat');
    assert.equal(typeof llm.streamFn, 'function');
  });

  it('baseUrl 覆盖（代理 / 兼容网关）', () => {
    const llm = createLiveLlm({
      provider: 'deepseek',
      modelId: 'deepseek-chat',
      apiKey: 'sk-test',
      baseUrl: 'https://proxy.local/v1',
    });
    assert.equal(llm.aiModel.baseUrl, 'https://proxy.local/v1');
  });

  it('目录外模型按 provider 推断 api 兜底', () => {
    const llm = createLiveLlm({
      provider: 'anthropic',
      modelId: 'claude-custom',
      apiKey: 'sk-test',
    });
    assert.equal(llm.aiModel.id, 'claude-custom');
    assert.equal(llm.aiModel.api, 'anthropic-messages');
  });

  it('未知 provider 直接报错', () => {
    assert.throws(
      () => createLiveLlm({ provider: 'nope', modelId: 'x', apiKey: 'k' }),
      /未知 provider/,
    );
  });

  it('assertLiveReady：缺 Key 报错，有 Key 放行', () => {
    assert.throws(
      () => assertLiveReady({ provider: 'deepseek', modelId: 'deepseek-chat' }),
      /API Key/,
    );
    assert.doesNotThrow(() =>
      assertLiveReady({ provider: 'deepseek', modelId: 'deepseek-chat', apiKey: 'sk-x' }),
    );
  });

  it('describeLiveLlm 输出 provider/modelId', () => {
    assert.equal(
      describeLiveLlm({ provider: 'deepseek', modelId: 'deepseek-chat' }),
      'deepseek/deepseek-chat',
    );
  });
});

describe('Runner live 分支（注入假 streamFn，不联网）', () => {
  it('live 用例跑通并默认 repeats=3', async () => {
    // 脚本只给一轮 'pong'，后续走兜底 'done' → passCount=1，pass@3 仍判通过
    const streamFn = createMockStreamFn({ turns: [{ text: 'pong' }] });
    const report = await runEval([liveCase({ id: 'unit-live/a' })], {
      mode: 'live',
      streamFn,
    });
    assert.equal(report.totals.cases, 1);
    assert.equal(report.results[0].repeats, 3);
    assert.equal(report.results[0].passCount, 1);
    assert.equal(report.results[0].passed, true, 'live 用 pass@k 判定');
    assert.equal(report.totals.passRate, 1);
  });

  it('live 模式下 k 次全失败才判不通过', async () => {
    const streamFn = createMockStreamFn({ turns: [{ text: 'nope' }] });
    const report = await runEval([liveCase({ id: 'unit-live/b' })], {
      mode: 'live',
      streamFn,
      repeats: 2,
    });
    assert.equal(report.results[0].passed, false);
    assert.equal(report.results[0].passCount, 0);
    assert.ok(report.results[0].scores.length > 0);
  });

  it('live 模式跳过 mock 用例（fixture replay）', async () => {
    const streamFn = createMockStreamFn({ turns: [{ text: 'pong' }] });
    const mockCase: EvalCase = {
      id: 'unit-live/mock-only',
      suite: 'unit-live',
      origin: 'handwritten',
      input: { message: 'hi', mock: { turns: [{ text: 'pong' }] } },
      expected: { type: 'contains', value: 'pong' },
    };
    const report = await runEval([liveCase({ id: 'unit-live/c' }), mockCase], {
      mode: 'live',
      streamFn,
      repeats: 1,
    });
    assert.equal(report.totals.cases, 1);
    assert.equal(report.totals.skipped, 1);
    assert.equal(report.skipped?.[0].caseId, 'unit-live/mock-only');
  });

  it('mock 模式跳过 live-only 用例', async () => {
    const report = await runEval([liveCase({ id: 'unit-live/d' })], { mode: 'mock' });
    assert.equal(report.totals.cases, 0);
    assert.equal(report.totals.skipped, 1);
  });

  it('skipReason 的四种判定', () => {
    const live = liveCase();
    const replay: EvalCase = {
      id: 'x/replay',
      suite: 'x',
      origin: 'handwritten',
      input: { message: 'hi', mock: { turns: [{ text: 'a' }] } },
      expected: { type: 'contains', value: 'a' },
    };
    assert.equal(skipReason(live, 'mock'), 'live-only 用例（mock 模式跳过）');
    assert.equal(skipReason(live, 'live'), undefined);
    assert.equal(skipReason(replay, 'live'), 'fixture replay 用例（live 模式跳过）');
    assert.equal(skipReason(replay, 'mock'), undefined);
    assert.equal(
      skipReason({ ...replay, mode: 'mock' }, 'live'),
      'mock-only 用例（live 模式跳过）',
    );
  });

  it('全局 token 预算熔断：超限后剩余用例不再跑', async () => {
    const streamFn = createMockStreamFn({ turns: [{ text: 'pong' }] });
    const cases = [
      liveCase({ id: 'unit-live/e1' }),
      liveCase({ id: 'unit-live/e2' }),
    ];
    const report = await runEval(cases, {
      mode: 'live',
      streamFn,
      repeats: 1,
      concurrency: 1,
      maxTotalTokens: 1,
    });
    const fused = report.results.filter((r) => /总预算熔断/.test(r.error ?? ''));
    assert.ok(fused.length >= 1, '至少有一个用例被预算熔断');
  });
});
