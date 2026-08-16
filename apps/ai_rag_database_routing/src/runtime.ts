/**
 * apps/ai_rag_database_routing/src/runtime.ts
 *
 * 两个无工具 Runtime:
 *   - Router:查询路由专家,严格只输出 products / support / finance 三者之一
 *   - Answer:RAG/网页上下文回答专家,基于给定上下文流式作答
 *
 * 与 ai_travel_agent 相同:用独立 Runtime 实例 + 内存会话存储,按
 * (provider, modelId, apiKey) 构建并缓存,支持运行时切换模型。
 */
import {
  createRuntime,
  createMemorySessionStorage,
  type Model,
  type StreamFn,
  type Runtime,
} from '@aipack-ai/agent';
import { buildModel } from './config.js';
import { createHash } from 'node:crypto';

/** 路由专家系统提示词(要求只输出数据库名,与原版 agno 路由 Agent 一致) */
export const ROUTER_SYSTEM_PROMPT = `你是一位查询路由专家。你的唯一工作是分析用户的提问,判断它应该被路由到哪个数据库。
可选数据库(只能返回其中一个):
- products:关于产品、功能、规格、商品详情或产品手册的问题
- support:关于帮助、指引、故障排查、客户服务、FAQ 或操作指南的问题
- finance:关于成本、收入、定价或财务数据、财务报告与投资的问题

严格规则:
1. 只返回数据库名(products / support / finance 之一)
2. 不要输出任何其他文本、解释或标点
3. 如果你不确定如何路由,返回空字符串`;

/** 回答专家系统提示词(上下文回答,与检索链行为一致) */
export const ANSWER_SYSTEM_PROMPT = `你是一位乐于助人的 AI 助手,基于提供的上下文回答用户问题。
要求:
- 回答直接、简洁、准确
- 严格基于提供的上下文,不要编造或臆测
- 如果上下文信息不足以完整回答,明确说明这一限制
- 如果提供的是网络搜索结果,基于搜索内容回答并注明这是搜索结果`;

/** 构建 Router Runtime:严格分类,无工具,单轮 */
export function createRouterRuntime(model: Model, streamFn: StreamFn): Runtime {
  return createRuntime({
    model,
    streamFn,
    systemPrompt: ROUTER_SYSTEM_PROMPT,
    tools: [],
    sessionStorage: createMemorySessionStorage(),
    maxTurns: 1,
    config: { role: 'router' },
  });
}

/** 构建 Answer Runtime:纯生成,无工具,单轮 */
export function createAnswerRuntime(model: Model, streamFn: StreamFn): Runtime {
  return createRuntime({
    model,
    streamFn,
    systemPrompt: ANSWER_SYSTEM_PROMPT,
    tools: [],
    sessionStorage: createMemorySessionStorage(),
    maxTurns: 1,
    config: { role: 'answer' },
  });
}

// ─── Runtime 注册表:按 (provider, modelId, apiKey) 缓存复用 ──────────

export interface RuntimePair {
  router: Runtime;
  answer: Runtime;
}

export interface RuntimeRegistry {
  /** 取(或首次构建并缓存)指定模型的 router/answer Runtime。apiKey 为用户提供的 key(不传则用 env)。模型不存在时抛错。 */
  get(provider: string, modelId: string, apiKey?: string): RuntimePair;
  /** 关闭所有缓存的 Runtime(优雅退出时调用) */
  closeAll(): Promise<void>;
}

/**
 * 创建 Runtime 注册表。模型在首次被选中时按需构建并缓存,
 * 避免每次请求重建,同时支持运行时切换模型。
 */
export function createRuntimeRegistry(): RuntimeRegistry {
  const cache = new Map<string, RuntimePair>();
  return {
    get(provider, modelId, apiKey) {
      // 用 key 的哈希区分缓存(不明文存 key);env key 用 'env'
      const keyTag = apiKey ? `u:${createHash('sha256').update(apiKey).digest('hex').slice(0, 8)}` : 'env';
      const cacheKey = `${provider}/${modelId}:${keyTag}`;
      let pair = cache.get(cacheKey);
      if (!pair) {
        const { model, streamFn } = buildModel(provider, modelId, apiKey);
        pair = {
          router: createRouterRuntime(model, streamFn),
          answer: createAnswerRuntime(model, streamFn),
        };
        cache.set(cacheKey, pair);
      }
      return pair;
    },
    async closeAll() {
      await Promise.allSettled(
        [...cache.values()].map((p) => Promise.all([p.router.close(), p.answer.close()])),
      );
      cache.clear();
    },
  };
}
