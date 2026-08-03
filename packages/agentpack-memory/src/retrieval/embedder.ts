/**
 * Embedder 接口与余弦相似度工具。
 *
 * 默认不提供任何 embedder 实现（零依赖、零 API Key）。
 * 用户可自行实现 Embedder 接入 ollama / @huggingface/transformers / OpenAI 等。
 */

import type { Embedder } from '../types';

export type { Embedder };

/** 余弦相似度。任一为零向量返回 0。 */
export function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 将一组分数 min-max 归一化到 0..1。
 * 单元素或全相同时返回等分（避免除零）。
 */
export function minMaxNormalize(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max - min === 0) return scores.map(() => 1);
  return scores.map((s) => (s - min) / (max - min));
}
