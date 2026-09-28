/**
 * @aipack-ai/eval —— aipack Eval 体系（M1：mock 模式 + 规则评分器）
 *
 * 快速上手：
 *   import { loadCases, runEval, renderMarkdown } from '@aipack-ai/eval';
 *   const { cases } = await loadCases();           // 默认 eval/cases
 *   const report = await runEval(cases, { mode: 'mock' });
 *   console.log(renderMarkdown(report));
 *
 * CLI：
 *   pnpm --filter @aipack-ai/eval eval -- --suite tool-calling
 */

// ─── 类型 ─────────────────────────────────────────────────────────
export type {
  CaseOrigin,
  MockToolCall,
  MockAssistantTurn,
  MockScript,
  AgentInput,
  ExpectedToolCall,
  ExpectedResult,
  RuleScorerType,
  ScorerType,
  ScorerConfig,
  EvalCase,
  ToolCallRecord,
  RunTrace,
  ScoreResult,
  CaseResult,
  SuiteSummary,
  EvalReport,
  RunConfig,
  BaselineFile,
  BaselineComparison,
} from './src/core/types';

// ─── Mock 层（fixture replay）─────────────────────────────────────
export { createMockStreamFn } from './src/core/mock-stream';
export {
  createMockTools,
  STANDARD_MOCK_TOOLS,
} from './src/core/mock-tools';
export type { StandardMockToolName } from './src/core/mock-tools';

// ─── 轨迹提取 ─────────────────────────────────────────────────────
export { extractTrajectory, countTurns } from './src/core/trajectory';

// ─── 评分器 ───────────────────────────────────────────────────────
export {
  expectedToScorers,
  resolveScorers,
  scoreTrace,
  RULE_SCORER_TYPES,
  runRuleScorer,
  partialMatch,
} from './src/core/scorer';
export type { CaseScore } from './src/core/scorer';

// ─── 校验 / 加载 ──────────────────────────────────────────────────
export { validateEvalCase } from './src/core/validate';
export {
  loadCases,
  defaultCasesDir,
  packageRoot,
} from './src/core/loader';
export type { LoadCasesResult } from './src/core/loader';

// ─── Runner 与报告 ────────────────────────────────────────────────
export { runEval } from './src/core/runner';
export {
  renderMarkdown,
  writeReport,
  writeBaseline,
  readBaseline,
  reportToBaseline,
  compareBaseline,
  finalizeReport,
} from './src/core/report';
