/**
 * packages/eval/src/core/scorer/index.ts - 评分入口与 expected 归一化
 *
 * - expected（声明式）→ ScorerConfig[]（与显式 scorers 合并）
 * - scoreCase：按类型分发评分器（rule 同步 / semantic & llm-judge 异步），
 *   加权合成用例总分
 * - M5：semantic / llm-judge 需要外部装配（embed / judge），缺装配时
 *   评分器跳过（不判用例失败，见各实现文件）
 */

import type {
  ExpectedResult,
  RunTrace,
  ScoreResult,
  ScorerConfig,
} from '../types';
import { RULE_SCORER_TYPES, runRuleScorer } from './rule';
import { runSemanticScorer, type EmbedFn } from './semantic';
import { runLlmJudge, type JudgeDeps } from './llm-judge';

export { RULE_SCORER_TYPES, runRuleScorer, partialMatch } from './rule';
export { cosineSimilarity, runSemanticScorer, type EmbedFn, type SemanticParams } from './semantic';
export {
  buildJudgePrompt,
  parseJudgeResponse,
  runLlmJudge,
  JUDGE_PROMPT_VERSION,
  type JudgeDeps,
  type JudgeParams,
  type JudgeVerdict,
} from './llm-judge';

/** 全量评分器类型（rule 8 种 + semantic + llm-judge） */
export const ALL_SCORER_TYPES = [...RULE_SCORER_TYPES, 'semantic', 'llm-judge'] as const;

/** 评分器外部装配（M5）：缺省时 semantic / llm-judge 跳过 */
export interface ScorerDeps {
  /** semantic 评分器的 embedding 函数 */
  embed?: EmbedFn;
  /** llm-judge 的异源 judge 装配 */
  judge?: JudgeDeps;
}

/** 声明式 expected → 评分器配置 */
export function expectedToScorers(expected: ExpectedResult): ScorerConfig[] {
  switch (expected.type) {
    case 'exact':
    case 'contains':
      return [{ type: expected.type, params: { value: expected.value } }];
    case 'regex':
      return [
        { type: 'regex', params: { value: expected.value, flags: expected.flags ?? '' } },
      ];
    case 'tool-call':
      return [
        {
          type: 'tool-call',
          params: { calls: expected.calls, order: expected.order ?? 'subset' },
        },
      ];
    case 'tools-used':
      return [{ type: 'tools-used', params: { tools: expected.tools } }];
    case 'json-field':
      return 'value' in expected
        ? [{ type: 'json-field', params: { path: expected.path, value: expected.value } }]
        : [{ type: 'json-field', params: { path: expected.path } }];
    case 'success':
      return [{ type: 'success', params: { value: expected.value ?? true } }];
    case 'stop-reason':
      return [{ type: 'stop-reason', params: { value: expected.value } }];
  }
}

/** 合并用例的 expected + scorers */
export function resolveScorers(
  expected?: ExpectedResult,
  explicit?: ScorerConfig[],
): ScorerConfig[] {
  return [...(expected ? expectedToScorers(expected) : []), ...(explicit ?? [])];
}

export interface CaseScore {
  passed: boolean;
  score: number;
  scores: ScoreResult[];
  /** 因缺装配 / judge 解析失败而跳过的评分器（不判用例失败） */
  skippedScorers: string[];
}

/** 执行单个评分器（按类型分发）；返回 undefined = 跳过 */
async function runScorer(
  trace: RunTrace,
  s: ScorerConfig,
  deps: ScorerDeps,
): Promise<ScoreResult | undefined> {
  if (s.type === 'semantic') {
    return runSemanticScorer(trace, s.params as never, deps.embed);
  }
  if (s.type === 'llm-judge') {
    return runLlmJudge(trace, s.params as never, deps.judge);
  }
  return runRuleScorer(trace, s.type, s.params);
}

/** 对一次运行轨迹执行全部评分器 */
export async function scoreTrace(
  trace: RunTrace,
  scorers: ScorerConfig[],
  deps: ScorerDeps = {},
): Promise<CaseScore> {
  const results = await Promise.all(scorers.map((s) => runScorer(trace, s, deps)));

  // 跳过的评分器（缺装配 / scorer 自身错误）不参与判定
  const skippedScorers = scorers
    .filter((_, i) => results[i] === undefined)
    .map((s) => s.type);
  const effective = scorers
    .map((s, i) => ({ s, r: results[i] }))
    .filter((x): x is { s: ScorerConfig; r: ScoreResult } => x.r !== undefined);

  const totalWeight = effective.reduce((acc, { s }) => acc + (s.weight ?? 1), 0);
  const weighted =
    totalWeight === 0
      ? 0
      : effective.reduce((acc, { s, r }) => acc + r.score * (s.weight ?? 1), 0) /
        totalWeight;
  return {
    passed: effective.length > 0 && effective.every(({ r }) => r.passed),
    score: effective.length === 0 ? 0 : weighted,
    scores: effective.map(({ r }) => r),
    skippedScorers,
  };
}
