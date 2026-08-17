/**
 * Phase 9 — 采样策略模块。
 *
 * 三种采样策略：
 * - none: 不采样（全量，或兼容旧 sampleRate 行为）
 * - traceid-ratio: 一致性 head 采样。同 traceId 全量子采样（runs/spans/toolCalls 一致）
 * - error-priority: 错误 run 必采，成功 run 按 rate 采样
 * - slow-priority: 慢请求（> P95 阈值）必采，其余按 rate 采样
 */

export type SampleStrategy =
  | { type: 'none' }
  | { type: 'traceid-ratio'; rate: number }
  | { type: 'error-priority'; successRate: number }
  | { type: 'slow-priority'; rate: number; slowThresholdMs?: number }
  /** 【旧兼容】sampleRate 的语义：整 run 全量保留，仅过滤 model/tool spans 与 toolCalls（明细级） */
  | { type: 'legacy-detail-ratio'; rate: number };

export interface SampleStrategyOptions {
  /** 采样策略：'traceid-ratio' | 'error-priority' | 'slow-priority' | 'none'（默认 none） */
  strategy?: 'traceid-ratio' | 'error-priority' | 'slow-priority' | 'none';
  /** traceid-ratio / slow-priority 的采样率（0-1），默认 0.1 */
  rate?: number;
  /** error-priority 下成功 run 的采样率（0-1），默认 0.1 */
  successRate?: number;
  /** slow-priority 下慢请求阈值（ms），未配置时走 SDK 内部滑动 P95（若无法统计则默认 30000ms） */
  slowThresholdMs?: number;
}

/** 将用户配置解析为结构化 SampleStrategy */
export function resolveSampleStrategy(opts: SampleStrategyOptions): SampleStrategy {
  const type = opts.strategy ?? 'none';
  switch (type) {
    case 'traceid-ratio': {
      const rate = clamp01(opts.rate ?? 0.1);
      return { type: 'traceid-ratio', rate };
    }
    case 'error-priority': {
      const successRate = clamp01(opts.successRate ?? 0.1);
      return { type: 'error-priority', successRate };
    }
    case 'slow-priority': {
      const rate = clamp01(opts.rate ?? 0.1);
      return { type: 'slow-priority', rate, slowThresholdMs: opts.slowThresholdMs };
    }
    case 'none':
    default:
      return { type: 'none' };
  }
}

/** 旧 sampleRate（0–1 简单概率）转换为等价策略：
 *  【重要】语义保留：整 run（+ run span）全量保留，仅 model/tool spans 与 toolCalls 按 rate 过滤。
 */
export function legacySampleRateToStrategy(rate: number | undefined): SampleStrategy {
  if (rate === undefined || rate >= 1) return { type: 'none' };
  const r = clamp01(rate);
  return { type: 'legacy-detail-ratio', rate: r };
}

// ─── 采样判定器（SDK 单例，内部维护状态）────────────────────────

export interface SamplingJudge {
  /** run 是否采样：只对整 run 的"是否保留"决策；spans/toolCalls 随 run */
  shouldKeepRun(info: {
    traceId: string;
    status: 'success' | 'error' | 'validation';
    durationMs: number;
  }): boolean;
  /** 明细（span/toolCall）采样：当 run 采样通过时才进一步过滤；未通过直接 false */
  shouldKeepDetail(traceId: string): boolean;
}

export function createSamplingJudge(strategy: SampleStrategy): SamplingJudge {
  // ─── traceid-ratio：一致性哈希，同 trace 结果稳定 ────────────────
  if (strategy.type === 'traceid-ratio') {
    const rate = strategy.rate;
    if (rate <= 0) {
      return {
        shouldKeepRun: () => false,
        shouldKeepDetail: () => false,
      };
    }
    if (rate >= 1) {
      return {
        shouldKeepRun: () => true,
        shouldKeepDetail: () => true,
      };
    }
    return {
      shouldKeepRun: ({ traceId }) => traceIdConsistentHash(traceId) < rate,
      shouldKeepDetail: (traceId) => traceIdConsistentHash(traceId) < rate,
    };
  }

  // ─── error-priority：错误必采，成功按 successRate 概率采样 ───────
  if (strategy.type === 'error-priority') {
    const { successRate } = strategy;
    if (successRate <= 0) {
      // 仅保留错误
      return {
        shouldKeepRun: ({ status }) => status === 'error',
        shouldKeepDetail: (traceId) => sampledRunSet.has(traceId),
      };
    }
    if (successRate >= 1) {
      return {
        shouldKeepRun: () => true,
        shouldKeepDetail: () => true,
      };
    }
    return {
      shouldKeepRun: ({ traceId, status }) => {
        const keep = status === 'error' ? true : Math.random() < successRate;
        if (keep) sampledRunSet.add(traceId);
        else sampledRunSet.delete(traceId);
        return keep;
      },
      shouldKeepDetail: (traceId) => sampledRunSet.has(traceId),
    };
  }

  // ─── slow-priority：慢请求必采，其余按 rate 采样 ───────────────
  if (strategy.type === 'slow-priority') {
    const { rate, slowThresholdMs } = strategy;
    // 慢阈值：未配置时滑动 P95 近似（前 1000 条 duration 升序数组 + p95）
    const window = new SlidingP95();
    const thresholdFallback = slowThresholdMs ?? 30_000;
    if (rate <= 0) {
      return {
        shouldKeepRun: ({ traceId, durationMs }) => {
          const p95 = window.get() ?? thresholdFallback;
          window.push(durationMs);
          const keep = durationMs >= p95;
          if (keep) sampledRunSet.add(traceId);
          else sampledRunSet.delete(traceId);
          return keep;
        },
        shouldKeepDetail: (traceId) => sampledRunSet.has(traceId),
      };
    }
    if (rate >= 1) {
      return {
        shouldKeepRun: () => true,
        shouldKeepDetail: () => true,
      };
    }
    return {
      shouldKeepRun: ({ traceId, durationMs }) => {
        const p95 = window.get() ?? thresholdFallback;
        window.push(durationMs);
        const keep = durationMs >= p95 ? true : Math.random() < rate;
        if (keep) sampledRunSet.add(traceId);
        else sampledRunSet.delete(traceId);
        return keep;
      },
      shouldKeepDetail: (traceId) => sampledRunSet.has(traceId),
    };
  }

  // ─── legacy-detail-ratio：旧 sampleRate 语义（run 全量，仅明细过滤）─────
  if (strategy.type === 'legacy-detail-ratio') {
    const rate = strategy.rate;
    if (rate <= 0) {
      // rate=0：run 保留，所有明细丢弃
      return {
        shouldKeepRun: ({ traceId }) => {
          sampledRunSet.add(traceId);
          return true;
        },
        shouldKeepDetail: () => false,
      };
    }
    if (rate >= 1) {
      return {
        shouldKeepRun: ({ traceId }) => {
          sampledRunSet.add(traceId);
          return true;
        },
        shouldKeepDetail: () => true,
      };
    }
    return {
      shouldKeepRun: ({ traceId }) => {
        sampledRunSet.add(traceId);
        return true;
      },
      shouldKeepDetail: (traceId) => traceIdConsistentHash(traceId) < rate,
    };
  }

  // ─── none：全量 ───────────────────────────────────────────────
  return {
    shouldKeepRun: ({ traceId }) => {
      sampledRunSet.add(traceId);
      return true;
    },
    shouldKeepDetail: () => true,
  };
}

// ─── 内部工具 ────────────────────────────────────────────────────

/** 已采样通过的 traceId 集合：用于 shouldKeepDetail 联动判定 */
const sampledRunSet = new Set<string>();

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** traceId → [0,1) 一致性哈希（简单但足够的 MD5 截断替代：FNV-1a 32bit / 2^32） */
function traceIdConsistentHash(traceId: string): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < traceId.length; i++) {
    h ^= traceId.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  return (h >>> 0) / 0x100000000;
}

/** 滑动 P95 近似：维护最近 N 条 duration，取排序后第 95% 位置 */
class SlidingP95 {
  private buf: number[] = [];
  private static readonly CAP = 1000;

  push(d: number): void {
    this.buf.push(d);
    if (this.buf.length > SlidingP95.CAP) this.buf.shift();
  }

  /** 返回 p95，样本不足返回 undefined（调用方 fallback 到默认阈值） */
  get(): number | undefined {
    if (this.buf.length < 30) return undefined;
    const sorted = [...this.buf].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return sorted[Math.min(idx, sorted.length - 1)];
  }
}
