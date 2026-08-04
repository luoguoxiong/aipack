/**
 * 混合检索器：BM25（必选）+ 可选 Embedding（向量）双路独立召回后加权融合。
 *
 * 默认无 embedder 时退化为纯 BM25。
 * 有 embedder 时：
 *   - BM25 路独立召回 top-`limit*3`
 *   - 向量路独立召回 top-`limit*3`（依赖 store 的 searchVectors / VectorIndex，
 *     不受 BM25 候选池封顶 —— 修复「向量召回被 BM25 top-K 限制」问题）
 *   - 两路各自 min-max 归一化后按权重融合：final = w_bm25 * bm25_norm + w_embed * cos_norm
 *   - 过滤 < minScore，截 limit
 *
 * 兼容路径：
 *   - 配置了 embedder 但 store 不支持向量检索（无 searchVectors 能力）：
 *     退化为「BM25 候选 + 向量重排」（旧行为），并在 minScore 处诚实标注。
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

/** 向量检索源契约（由 store 实现，或插件层包装） */
export interface VectorSearchLike {
  searchVectors(queryVec: number[], limit?: number): Promise<MemorySearchResult[]>;
}

export interface HybridRetrieverOptions {
  /** BM25 候选源（BM25Retriever 或任何 RetrieverLike 实现） */
  bm25: RetrieverLike;
  /** 可选向量源（store.searchVectors）；有 embedder 但无此源时退化为候选重排 */
  vector?: VectorSearchLike;
  embedder?: Embedder;
  /** BM25 权重，默认 0.5 */
  bm25Weight?: number;
  /** embedding 权重，默认 0.5 */
  embedWeight?: number;
  /** 注入阶段最低分数阈值，默认 0.1 */
  minScore?: number;
}

export interface HybridSearchOptions {
  /** 覆盖默认 minScore（如注入转换器携带自己的阈值，不再篡改共享 retriever） */
  minScore?: number;
  /**
   * 原始分数模式：不做 min-max 归一化，保留 BM25 / cosine 原始分数。
   * 供合并器等需要「绝对相似度阈值」的场景使用 —— min-max 会把同一查询内
   * 的次优分数压到 0，使绝对阈值（如 0.85）失去意义。
   */
  raw?: boolean;
}

export class HybridRetriever {
  bm25: RetrieverLike;
  vector?: VectorSearchLike;
  embedder?: Embedder;
  bm25Weight: number;
  embedWeight: number;
  minScore: number;

  constructor(options: HybridRetrieverOptions) {
    this.bm25 = options.bm25;
    this.vector = options.vector;
    this.embedder = options.embedder;
    this.bm25Weight = options.bm25Weight ?? 0.5;
    this.embedWeight = options.embedWeight ?? 0.5;
    this.minScore = options.minScore ?? 0.1;
  }

  /** 是否启用了向量检索 */
  get hasEmbedder(): boolean {
    return !!this.embedder;
  }

  async search(
    query: string,
    limit = 5,
    opts?: HybridSearchOptions,
  ): Promise<MemorySearchResult[]> {
    const minScore = opts?.minScore ?? this.minScore;
    const raw = opts?.raw ?? false;
    if (limit <= 0) return [];

    // BM25 路：有向量能力时放大候选池以提升融合质量
    const bm25Limit = this.embedder ? Math.max(limit * 3, limit) : limit;
    const bm25Results = await this.bm25.search(query, bm25Limit);

    // 纯 BM25 模式：分数 min-max 归一化后过滤（或 raw 模式保留原始分数）
    if (!this.embedder) {
      if (bm25Results.length === 0) return [];
      return raw
        ? this.fuseRaw(bm25Results, [], minScore, limit)
        : this.fuseSingle(bm25Results, minScore, limit);
    }

    // 尝试向量查询
    let queryVec: number[] | null = null;
    try {
      queryVec = await this.embedder.embed(query);
    } catch {
      queryVec = null; // 向量失败退化为纯 BM25
    }

    // 无向量源（自定义 store 不支持）或向量查询失败：BM25 候选 + 向量重排（旧行为）
    if (!this.vector || !queryVec || queryVec.length === 0) {
      if (bm25Results.length === 0) return [];
      if (raw) return this.fuseRaw(bm25Results, [], minScore, limit);
      return queryVec && this.vector
        ? this.rerank(bm25Results, queryVec, minScore, limit)
        : this.fuseSingle(bm25Results, minScore, limit);
    }

    // 双路独立召回 + 融合
    let vecResults: MemorySearchResult[] = [];
    try {
      vecResults = await this.vector.searchVectors(queryVec, bm25Limit);
    } catch {
      vecResults = [];
    }
    if (bm25Results.length === 0 && vecResults.length === 0) return [];
    return raw
      ? this.fuseRaw(bm25Results, vecResults, minScore, limit)
      : this.fuseDual(bm25Results, vecResults, minScore, limit);
  }

  // ─── 融合策略 ───────────────────────────────────────────────────

  /** 单路（纯 BM25）：归一化 + 过滤 + 截断 */
  private fuseSingle(
    results: MemorySearchResult[],
    minScore: number,
    limit: number,
  ): MemorySearchResult[] {
    const normed = minMaxNormalize(results.map((r) => r.score));
    return results
      .map((r, i) => ({ entry: r.entry, score: normed[i], matchedBy: 'bm25' as const }))
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** 候选重排（兼容路径）：BM25 候选 + 向量 cosine 加权融合 */
  private rerank(
    bm25Results: MemorySearchResult[],
    queryVec: number[],
    minScore: number,
    limit: number,
  ): MemorySearchResult[] {
    const cosScores = bm25Results.map((r) => {
      const ev = r.entry.embedding;
      return ev && ev.length === queryVec.length ? cosine(queryVec, ev) : 0;
    });
    const bm25Normed = minMaxNormalize(bm25Results.map((r) => r.score));
    const cosNormed = minMaxNormalize(cosScores);
    const wSum = this.bm25Weight + this.embedWeight || 1;

    return bm25Results
      .map((r, i) => ({
        entry: r.entry,
        score: (this.bm25Weight * bm25Normed[i] + this.embedWeight * cosNormed[i]) / wSum,
        matchedBy: (cosNormed[i] >= bm25Normed[i] ? 'embedding' : 'hybrid') as
          | 'embedding'
          | 'hybrid',
      }))
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * 原始分数融合（raw 模式）：保留 BM25 / cosine 原始分数，不做 min-max 归一化，
   * 供合并器按「绝对相似度阈值」判定可合并项。双路命中时取 max
   * （任一来源判定相似即相似），避免归一化把次优分数抹平。
   */
  private fuseRaw(
    bm25Results: MemorySearchResult[],
    vecResults: MemorySearchResult[],
    minScore: number,
    limit: number,
  ): MemorySearchResult[] {
    const union = new Map<
      string,
      { entry: MemorySearchResult['entry']; score: number; matchedBy: 'bm25' | 'embedding' | 'hybrid' }
    >();
    for (const r of bm25Results) {
      union.set(r.entry.id, { entry: r.entry, score: r.score, matchedBy: 'bm25' });
    }
    for (const r of vecResults) {
      const prev = union.get(r.entry.id);
      if (!prev) {
        union.set(r.entry.id, { entry: r.entry, score: r.score, matchedBy: 'embedding' });
      } else {
        prev.score = Math.max(prev.score, r.score);
        if (prev.matchedBy === 'bm25') prev.matchedBy = 'hybrid';
      }
    }
    return [...union.values()]
      .filter((x) => x.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** 双路独立召回融合：按 id 取并集，加权求和，再按权重和归一化 */
  private fuseDual(
    bm25Results: MemorySearchResult[],
    vecResults: MemorySearchResult[],
    minScore: number,
    limit: number,
  ): MemorySearchResult[] {
    const bm25Normed = minMaxNormalize(bm25Results.map((r) => r.score));
    const vecNormed = minMaxNormalize(vecResults.map((r) => r.score));
    const wB = this.bm25Weight;
    const wE = this.embedWeight;
    const wSum = wB + wE || 1;

    const union = new Map<
      string,
      { entry: MemorySearchResult['entry']; score: number; matchedBy: 'bm25' | 'embedding' | 'hybrid' }
    >();
    bm25Results.forEach((r, i) => {
      union.set(r.entry.id, { entry: r.entry, score: bm25Normed[i] * wB, matchedBy: 'bm25' });
    });
    vecResults.forEach((r, i) => {
      const prev = union.get(r.entry.id);
      const s = vecNormed[i] * wE;
      if (!prev) {
        union.set(r.entry.id, { entry: r.entry, score: s, matchedBy: 'embedding' });
      } else {
        prev.score += s;
        if (prev.matchedBy === 'bm25') prev.matchedBy = 'hybrid';
      }
    });

    return [...union.values()]
      .map((x) => ({ entry: x.entry, score: x.score / wSum, matchedBy: x.matchedBy }))
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
