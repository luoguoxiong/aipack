/**
 * packages/eval/src/core/scorer/semantic.ts - 语义评分器（M5）
 *
 * embedding 相似度粗筛开放性回答：期望文本与最终输出各算一次 embedding，
 * 余弦相似度 ≥ threshold 即通过。低成本低精度，只做开放性回答的粗筛
 * （EVAL_PLAN.md 4.2：语义评分器）。
 *
 * embedding 注入点（EmbedFn）由调用方装配（见 core/embedding.ts 的
 * OpenAI 兼容实现），单测可注入 stub；缺 embed 时评分器跳过（不判失败）。
 */

import type { RunTrace, ScoreResult } from '../types';

/** 文本 → 向量（由调用方注入：真实 provider / 测试 stub） */
export type EmbedFn = (text: string) => Promise<number[]>;

export interface SemanticParams {
  /** 期望语义的参考文本 */
  expected: string;
  /** 通过阈值（缺省 0.75，0~1） */
  threshold?: number;
}

export const SEMANTIC_DEFAULT_THRESHOLD = 0.75;

/** 余弦相似度（零向量返回 0） */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/**
 * 执行语义评分。
 * 返回 undefined = 评分器跳过（缺 embed 注入点），不判用例失败。
 */
export async function runSemanticScorer(
  trace: RunTrace,
  params: SemanticParams,
  embed?: EmbedFn,
): Promise<ScoreResult | undefined> {
  if (!embed) {
    return undefined;
  }
  const expected = params.expected;
  if (typeof expected !== 'string' || !expected) {
    return {
      scorer: 'semantic',
      score: 0,
      passed: false,
      reason: "评分器参数缺少字符串字段 'expected'",
    };
  }
  const threshold =
    typeof params.threshold === 'number' && params.threshold > 0 && params.threshold <= 1
      ? params.threshold
      : SEMANTIC_DEFAULT_THRESHOLD;

  try {
    const [expVec, actVec] = await Promise.all([
      embed(expected),
      embed(trace.result.content),
    ]);
    const sim = cosineSimilarity(expVec, actVec);
    const passed = sim >= threshold;
    return {
      scorer: 'semantic',
      score: sim,
      passed,
      reason: passed
        ? `语义相似度 ${sim.toFixed(3)} ≥ 阈值 ${threshold}`
        : `语义相似度 ${sim.toFixed(3)} < 阈值 ${threshold}`,
      evidence: `expected: ${truncate(expected, 80)} / actual: ${truncate(trace.result.content, 80)}`,
    };
  } catch (e) {
    // embedding 调用失败视为 scorer 自身错误，不判用例失败（跳过）
    console.error('[eval] semantic scorer embedding 失败（跳过）:', (e as Error).message);
    return undefined;
  }
}
