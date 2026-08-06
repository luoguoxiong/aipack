/**
 * apps/ai_travel_agent/src/config.ts
 *
 * 环境变量解析 + agentpack 模型/streamFn 装配。
 * 对齐根 examples/deepseek.ts 的「getBuiltinModel → adaptAiModel → createStreamFnFromAi」模式。
 * 多层容错:缺 Key 时给出明确提示而非崩溃,允许降级到无搜索 Key 模式。
 */
import './loadEnv.js'; // 副作用:最先加载 .env(必须在读取 process.env 之前)
import {
  getBuiltinModel,
  hasProviderConfigured,
  adaptAiModel,
  createStreamFnFromAi,
  BUILTIN_PROVIDERS,
} from 'agentpack';
import type { Model, StreamFn } from 'agentpack';

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

export interface AppConfig {
  port: number;
  provider: string;
  modelId: string;
  model: Model;
  streamFn: StreamFn;
  serpapiKey?: string;
  /** 模型是否为真实接入(供 UI 展示状态) */
  llmReady: boolean;
}

/** 读 env,返回标准化配置对象。缺失关键配置时返回带 warning 的降级配置。 */
export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT) || 3000;
  const provider = (process.env.LLM_PROVIDER || 'deepseek').toLowerCase();
  const modelId = process.env.LLM_MODEL || DEFAULT_MODEL_BY_PROVIDER[provider] || 'deepseek-chat';
  const serpapiKey = process.env.SERPAPI_KEY || undefined;

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
    console.warn('   设置后重试,例如: DEEPSEEK_API_KEY=sk-xxx pnpm --filter ai-travel-agent dev');
    console.warn('   无 Key 时仍可启动服务,但 /api/plan 会返回错误提示。\n');
  }

  return {
    port,
    provider,
    modelId,
    model: adaptAiModel(aiModel),
    streamFn: createStreamFnFromAi(aiModel),
    serpapiKey,
    llmReady,
  };
}
