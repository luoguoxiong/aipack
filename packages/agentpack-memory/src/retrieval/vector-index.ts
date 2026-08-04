/**
 * VectorIndex —— 零依赖简化 ANN（近似最近邻）向量索引。
 *
 * 用途：为混合检索提供「独立于 BM25 的向量召回」。
 * 之前向量检索被 BM25 top-K 候选池封顶，本索引保证向量路可独立召回语义相似
 * 而关键词不重叠的记忆。
 *
 * 策略（按规模取舍）：
 *   - 默认：精确 brute-force cosine（预计算范数），中小规模（< 5 万条）足够快；
 *   - 可选 `ivfBuckets`：按主导维度分桶的简化 IVF，查询时探测邻近分桶，
 *     降低大库扫描量（近似召回，用于更大规模）。
 *
 * 共享 entry.embedding 引用（不复制向量），内存开销仅为索引结构本身。
 */

/** 向量检索命中 */
export interface VectorSearchResult {
  id: string;
  score: number; // cosine 0..1
}

interface VecEntry {
  id: string;
  vec: number[];
  norm: number;
  bucket: number;
}

export interface VectorIndexOptions {
  /** IVF 分桶数（0 = 纯 brute-force 精确检索，默认 0） */
  ivfBuckets?: number;
}

function normOf(v: number[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export class VectorIndex {
  private entries = new Map<string, VecEntry>();
  /** bucket -> id 列表（仅 ivfBuckets > 0 时使用） */
  private buckets = new Map<number, string[]>();
  private dim = 0;
  private bucketCount: number;

  constructor(options: VectorIndexOptions = {}) {
    this.bucketCount = options.ivfBuckets ?? 0;
  }

  get size(): number {
    return this.entries.size;
  }

  /** 添加或替换向量（同 id 覆盖）。维度不一致时忽略，返回是否生效 */
  add(id: string, vector: number[]): boolean {
    if (!vector || vector.length === 0) return false;
    if (this.dim === 0) this.dim = vector.length;
    if (vector.length !== this.dim) return false;

    const prev = this.entries.get(id);
    if (prev && this.bucketCount > 0) this.removeFromBucket(id, prev.bucket);

    const entry: VecEntry = {
      id,
      vec: vector,
      norm: normOf(vector),
      bucket: this.bucketOf(vector),
    };
    this.entries.set(id, entry);

    if (this.bucketCount > 0) {
      let list = this.buckets.get(entry.bucket);
      if (!list) {
        list = [];
        this.buckets.set(entry.bucket, list);
      }
      if (!list.includes(id)) list.push(id);
    }
    return true;
  }

  remove(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    this.entries.delete(id);
    if (this.bucketCount > 0) this.removeFromBucket(id, e.bucket);
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.buckets.clear();
    this.dim = 0;
  }

  /** 检索 top-k（cosine 降序，score > 0） */
  search(query: number[], k: number): VectorSearchResult[] {
    if (this.entries.size === 0 || k <= 0 || !query || query.length === 0) return [];
    if (query.length !== this.dim) return [];

    const qNorm = normOf(query);
    if (qNorm === 0) return [];

    const pool =
      this.bucketCount > 0
        ? this.probeCandidates(query, k * 4)
        : [...this.entries.values()];

    const results: VectorSearchResult[] = [];
    for (const e of pool) {
      const score = dot(query, e.vec) / (qNorm * e.norm || 1);
      if (!(score > 0)) continue;
      results.push({ id: e.id, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }

  /** 主导维度（argmax |v|）分桶 */
  private bucketOf(vec: number[]): number {
    if (this.bucketCount <= 0) return 0;
    let best = 0;
    let bestAbs = -1;
    for (let i = 0; i < vec.length; i++) {
      const a = Math.abs(vec[i]);
      if (a > bestAbs) {
        bestAbs = a;
        best = i;
      }
    }
    return best % this.bucketCount;
  }

  /** 从查询桶开始探测邻近分桶，直到凑够 minCandidates */
  private probeCandidates(query: number[], minCandidates: number): VecEntry[] {
    const qBucket = this.bucketOf(query);
    const out: VecEntry[] = [];
    for (let r = 0; r < this.bucketCount && out.length < minCandidates; r++) {
      const list = this.buckets.get((qBucket + r) % this.bucketCount);
      if (!list) continue;
      for (const id of list) {
        const e = this.entries.get(id);
        if (e) out.push(e);
        if (out.length >= minCandidates) break;
      }
    }
    return out;
  }

  private removeFromBucket(id: string, bucket: number): void {
    const list = this.buckets.get(bucket);
    if (!list) return;
    const i = list.indexOf(id);
    if (i !== -1) list.splice(i, 1);
    if (list.length === 0) this.buckets.delete(bucket);
  }
}
