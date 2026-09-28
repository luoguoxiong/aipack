/**
 * packages/eval/src/core/scorer/index.ts - 评分入口与 expected 归一化
 *
 * - expected（声明式）→ ScorerConfig[]（与显式 scorers 合并）
 * - scoreCase：依次执行规则评分器，加权合成用例总分
 */

import type {
  ExpectedResult,
  RunTrace,
  ScoreResult,
  ScorerConfig,
} from '../types';
import { RULE_SCORER_TYPES, runRuleScorer } from './rule';

export { RULE_SCORER_TYPES, runRuleScorer, partialMatch } from './rule';

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
}

/** 对一次运行轨迹执行全部评分器 */
export function scoreTrace(trace: RunTrace, scorers: ScorerConfig[]): CaseScore {
  const scores: ScoreResult[] = scorers.map((s) =>
    runRuleScorer(trace, s.type, s.params),
  );
  const totalWeight = scorers.reduce((acc, s) => acc + (s.weight ?? 1), 0);
  const weighted =
    totalWeight === 0
      ? 0
      : scores.reduce((acc, r, i) => acc + r.score * (scorers[i].weight ?? 1), 0) /
        totalWeight;
  return {
    passed: scores.length > 0 && scores.every((r) => r.passed),
    score: scorers.length === 0 ? 0 : weighted,
    scores,
  };
}
