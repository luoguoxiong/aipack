/**
 * packages/eval/src/core/scorer/llm-judge.ts - LLM-as-judge 评分器（M5）
 *
 * 开放性回答的终审（EVAL_PLAN.md 4.2 硬性约束）：
 *   - judge 模型与被测模型异源（装配层校验，见 live.ts assertJudgeDistinct）
 *   - 输出强制 JSON（score + reason + evidence），解析失败视为 scorer
 *     自身错误 → 跳过该评分器而非判用例失败
 *   - judge prompt 版本纳入元数据（JUDGE_PROMPT_VERSION / params.promptVersion），
 *     改 rubric 不 invalidate 全部历史结果
 */

import type { RunTrace, ScoreResult, ToolCallRecord } from '../types';

export interface JudgeParams {
  /** rubric 条目（逐条评判） */
  criteria: string[];
  /** rubric 版本（缺省 JUDGE_PROMPT_VERSION） */
  promptVersion?: number;
}

export interface JudgeDeps {
  /** prompt → assistant 文本（由 live judge 模型装配，见 core/judge-llm.ts） */
  complete(prompt: string): Promise<string>;
  /** 报告展示的 judge 模型标识 */
  modelLabel?: string;
}

export const JUDGE_PROMPT_VERSION = 1;

/** 单条 rubric 评判的 JSON 结构 */
export interface JudgeVerdict {
  score: number;
  reason: string;
  evidence?: string;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function formatTrajectory(calls: ToolCallRecord[]): string {
  if (calls.length === 0) return '(无工具调用)';
  return calls
    .map(
      (c, i) =>
        `${i + 1}. ${c.name}(${JSON.stringify(c.args ?? {})})${c.isError ? ' [error]' : ''}`,
    )
    .join('\n');
}

/** 组装 judge prompt（版本化：改 rubric / 格式不影响历史结果的含义） */
export function buildJudgePrompt(
  params: JudgeParams,
  output: string,
  trajectory: ToolCallRecord[],
): string {
  const version = params.promptVersion ?? JUDGE_PROMPT_VERSION;
  const criteria = params.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n');
  return [
    `你是严格的评测 judge（prompt v${version}）。请逐条依据以下 rubric 评判 agent 回答的质量：`,
    '',
    criteria,
    '',
    '── Agent 最终输出 ──',
    output,
    '',
    '── 工具调用轨迹（时间序） ──',
    formatTrajectory(trajectory),
    '',
    '要求：',
    '- score 为 0~1 的数字（全部 rubric 满足 = 1，完全不满足 = 0）',
    '- reason 必须给出理由并引用证据',
    '- 只输出一个 JSON 对象，不要输出其他任何文本：',
    '  {"score": <0~1>, "reason": "<理由>", "evidence": "<命中的原文片段或调用序号>"}',
  ].join('\n');
}

/**
 * 解析 judge 输出。宽容处理：截取首个 '{' 到最后一个 '}'。
 * 解析失败返回 undefined（scorer 自身错误 → 跳过，不判用例失败）。
 */
export function parseJudgeResponse(raw: string): JudgeVerdict | undefined {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const { score, reason, evidence } = parsed as Record<string, unknown>;
  if (typeof score !== 'number' || !Number.isFinite(score)) return undefined;
  const clamped = Math.min(Math.max(score, 0), 1);
  return {
    score: clamped,
    reason: typeof reason === 'string' && reason ? reason : '(judge 未给出理由)',
    evidence: typeof evidence === 'string' ? evidence : undefined,
  };
}

/**
 * 执行 LLM-as-judge。
 * 返回 undefined = 评分器跳过（缺 judge 装配 / judge 输出解析失败 / judge 调用失败），
 * 不判用例失败（EVAL_PLAN.md 4.2）。
 */
export async function runLlmJudge(
  trace: RunTrace,
  params: JudgeParams,
  deps?: JudgeDeps,
): Promise<ScoreResult | undefined> {
  if (!deps) return undefined;
  if (!Array.isArray(params.criteria) || params.criteria.length === 0) {
    return {
      scorer: 'llm-judge',
      score: 0,
      passed: false,
      reason: "评分器参数缺少非空数组字段 'criteria'",
    };
  }

  const prompt = buildJudgePrompt(params, trace.result.content, trace.trajectory);
  let raw: string;
  try {
    raw = await deps.complete(prompt);
  } catch (e) {
    console.error('[eval] llm-judge 调用失败（跳过）:', (e as Error).message);
    return undefined;
  }
  const verdict = parseJudgeResponse(raw);
  if (!verdict) {
    console.error('[eval] llm-judge 输出解析失败（跳过）:', truncate(raw, 120));
    return undefined;
  }

  const passed = verdict.score >= 0.5;
  return {
    scorer: 'llm-judge',
    score: verdict.score,
    passed,
    reason: `[${deps.modelLabel ?? 'judge'} v${params.promptVersion ?? JUDGE_PROMPT_VERSION}] ${verdict.reason}`,
    evidence: verdict.evidence,
  };
}
