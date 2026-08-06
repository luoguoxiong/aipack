/**
 * apps/ai_blog_to_podcast_agent/src/config.ts
 *
 * 环境变量解析 + agentpack 模型/streamFn 装配。
 * 对齐 ai_travel_agent/config.ts 的「getBuiltinModel → adaptAiModel → createStreamFnFromAi」模式。
 * 多层容错:缺 Key 时给出明确提示而非崩溃,允许降级到无 Firecrawl Key 模式(走原生 fetch)。
 */
import './loadEnv.js'; // 副作用:最先加载 .env(必须在读取 process.env 之前)
import {
  getBuiltinModel,
  getBuiltinModels,
  hasProviderConfigured,
  adaptAiModel,
  createStreamFnFromAi,
  BUILTIN_PROVIDERS,
} from 'agentpack';
import type { Model, StreamFn } from 'agentpack';
import { describeScrapeBackend } from './tools/scrape.js';

/** 各 provider 的默认模型 id(与 ai/catalog.ts 对齐) */
const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  deepseek: 'deepseek-chat',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-sonnet-latest',
  google: 'gemini-2.0-flash',
  groq: 'llama-3.3-70b-versatile',
  mistral: 'mistral-small-latest',
  xai: 'grok-3-mini',
  moonshot: 'moonshot-v1-128k',
};

/** 供前端模型选择下拉使用的模型条目(由内置目录映射而来) */
export interface ModelOption {
  provider: string;
  providerName: string;
  modelId: string;
  modelName: string;
  /** 该 provider 是否已配置 API Key(决定前端是否禁用) */
  available: boolean;
  /** 是否为推理模型 */
  reasoning: boolean;
  /** 缺 Key 时提示用户设置的环境变量名 */
  envVar: string;
}

export interface AppConfig {
  port: number;
  provider: string;
  modelId: string;
  model: Model;
  streamFn: StreamFn;
  firecrawlKey?: string;
  /** 模型是否为真实接入(供 UI 展示状态) */
  llmReady: boolean;
  /** 抓取后端链描述(供 UI 展示) */
  scrapeBackend: string;
  /** 内置模型目录(供前端渲染模型选择下拉) */
  models: ModelOption[];
}

/** 读 env,返回标准化配置对象。缺失关键配置时返回带 warning 的降级配置。 */
export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT) || 3000;
  const provider = (process.env.LLM_PROVIDER || 'deepseek').toLowerCase();
  const modelId = process.env.LLM_MODEL || DEFAULT_MODEL_BY_PROVIDER[provider] || 'deepseek-chat';
  const firecrawlKey = process.env.FIRECRAWL_API_KEY || undefined;

  // ── 校验 provider 是否在内置列表 ──────────────────────────────
  const knownProviders = new Set(BUILTIN_PROVIDERS.map((p) => p.id));
  if (!knownProviders.has(provider)) {
    console.warn(
      `⚠️  未知 provider "${provider}",将尝试作为 OpenAI 兼容接入。内置: ${[...knownProviders].join(', ')}`,
    );
  }

  // ── 装配 model + streamFn ──────────────────────────────────────
  const aiModel = getBuiltinModel(provider, modelId);
  if (!aiModel) {
    throw new Error(
      `找不到内置模型 ${provider}/${modelId}。` +
        `可通过 LLM_PROVIDER / LLM_MODEL 环境变量指定其他内置模型。`,
    );
  }

  const llmReady = hasProviderConfigured(provider);
  if (!llmReady) {
    const envHint = `${provider.toUpperCase()}_API_KEY`;
    console.warn(`⚠️  未检测到 ${envHint},真实 LLM 调用会失败。`);
    console.warn('   设置后重试,例如: DEEPSEEK_API_KEY=sk-xxx pnpm --filter ai-blog-to-podcast-agent dev');
    console.warn('   无 Key 时仍可启动服务,但 /api/podcast 会返回错误提示。\n');
  }

  // ── 内置模型目录(供前端模型选择;available 取决于当前已配置的 API Key)──
  const models: ModelOption[] = getBuiltinModels().map((m) => {
    const meta = BUILTIN_PROVIDERS.find((p) => p.id === m.provider);
    return {
      provider: m.provider,
      providerName: meta?.name ?? m.provider,
      modelId: m.id,
      modelName: m.name,
      available: hasProviderConfigured(m.provider),
      reasoning: !!m.reasoning,
      envVar: meta?.envVar ?? `${m.provider.toUpperCase()}_API_KEY`,
    };
  });

  return {
    port,
    provider,
    modelId,
    model: adaptAiModel(aiModel),
    streamFn: createStreamFnFromAi(aiModel),
    firecrawlKey,
    llmReady,
    scrapeBackend: describeScrapeBackend(firecrawlKey),
    models,
  };
}

/**
 * 按 (provider, modelId) 构建模型 + streamFn。供 server 在运行时按用户选择装配 Runtime。
 * 模型不存在时抛明确错误,由调用方转为 400。
 */
export function buildModel(provider: string, modelId: string, apiKey?: string): { model: Model; streamFn: StreamFn } {
  const aiModel = getBuiltinModel(provider, modelId);
  if (!aiModel) {
    throw new Error(`找不到内置模型 ${provider}/${modelId}`);
  }
  // 提供用户 key 时透传给底层流式实现(streamOpenAI 优先用 options.apiKey);否则回退 env
  return { model: adaptAiModel(aiModel), streamFn: createStreamFnFromAi(aiModel, apiKey ? { apiKey } : {}) };
}

export interface ModelChoice {
  provider: string;
  modelId: string;
  /** `${provider}/${modelId}`,用于编入 sessionKey */
  modelKey: string;
  /** 用户在前端输入的 API Key(未提供则用服务器 env) */
  apiKey?: string;
}

/**
 * 校验并解析前端选择的模型:缺省回退默认模型;模型不存在或 Key 未配置时返回 error(供 400)。
 * 不抛异常,由调用方决定如何响应。
 */
export function resolveModelChoice(
  picked: { provider?: unknown; modelId?: unknown } | undefined,
  fallback: { provider: string; modelId: string },
  userKey?: string,
): { choice: ModelChoice; error: string | null } {
  const provider = String(picked?.provider || fallback.provider).toLowerCase();
  const modelId = String(picked?.modelId || fallback.modelId);
  const modelKey = `${provider}/${modelId}`;
  const apiKey = userKey?.trim() || undefined;
  if (!getBuiltinModel(provider, modelId)) {
    return { choice: { provider, modelId, modelKey, apiKey }, error: `未知模型 ${modelKey}` };
  }
  if (!hasProviderConfigured(provider) && !apiKey) {
    const meta = BUILTIN_PROVIDERS.find((p) => p.id === provider);
    const envVar = meta?.envVar ?? `${provider.toUpperCase()}_API_KEY`;
    return { choice: { provider, modelId, modelKey, apiKey }, error: `未配置 ${envVar},请在页面上方输入 API Key 或在 .env 设置` };
  }
  return { choice: { provider, modelId, modelKey, apiKey }, error: null };
}
