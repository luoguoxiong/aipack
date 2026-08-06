/**
 * apps/ai_travel_agent/src/runtime.ts
 *
 * 忠实映射 awesome-llm-apps ai_travel_agent 的双 Agent 设计:
 *   - Researcher:用搜索工具检索目的地活动/住宿,返回研究结果
 *   - Planner:基于研究结果生成结构化行程草稿
 *
 * agentpack 是单 Runtime 框架,故用两个独立 Runtime 实例 + 链式编排。
 * Planner 用 stream() 流式输出,通过 onProgress 回调把增量推给 SSE。
 *
 * prompt 移植自 awesome-llm-apps/starter_ai_agents/ai_travel_agent/travel_agent.py。
 */
import {
  createRuntime,
  createRequest,
  createFileSessionStorage,
  type Model,
  type StreamFn,
  type Runtime,
} from 'agentpack';
import { createSearchTool } from './tools/search.js';
import { buildModel } from './config.js';
import { createHash } from 'node:crypto';

const RESEARCHER_SYSTEM_PROMPT = `你是一位世界级的旅行研究员。给定一个旅行目的地和用户想要旅行的天数,你会生成一组用于查找相关旅行活动和住宿的搜索词,然后对每个搜索词搜索网络,分析结果,并返回最相关的结果。

注意结果质量至关重要:聚焦于真实、具体、可执行的活动、景点、住宿与交通信息,避免空泛描述。`;

const PLANNER_SYSTEM_PROMPT = `你是一位资深旅行规划师。给定一个旅行目的地、用户想要旅行的天数以及一份研究结果列表,你的目标是生成一份满足用户需求与偏好的行程草稿。

行程要求:
- 按天组织(Day 1、Day 2 ...),每天包含上午/下午/傍晚的建议活动、用餐与住宿
- 结构清晰、信息丰富、有吸引力,适当引用研究结果中的事实
- 提供平衡且有层次的行程,不要堆砌
- 永远不要编造事实或抄袭,务必基于研究结果
- 聚焦清晰度、连贯性与整体质量
- 用中文输出,使用 "Day N:" 作为每天的小标题(便于后续解析为日历事件)`;

export interface PlanInput {
  destination: string;
  days: number;
  /** 模型标识 `${provider}/${modelId}`,编入 sessionKey 以隔离不同模型的会话历史 */
  modelKey?: string;
}

export interface PlanProgress {
  /** 阶段事件:research_start | research_done | plan_start | plan_delta | done | error */
  type: 'research_start' | 'research_done' | 'plan_start' | 'plan_delta' | 'done' | 'error';
  /** plan_delta 时的增量文本 */
  delta?: string;
  /** done 时的完整行程 */
  itinerary?: string;
  /** research_done 时的研究结果摘要 */
  research?: string;
  /** error 时的错误信息 */
  message?: string;
}

/** 构建 Researcher Runtime:带搜索工具 */
export function createResearcherRuntime(model: Model, streamFn: StreamFn, serpapiKey?: string): Runtime {
  return createRuntime({
    model,
    streamFn,
    systemPrompt: RESEARCHER_SYSTEM_PROMPT,
    tools: [createSearchTool(serpapiKey)],
    sessionStorage: createFileSessionStorage({
      baseDir: '.agentpack/travel-sessions',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 天
    }),
    maxTurns: 20, // 允许 Researcher 多轮搜索
    config: { role: 'researcher' },
  });
}

/** 构建 Planner Runtime:纯生成,无工具 */
export function createPlannerRuntime(model: Model, streamFn: StreamFn): Runtime {
  return createRuntime({
    model,
    streamFn,
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    tools: [],
    sessionStorage: createFileSessionStorage({
      baseDir: '.agentpack/travel-sessions',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    }),
    maxTurns: 5,
    config: { role: 'planner' },
  });
}

/**
 * 编排两阶段流水线:Researcher(同步) → Planner(流式)。
 *
 * @param input 目的地与天数
 * @param runtimes 已构建的 researcher / planner Runtime
 * @param onProgress 流式进度回调(用于 SSE 推送)
 * @param signal 可选 AbortSignal,用于客户端断开时中止
 */
export async function planTravel(
  input: PlanInput,
  runtimes: { researcher: Runtime; planner: Runtime },
  onProgress: (p: PlanProgress) => void,
  signal?: AbortSignal,
): Promise<{ research: string; itinerary: string }> {
  const { destination, days } = input;
  const safeDays = Math.max(1, Math.min(30, Math.trunc(days) || 7));
  // 把模型标识编入 sessionKey,隔离不同模型的会话历史(/ 转为 - 避免路径分隔符)
  const modelTag = input.modelKey ? `:${input.modelKey.replace(/[^a-z0-9._-]+/gi, '-')}` : '';

  // ── 阶段 1:Researcher 同步研究 ───────────────────────────────
  onProgress({ type: 'research_start' });
  const researcherSession = `researcher:${slug(destination)}${modelTag}`;
  const researchReq = createRequest(
    `请为目的地「${destination}」规划一次 ${safeDays} 天的旅行。` +
      `先列出 3 个相关搜索词,逐个调用 search_web 搜索,然后汇总返回最相关的研究结果(景点、活动、住宿、交通、美食)。`,
    { sessionKey: researcherSession },
  );

  const researchResult = await runtimes.researcher.run(researchReq);
  if (!researchResult.success) {
    throw new Error(researchResult.error || '研究阶段失败');
  }
  const research = researchResult.content;
  onProgress({ type: 'research_done', research });

  if (signal?.aborted) throw new Error('aborted');

  // ── 阶段 2:Planner 流式生成行程 ───────────────────────────────
  onProgress({ type: 'plan_start' });
  const plannerSession = `planner:${slug(destination)}${modelTag}`;
  const plannerReq = createRequest(
    [
      `目的地: ${destination}`,
      `天数: ${safeDays} 天`,
      `研究结果:`,
      research,
      '',
      '请基于以上研究结果,生成一份详细的、按天组织的行程。',
      '每天用 "Day N:" 作为小标题开头。',
    ].join('\n'),
    { sessionKey: plannerSession },
  );

  let itinerary = '';
  for await (const chunk of runtimes.planner.stream(plannerReq)) {
    if (signal?.aborted) throw new Error('aborted');
    if (chunk.type === 'text' && chunk.content) {
      itinerary += chunk.content;
      onProgress({ type: 'plan_delta', delta: chunk.content });
    }
    if (chunk.type === 'error') {
      throw new Error(chunk.content || '生成行程时出错');
    }
  }

  onProgress({ type: 'done', itinerary });
  return { research, itinerary };
}

/** 把目的地转为 session key 友好的 slug */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'default';
}

// ─── Runtime 注册表:按 (provider, modelId) 缓存 Runtime 复用 ──────────

export interface RuntimePair {
  researcher: Runtime;
  planner: Runtime;
}

export interface RuntimeRegistry {
  /** 取(或首次构建并缓存)指定模型的 researcher/planner Runtime。apiKey 为用户提供的 key(不传则用 env)。模型不存在时抛错。 */
  get(provider: string, modelId: string, apiKey?: string): RuntimePair;
  /** 关闭所有缓存的 Runtime(优雅退出时调用) */
  closeAll(): Promise<void>;
}

/**
 * 创建 Runtime 注册表。模型在首次被选中时按需构建并缓存,
 * 避免每次请求重建,同时支持运行时切换模型。
 */
export function createRuntimeRegistry(serpapiKey?: string): RuntimeRegistry {
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
          researcher: createResearcherRuntime(model, streamFn, serpapiKey),
          planner: createPlannerRuntime(model, streamFn),
        };
        cache.set(cacheKey, pair);
      }
      return pair;
    },
    async closeAll() {
      await Promise.allSettled(
        [...cache.values()].map((p) => Promise.all([p.researcher.close(), p.planner.close()])),
      );
      cache.clear();
    },
  };
}
