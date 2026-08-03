/**
 * 混合检索器：BM25（必选）+ 可选 Embedding（向量）加权融合。
 *
 * 默认无 embedder 时退化为纯 BM25。
 * 有 embedder 时：
 *   - BM25 取 top `limit*3` 候选
 *   - 对 query 与候选算 cosine，min-max 归一化两路分数
 *   - 加权融合：final = w_bm25 * bm25_norm + w_embed * cos_norm
 *   - 过滤 < minScore，截 limit
 */

import { cosine, minMaxNormalize } from './embedder';
import type { Embedder, MemorySearchResult } from '../types';

/**
 * 检索器最小契约：任何具备 search(query, limit) 的对象均可作为 BM25 候选源。
 * BM25Retriever 天然满足此接口；插件层也可用 StoreBackedRetriever 包装自定义 store。
 */
export interface RetrieverLike {
  search(query: string, limit?: number): Promise<MemorySearchResult[]>;
}

export interface HybridRetrieverOptions {
  /** BM25 候选源（BM25Retriever 或任何 RetrieverLike 实现） */
  bm25: RetrieverLike;
  embedder?: Embedder;
  /** BM25 权重，默认 0.5 */
  bm25Weight?: number;
  /** embedding 权重，默认 0.5 */
  embedWeight?: number;
  /** 注入阶段最低分数阈值，默认 0.1 */
  minScore?: number;
}

export class HybridRetriever {
  bm25: RetrieverLike;
  embedder?: Embedder;
  bm25Weight: number;
  embedWeight: number;
  minScore: number;

  constructor(options: HybridRetrieverOptions) {
    this.bm25 = options.bm25;
    this.embedder = options.embedder;
    this.bm25Weight = options.bm25Weight ?? 0.5;
    this.embedWeight = options.embedWeight ?? 0.5;
    this.minScore = options.minScore ?? 0.1;
  }

  /** 是否启用了向量检索 */
  get hasEmbedder(): boolean {
    return !!this.embedder;
  }

  async search(query: string, limit = 5): Promise<MemorySearchResult[]> {
    if (limit <= 0) return [];

    // 候选数：有 embedder 时放大候选池以提升向量召回
    const candidateLimit = this.embedder ? Math.max(limit * 3, limit) : limit;
    const bm25Results = await this.bm25.search(query, candidateLimit);
    if (bm25Results.length === 0) return [];

    // 纯 BM25 模式：分数 min-max 归一化后过滤
    if (!this.embedder) {
      const scores = bm25Results.map((r) => r.score);
      const normed = minMaxNormalize(scores);
      return bm25Results
        .map((r, i) => ({ entry: r.entry, score: normed[i], matchedBy: 'bm25' as const }))
        .filter((r) => r.score >= this.minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    }

    // 混合模式
    const queryVec = await this.embedder.embed(query);
    const cosScores: number[] = [];
    for (const r of bm25Results) {
      const ev = r.entry.embedding;
      cosScores.push(ev && ev.length === queryVec.length ? cosine(queryVec, ev) : 0);
    }

    const bm25Normed = minMaxNormalize(bm25Results.map((r) => r.score));
    const cosNormed = minMaxNormalize(cosScores);

    const wB = this.bm25Weight;
    const wE = this.embedWeight;
    const wSum = wB + wE || 1;

    return bm25Results
      .map((r, i) => ({
        entry: r.entry,
        score: (wB * bm25Normed[i] + wE * cosNormed[i]) / wSum,
        matchedBy: (cosNormed[i] >= bm25Normed[i] ? 'embedding' : 'hybrid') as
          | 'embedding'
          | 'hybrid',
      }))
      .filter((r) => r.score >= this.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
