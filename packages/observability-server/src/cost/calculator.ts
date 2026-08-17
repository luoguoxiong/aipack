/**
 * CostCalculator — 模型调用成本计算（Phase 6）。
 *
 * 按 model span 的 token 用量与 model_prices 表单价计算成本（单位：分）。
 *
 * 计算公式：
 *   cents = round((input/1e6 * inputPer1m
 *                + output/1e6 * outputPer1m
 *                + cacheRead/1e6 * cacheReadPer1m
 *                + cacheWrite/1e6 * cacheWritePer1m) * 100)
 *
 * 价格查询：priceStore.getLatestPrice(modelId)，内存缓存 5 分钟，
 *           避免每个 span 都打 DB（高并发 ingest 场景下 QPS 可控）。
 *
 * 设计说明：
 *   priceStore.getLatestPrice 为异步（兼容 MySQL 连接池），而 calculate/
 *   calculateBatch 为同步（对齐任务接口，避免 worker 循环内逐个 await）。
 *   因此提供 preloadPrices(modelIds) 在批量计算前预热缓存；未预热时 calculate
 *   读缓存未命中则返回 0（符合"找不到价格时返回 0"且不阻塞 ingest 主路径）。
 */

import type { ModelPriceStore } from '../stores/model-price-store.js';

/** 模型价格（$/1M tokens，按 effectiveAt 生效） */
export interface ModelPrice {
  modelId: string;
  /** 输入 token 单价（$/1M tokens） */
  inputPer1m: number;
  /** 输出 token 单价（$/1M tokens） */
  outputPer1m: number;
  /** 缓存读取 token 单价（$/1M tokens，默认 0） */
  cacheReadPer1m: number;
  /** 缓存写入 token 单价（$/1M tokens，默认 0） */
  cacheWritePer1m: number;
  /** 币种（默认 'USD'） */
  currency: string;
  /** 生效时间（epoch ms） */
  effectiveAt: number;
}

/** 计算 cost 的 span 输入（与 SpanRecord 的子集对齐，modelId 可缺省） */
export interface CostSpanInput {
  modelId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface CostCalculator {
  /** 预加载给定 modelIds 的价格到内存缓存（异步，批量计算前调用一次） */
  preloadPrices(modelIds: string[]): Promise<void>;
  /** 根据 model span 计算 cost（分）；找不到价格返回 0（读缓存） */
  calculate(span: CostSpanInput): number;
  /** 批量计算并返回总 cost（分）；建议先调 preloadPrices 预热 */
  calculateBatch(spans: CostSpanInput[]): number;
}

/** 价格缓存条目：{ price, fetchedAt }；超 TTL 后重新查 DB */
interface PriceCacheEntry {
  price: ModelPrice | undefined;
  fetchedAt: number;
}

/** 价格内存缓存 TTL：5 分钟（避免每个 span 都打 DB） */
const PRICE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 创建 CostCalculator。
 *
 * @param priceStore 模型价格存储（SQLite / MySQL）
 */
export function createCostCalculator(priceStore: ModelPriceStore): CostCalculator {
  // modelId -> 缓存条目；缺省/未命中价格也缓存（避免重复查 DB）
  const cache = new Map<string, PriceCacheEntry>();

  /** 取 modelId 的最新价格（命中缓存且未过期直接返回，否则查 DB 并回填） */
  async function getPrice(modelId: string): Promise<ModelPrice | undefined> {
    const now = Date.now();
    const hit = cache.get(modelId);
    if (hit && now - hit.fetchedAt < PRICE_CACHE_TTL_MS) {
      return hit.price;
    }
    const price = await priceStore.getLatestPrice(modelId);
    cache.set(modelId, { price, fetchedAt: now });
    return price;
  }

  /** 同步读缓存（未命中或未预热返回 undefined） */
  function getCachedPrice(modelId: string): ModelPrice | undefined {
    const hit = cache.get(modelId);
    if (!hit) return undefined;
    // 过期则视为未命中（calculate 同步返回 0，下次 preloadPrices 会刷新）
    if (Date.now() - hit.fetchedAt >= PRICE_CACHE_TTL_MS) return undefined;
    return hit.price;
  }

  return {
    async preloadPrices(modelIds: string[]): Promise<void> {
      // 去重后并发查 DB 填充缓存
      const unique = [...new Set(modelIds)];
      await Promise.all(unique.map((id) => getPrice(id)));
    },

    calculate(span: CostSpanInput): number {
      if (!span.modelId) return 0;
      const price = getCachedPrice(span.modelId);
      if (!price) return 0;
      return computeCents(span, price);
    },

    calculateBatch(spans: CostSpanInput[]): number {
      let total = 0;
      for (const s of spans) {
        if (!s.modelId) continue;
        const price = getCachedPrice(s.modelId);
        if (!price) continue;
        total += computeCents(s, price);
      }
      return total;
    },
  };
}

/**
 * 按 token 用量与价格计算 cost（分）。
 * 公式：cents = round((in/1e6*pin + out/1e6*pout + cr/1e6*pcr + cw/1e6*pcw) * 100)
 */
function computeCents(span: CostSpanInput, price: ModelPrice | undefined): number {
  if (!price) return 0;
  const input = span.inputTokens ?? 0;
  const output = span.outputTokens ?? 0;
  const cacheRead = span.cacheRead ?? 0;
  const cacheWrite = span.cacheWrite ?? 0;
  const dollars =
    (input / 1e6) * price.inputPer1m +
    (output / 1e6) * price.outputPer1m +
    (cacheRead / 1e6) * price.cacheReadPer1m +
    (cacheWrite / 1e6) * price.cacheWritePer1m;
  return Math.round(dollars * 100);
}
