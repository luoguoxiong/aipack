/**
 * packages/eval/src/core/runner.ts - Eval Runner
 *
 * mock 模式：每个用例构造独立 Runtime（createMockStreamFn 注入
 * streamFn + createMockTools 提供工具），run() 后经 getMessages()
 * 重建完整轨迹，再交给规则评分器。
 *
 * 工程保障：
 *   - 用例间完全隔离（独立 runtime / 独立 fs 副本 / 独立 sessionKey）
 *   - 墙钟超时（Promise.race）
 *   - 步数上限（映射 RuntimeOptions.maxTurns）
 *   - 预算熔断（usage.total 超 case.metadata.maxTokens 判失败）
 *   - repeats 消随机性（live 模式用；mock 模式缺省 1）
 *   - 并发受控（简单队列实现）
 */

import {
  createRuntime,
  createRequest,
} from '@aipack-ai/agent';
import type { Tool } from '@aipack-ai/agent';
import { createMockStreamFn } from './mock-stream';
import { createMockTools } from './mock-tools';
import { countTurns, extractTrajectory } from './trajectory';
import { resolveScorers, scoreTrace } from './scorer';
import type {
  CaseResult,
  EvalCase,
  EvalReport,
  RunConfig,
  RunTrace,
  SuiteSummary,
} from './types';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_STEPS = 50;
const DEFAULT_CONCURRENCY = 8;

/** sanitize sessionKey（用例 id 可能含 '/'） */
function sessionKeyFor(caseId: string, repeat: number): string {
  return `eval:${caseId.replace(/[^a-zA-Z0-9_-]/g, '_')}#r${repeat}`;
}

/** 单用例单次运行：返回轨迹（失败时返回 error 字符串） */
async function runCaseOnce(
  c: EvalCase,
  config: RunConfig,
  repeat: number,
): Promise<{ trace?: RunTrace; error?: string }> {
  if (!c.input.mock) {
    return { error: 'mock 模式要求 input.mock 脚本（live 模式 M3 接入）' };
  }

  const timeoutMs = c.metadata?.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxSteps = c.metadata?.maxSteps ?? config.maxSteps ?? DEFAULT_MAX_STEPS;

  const tools: Tool[] = createMockTools(c.input.fs ?? {}, c.input.tools);
  const runtime = createRuntime({
    systemPrompt: c.input.systemPrompt ?? '',
    streamFn: createMockStreamFn(c.input.mock),
    tools,
    maxTurns: maxSteps,
    traceIdGenerator: () => sessionKeyFor(c.id, repeat),
  });

  const sessionKey = sessionKeyFor(c.id, repeat);
  const startedAt = Date.now();

  type RunOk = {
    ok: true;
    result: Awaited<ReturnType<typeof runtime.run>>;
    messages: ReturnType<typeof runtime.getMessages>;
    trajectory: RunTrace['trajectory'];
    turns: number;
    durationMs: number;
    usageTotal: number;
  };
  type RunOutcome = RunOk | { ok: false; error: string };

  let run: Promise<RunOutcome>;

  try {
    run = runtime
      .run(createRequest(c.input.message, { sessionKey }))
      .then((result): RunOutcome => {
        const messages = runtime.getMessages(sessionKey);
        const trajectory = extractTrajectory(messages);
        const turns = countTurns(messages);
        const durationMs = Date.now() - startedAt;
        const usageTotal =
          typeof result.usage?.total === 'number' ? result.usage.total : 0;
        return {
          ok: true,
          result,
          messages,
          trajectory,
          turns,
          durationMs,
          usageTotal,
        };
      })
      .catch((e: unknown): RunOutcome => ({
        ok: false,
        error: `框架异常: ${(e as Error).message}`,
      }));

    // 墙钟超时：到期时把 pending 的 run 替换为失败结果
    const timeoutOutcome = new Promise<RunOutcome>((resolve) => {
      const t = setTimeout(
        () => resolve({ ok: false, error: `超时（${timeoutMs}ms）` }),
        timeoutMs,
      );
      (t as { unref?: () => void }).unref?.();
    });

    const outcome = await Promise.race([run, timeoutOutcome]);
    if (!outcome.ok) return { error: outcome.error };

    const trace: RunTrace = {
      caseId: c.id,
      suite: c.suite,
      origin: c.origin,
      result: outcome.result,
      trajectory: outcome.trajectory,
      messages: outcome.messages,
      durationMs: outcome.durationMs,
      usageTotal: outcome.usageTotal,
      turns: outcome.turns,
    };

    // 预算熔断：token 超限直接判失败
    const maxTokens = c.metadata?.maxTokens;
    if (maxTokens !== undefined && trace.usageTotal > maxTokens) {
      return { error: `预算熔断：usage.total=${trace.usageTotal} > maxTokens=${maxTokens}` };
    }

    return { trace };
  } finally {
    await runtime.close().catch(() => undefined);
  }
}

/** 单用例（含 repeats） */
async function runCase(
  c: EvalCase,
  config: RunConfig,
): Promise<CaseResult> {
  const repeats = config.mode === 'mock' ? (config.repeats ?? 1) : (config.repeats ?? 1);
  const scorers = resolveScorers(c.expected, c.scorers);
  const startedAt = Date.now();

  let passed = true;
  let score = 0;
  let scoreCount = 0;
  const scoreResults: CaseResult['scores'] = [];
  let runError: string | undefined;
  let steps = 0;
  let usageTotal = 0;
  let durationMs = 0;

  for (let r = 0; r < repeats; r++) {
    const { trace, error } = await runCaseOnce(c, config, r);
    durationMs += Date.now() - startedAt;
    if (error || !trace) {
      passed = false;
      runError = error;
      scoreResults.push({
        scorer: 'success',
        score: 0,
        passed: false,
        reason: `运行失败: ${error ?? '未知错误'}`,
      });
      break;
    }
    steps = trace.trajectory.length;
    usageTotal += trace.usageTotal;
    const caseScore = scoreTrace(trace, scorers);
    passed = passed && caseScore.passed;
    score += caseScore.score;
    scoreCount += 1;
    if (!caseScore.passed) {
      scoreResults.push(
        ...caseScore.scores.filter((s) => !s.passed).map((s) => ({
          ...s,
          reason: s.reason,
        })),
      );
    }
  }

  return {
    caseId: c.id,
    suite: c.suite,
    origin: c.origin,
    passed,
    score: scoreCount === 0 ? 0 : score / scoreCount,
    scores: scoreResults,
    error: runError,
    durationMs,
    steps,
    usageTotal,
  };
}

/** 简单并发队列（避免引入依赖） */
async function runAllConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function summarize(results: CaseResult[]): Record<string, SuiteSummary> {
  const groups = new Map<string, CaseResult[]>();
  for (const r of results) {
    const list = groups.get(r.suite) ?? [];
    list.push(r);
    groups.set(r.suite, list);
  }
  const out: Record<string, SuiteSummary> = {};
  for (const [key, list] of groups) {
    const total = list.length;
    const passed = list.filter((r) => r.passed).length;
    out[key] = {
      total,
      passed,
      passRate: total === 0 ? 0 : passed / total,
      avgScore: total === 0 ? 0 : list.reduce((a, r) => a + r.score, 0) / total,
    };
  }
  return out;
}

/** 执行一次评测 */
export async function runEval(
  cases: EvalCase[],
  config: RunConfig,
): Promise<EvalReport> {
  const startedAt = Date.now();
  const filtered =
    config.suites && config.suites.length > 0
      ? cases.filter((c) => config.suites!.includes(c.suite))
      : cases;

  const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
  const results = await runAllConcurrent(filtered, concurrency, (c) =>
    runCase(c, config),
  );

  const casesPassed = results.filter((r) => r.passed).length;
  return {
    runId: `run_${new Date().toISOString().replace(/[:.]/g, '-')}`,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    mode: config.mode,
    totals: {
      cases: results.length,
      passed: casesPassed,
      passRate: results.length === 0 ? 0 : casesPassed / results.length,
      avgScore:
        results.length === 0
          ? 0
          : results.reduce((a, r) => a + r.score, 0) / results.length,
      usageTotal: results.reduce((a, r) => a + r.usageTotal, 0),
    },
    bySuite: summarize(results),
    byOrigin: summarize(results.map((r) => ({ ...r, suite: r.origin }))),
    results,
  };
}
