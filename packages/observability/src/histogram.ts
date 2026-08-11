/**
 * 在线对数直方图：O(1) 插入，任意时刻可查分位数，无需保留原始值。
 *
 * 覆盖范围 0.1ms ~ 10min，每 2^(1/8) ≈ 1.09 倍一桶（约 184 桶）。
 * 分位数取所在桶上界（保守口径，对 SLO 告警安全）。
 */

const MIN_VALUE = 0.1; // 0.1ms
const MAX_VALUE = 10 * 60 * 1000; // 10min
const PRECISION = 8; // log2 桶内的细分精度
const MAX_BUCKET = Math.ceil(Math.log2(MAX_VALUE / MIN_VALUE) * PRECISION);

export class Histogram {
  private buckets = new Map<number, number>();
  private total = 0;

  /** 插入一个样本（O(1)），非正/非有限值忽略 */
  insert(v: number): void {
    if (!Number.isFinite(v) || v <= 0) return;
    const idx = Math.min(
      MAX_BUCKET,
      Math.max(0, Math.floor(Math.log2(v / MIN_VALUE) * PRECISION)),
    );
    this.buckets.set(idx, (this.buckets.get(idx) ?? 0) + 1);
    this.total += 1;
  }

  count(): number {
    return this.total;
  }

  /** 分位数：q=0.5 → p50、0.95 → p95、0.99 → p99；无样本返回 0 */
  quantile(q: number): number {
    if (this.total === 0) return 0;
    const target = this.total * q;
    let cum = 0;
    const idxs = [...this.buckets.keys()].sort((a, b) => a - b);
    for (const idx of idxs) {
      cum += this.buckets.get(idx)!;
      if (cum >= target) {
        return Math.min(MIN_VALUE * 2 ** ((idx + 1) / PRECISION), MAX_VALUE);
      }
    }
    return MAX_VALUE;
  }

  /** 合并另一个直方图（窗口聚合用） */
  merge(other: Histogram): void {
    for (const [idx, c] of other.buckets) {
      this.buckets.set(idx, (this.buckets.get(idx) ?? 0) + c);
    }
    this.total += other.total;
  }
}
