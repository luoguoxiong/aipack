/**
 * apps/ai_blog_to_podcast_agent/src/runtime.ts
 *
 * 单 Agent 设计:
 *   - Summarizer:用 scrape_blog 工具抓取博客正文,生成 ≤2000 字符的对话式播客摘要
 *
 * 与 ai_travel_agent 双 Agent 的关键差异:本应用用单个 Runtime 一把梭,
 * Summarizer 用 stream() 同时完成抓取与摘要,通过 ResultChunk.type 区分阶段:
 *   tool_start/tool_end → 抓取阶段;text → 摘要增量。
 */
import {
  createRuntime,
  createRequest,
  createFileSessionStorage,
  type Model,
  type StreamFn,
  type Runtime,
} from '@aipack-ai/agent';
import { createScrapeTool } from './tools/scrape.js';
import { buildModel } from './config.js';
import { createHash } from 'node:crypto';

const SUMMARIZER_SYSTEM_PROMPT = `你是一位资深的播客内容编辑。给定一个博客 URL,你的任务是:
1. 调用 scrape_blog 工具抓取博客正文
2. 基于抓取到的正文,生成一段简洁、生动、适合播客口播的对话式摘要

摘要要求:
- 总长度不超过 2000 个字符
- 用口语化、对话式的表达,像主持人在播客中讲述一样
- 抓住博客的核心观点、关键事实与亮点,避免堆砌细节
- 不要编造原文中没有的事实
- 不要包含"以下是摘要"之类的元描述,直接给出播客口播内容
- 用中文输出(若原文为外文,翻译并改写为中文口播)`;

export interface PodcastInput {
  url: string;
  /** 模型标识 `${provider}/${modelId}`,编入 sessionKey 以隔离不同模型的会话历史 */
  modelKey?: string;
}

export interface PodcastProgress {
  /** 阶段事件:scrape_start | scrape_done | summary_start | summary_delta | done | error */
  type: 'scrape_start' | 'scrape_done' | 'summary_start' | 'summary_delta' | 'done' | 'error';
  /** summary_delta 时的增量文本 */
  delta?: string;
  /** done 时的完整摘要 */
  summary?: string;
  /** error 时的错误信息 */
  message?: string;
}

/** 构建 Summarizer Runtime:带抓取工具 */
export function createSummarizerRuntime(model: Model, streamFn: StreamFn, firecrawlKey?: string): Runtime {
  return createRuntime({
    model,
    streamFn,
    systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
    tools: [createScrapeTool(firecrawlKey)],
    sessionStorage: createFileSessionStorage({
      baseDir: '.aipack/podcast-sessions',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 天
    }),
    maxTurns: 10, // 允许抓取 + 生成,无需太多轮
    config: { role: 'summarizer' },
  });
}

/**
 * 单阶段流式编排:Summarizer 用 stream() 同时抓取并生成摘要。
 * 通过 chunk.type 推断阶段:tool_start/tool_end → 抓取;text → 摘要增量。
 *
 * @param input 博客 URL
 * @param runtime 已构建的 Summarizer Runtime
 * @param onProgress 流式进度回调(用于 SSE 推送)
 * @param signal 可选 AbortSignal,用于客户端断开时中止
 */
export async function generatePodcast(
  input: PodcastInput,
  runtime: Runtime,
  onProgress: (p: PodcastProgress) => void,
  signal?: AbortSignal,
): Promise<{ summary: string }> {
  const { url } = input;

  const req = createRequest(`请抓取以下博客并生成播客摘要(不超过 2000 字符):\n\n${url}`);

  let summary = '';
  let scrapeStarted = false;
  let summaryStarted = false;

  for await (const chunk of runtime.stream(req)) {
    if (signal?.aborted) throw new Error('aborted');

    if (chunk.type === 'tool_start' && chunk.toolName === 'scrape_blog') {
      if (!scrapeStarted) {
        scrapeStarted = true;
        onProgress({ type: 'scrape_start' });
      }
    } else if (chunk.type === 'tool_end' && chunk.toolName === 'scrape_blog') {
      onProgress({ type: 'scrape_done' });
    } else if (chunk.type === 'text' && chunk.content) {
      if (!summaryStarted) {
        summaryStarted = true;
        onProgress({ type: 'summary_start' });
      }
      summary += chunk.content;
      onProgress({ type: 'summary_delta', delta: chunk.content });
    } else if (chunk.type === 'error') {
      throw new Error(chunk.content || '生成摘要时出错');
    }
    // chunk.type === 'done' 由循环结束自然处理
  }

  if (!summary.trim()) throw new Error('未生成摘要内容');
  onProgress({ type: 'done', summary });
  return { summary };
}



// ─── Runtime 注册表:按 (provider, modelId) 缓存 Runtime 复用 ──────────

export interface RuntimeRegistry {
  /** 取(或首次构建并缓存)指定模型的 Summarizer Runtime。apiKey 为用户提供的 key(不传则用 env)。模型不存在时抛错。 */
  get(provider: string, modelId: string, apiKey?: string): Runtime;
  /** 关闭所有缓存的 Runtime(优雅退出时调用) */
  closeAll(): Promise<void>;
}

/**
 * 创建 Runtime 注册表。模型在首次被选中时按需构建并缓存,
 * 避免每次请求重建,同时支持运行时切换模型。
 */
export function createRuntimeRegistry(firecrawlKey?: string): RuntimeRegistry {
  const cache = new Map<string, Runtime>();
  return {
    get(provider, modelId, apiKey) {
      // 用 key 的哈希区分缓存(不明文存 key);env key 用 'env'
      const keyTag = apiKey ? `u:${createHash('sha256').update(apiKey).digest('hex').slice(0, 8)}` : 'env';
      const cacheKey = `${provider}/${modelId}:${keyTag}`;
      let rt = cache.get(cacheKey);
      if (!rt) {
        const { model, streamFn } = buildModel(provider, modelId, apiKey);
        rt = createSummarizerRuntime(model, streamFn, firecrawlKey);
        cache.set(cacheKey, rt);
      }
      return rt;
    },
    async closeAll() {
      await Promise.allSettled([...cache.values()].map((rt) => rt.close()));
      cache.clear();
    },
  };
}
