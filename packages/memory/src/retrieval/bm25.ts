/**
 * BM25 倒排索引与检索器（零依赖）。
 *
 * 经典 BM25 公式：
 *   score(q, d) = Σ_t idf(t) * (tf(t,d) * (k1+1)) / (tf(t,d) + k1*(1 - b + b*|d|/avgdl))
 *   idf(t) = ln((N - df(t) + 0.5) / (df(t) + 0.5) + 1)
 *
 * 分数不归一化（由 HybridRetriever 负责 min-max 归一化）。
 */

import { tokenize } from './tokenizer';
import type { MemoryEntry, MemorySearchResult } from '../types';

export interface BM25Options {
  /** 词频饱和参数，默认 1.5 */
  k1?: number;
  /** 文档长度归一化参数，默认 0.75 */
  b?: number;
}

interface DocEntry {
  id: string;
  tokens: string[];
  length: number;
  tf: Map<string, number>;
}

export class BM25Index {
  private k1: number;
  private b: number;
  /** 文档集合 */
  private docs = new Map<string, DocEntry>();
  /** 倒排表：token -> 文档 id 集合 */
  private inverted = new Map<string, Set<string>>();
  private totalLength = 0;

  constructor(options: BM25Options = {}) {
    this.k1 = options.k1 ?? 1.5;
    this.b = options.b ?? 0.75;
  }

  /** 平均文档长度 */
  private get avgdl(): number {
    return this.docs.size === 0 ? 0 : this.totalLength / this.docs.size;
  }

  /** 文档总数 */
  get size(): number {
    return this.docs.size;
  }

  /** 添加或替换文档（同 id 覆盖） */
  add(id: string, tokens: string[]): void {
    // 若已存在，先移除旧的倒排
    if (this.docs.has(id)) this.remove(id);

    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    this.docs.set(id, { id, tokens, length: tokens.length, tf });
    this.totalLength += tokens.length;

    for (const t of tf.keys()) {
      let set = this.inverted.get(t);
      if (!set) {
        set = new Set();
        this.inverted.set(t, set);
      }
      set.add(id);
    }
  }

  /** 移除文档 */
  remove(id: string): void {
    const doc = this.docs.get(id);
    if (!doc) return;
    this.docs.delete(id);
    this.totalLength -= doc.length;
    for (const t of doc.tf.keys()) {
      const set = this.inverted.get(t);
      if (!set) continue;
      set.delete(id);
      if (set.size === 0) this.inverted.delete(t);
    }
  }

  /** 清空索引 */
  clear(): void {
    this.docs.clear();
    this.inverted.clear();
    this.totalLength = 0;
  }

  /**
   * 检索：返回 top-N 的 {id, score}（按分数降序）。
   * 只扫描 query token 命中的文档，避免全量计算。
   */
  search(queryTokens: string[], limit = 10): Array<{ id: string; score: number }> {
    if (this.docs.size === 0 || queryTokens.length === 0) return [];

    const N = this.docs.size;
    const avgdl = this.avgdl;
    const scores = new Map<string, number>();

    for (const t of queryTokens) {
      const set = this.inverted.get(t);
      if (!set || set.size === 0) continue;

      const df = set.size;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

      for (const docId of set) {
        const doc = this.docs.get(docId);
        if (!doc) continue;
        const tf = doc.tf.get(t) ?? 0;
        if (tf === 0) continue;

        const denom = tf + this.k1 * (1 - this.b + (this.b * doc.length) / (avgdl || 1));
        const contrib = (idf * (tf * (this.k1 + 1))) / (denom || 1);
        scores.set(docId, (scores.get(docId) ?? 0) + contrib);
      }
    }

    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * 单个 token 的 idf（未出现返回 0）。
   * 供上层计算查询的理论满分（完全同文、tf=1、len≈avgdl 时的分数），
   * 把无界 BM25 原始分规范化为 [0,1] 相似度。
   */
  idf(token: string): number {
    const df = this.inverted.get(token)?.size ?? 0;
    if (df === 0) return 0;
    const N = this.docs.size;
    return Math.log((N - df + 0.5) / (df + 0.5) + 1);
  }
}

/**
 * 基于 BM25Index 的检索器，包装为 MemorySearchResult。
 * entries 与 index 由外部维护（store 持有并增量同步）。
 *
 * 分数语义：BM25 原始分无界（取决于词频/idf 与库规模），与 embedding 的
 * cosine 相似度（0..1）量纲不匹配 —— 若直接作为绝对相似度与
 * similarityThreshold（如 0.85）比较，合并几乎永远不会触发。这里除以
 * 查询的理论满分（Σidf，即完全同文时的分数）并截断到 [0,1]：
 * 完全同文 ≈ 1，部分命中按比例衰减，使绝对阈值对 BM25 / cosine 统一成立。
 * 该变换是单调的，对普通检索路径的 min-max 归一化幂等（排序不变）。
 */
export class BM25Retriever {
  constructor(
    private index: BM25Index,
    private entries: Map<string, MemoryEntry>,
  ) {}

  async search(query: string, limit = 5): Promise<MemorySearchResult[]> {
    const queryTokens = tokenize(query);
    const hits = this.index.search(queryTokens, limit);

    // 查询的理论满分：所有 query token 的 idf 之和。
    // 完全同文（tf=1、len≈avgdl）时 BM25 分数 ≈ Σidf，因此 score/Σidf ≈ 1；
    // 词频高或文档更短的命中可能 >1，截断到 1。
    const maxPossible = queryTokens.reduce((acc, t) => acc + this.index.idf(t), 0);

    return hits.map(({ id, score }) => ({
      entry: this.entries.get(id)!,
      score: maxPossible > 0 ? Math.min(1, score / maxPossible) : 0,
      matchedBy: 'bm25' as const,
    })).filter((r) => r.entry != null);
  }
}
