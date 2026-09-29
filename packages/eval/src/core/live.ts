/**
 * packages/eval/src/core/live.ts - live 模式（真实 LLM）装配
 *
 * 职责：把「provider/modelId + apiKey + baseUrl」装配成 Runtime 可直接消费的
 * `{ model, streamFn }`，与 mock 模式的 fixture replay 对称。
 *
 * 消随机性（EVAL_PLAN.md 4.3）：
 *   - temperature 缺省 0（provider 支持即生效）
 *   - 本仓库适配层不支持 seed → 靠 repeats + pass@k 消噪，见 runner.ts
 *
 * 装配路径：getBuiltinModel（内置目录）→ 兜底构造 custom model（代理 / 兼容网关）
 *   → adaptAiModel（框架 Model）+ createStreamFnFromAi（StreamFn）
 */

import {
  BUILTIN_PROVIDERS,
  adaptAiModel,
  createStreamFnFromAi,
  getBuiltinModel,
  getEnvApiKey,
} from '@aipack-ai/agent';
// ai 层模型（含 api / baseUrl）走 '/ai' 子路径导入，避免与框架层 Model 同名混淆
import type { Model as AiModel, SimpleStreamOptions } from '@aipack-ai/agent/ai';
import type { Model, StreamFn } from '@aipack-ai/agent';

// ─── 规格 ─────────────────────────────────────────────────────────

export interface LiveLlmSpec {
  /** 提供商 id：deepseek / openai / anthropic / ... */
  provider: string;
  /** 模型 id：deepseek-chat / gpt-4o-mini / ...（不在内置目录时按 custom 兜底） */
  modelId: string;
  /** API Key；缺省取 <PROVIDER>_API_KEY 环境变量 */
  apiKey?: string;
  /** 覆盖内置端点（代理 / 兼容网关） */
  baseUrl?: string;
  /** 缺省 0（消随机性） */
  temperature?: number;
  /** 单次请求超时 ms */
  timeoutMs?: number;
}

export interface LiveLlm {
  spec: LiveLlmSpec;
  /** AI 层模型（含 api / baseUrl） */
  aiModel: AiModel;
  /** 框架层 Model，放进 RuntimeOptions.model */
  model: Model;
  /** 真实流式函数，放进 RuntimeOptions.streamFn */
  streamFn: StreamFn;
}

/** env 覆盖键（优先级低于显式参数，便于 CI 用 secrets 注入） */
export const LIVE_ENV_KEYS = {
  model: 'AIPACK_EVAL_MODEL',
  provider: 'AIPACK_EVAL_PROVIDER',
  apiKey: 'AIPACK_EVAL_API_KEY',
  baseUrl: 'AIPACK_EVAL_BASE_URL',
  temperature: 'AIPACK_EVAL_TEMPERATURE',
} as const;

/** 未显式指定 provider 时的探测顺序（与 CLI 默认策略一致：低成本在前） */
const PROBE_ORDER = [
  'deepseek',
  'openai',
  'anthropic',
  'groq',
  'moonshot',
  'google',
  'openrouter',
  'mistral',
  'xai',
  'cerebras',
  'together',
  'fireworks',
  'nvidia',
];

// ─── 解析 ─────────────────────────────────────────────────────────

/**
 * 解析 'provider/modelId' 或 'modelId'。
 * 仅给 modelId 时：优先 AIPACK_EVAL_PROVIDER，否则探测第一个已配置 Key 的 provider。
 */
export function parseModelSpec(spec: string): { provider: string; modelId: string } {
  const trimmed = spec.trim();
  const slash = trimmed.indexOf('/');
  if (slash > 0) {
    return {
      provider: trimmed.slice(0, slash),
      modelId: trimmed.slice(slash + 1),
    };
  }
  const envProvider = process.env[LIVE_ENV_KEYS.provider];
  if (envProvider) return { provider: envProvider, modelId: trimmed };
  const configured = PROBE_ORDER.find((p) => Boolean(getEnvApiKey(p)));
  if (configured) return { provider: configured, modelId: trimmed };
  throw new Error(
    `无法从 '${spec}' 推断 provider：请写全 'provider/modelId'，或设置 ${LIVE_ENV_KEYS.provider} / <PROVIDER>_API_KEY`,
  );
}

export interface ResolveLiveOptions {
  /** 'provider/modelId' 或 'modelId'；缺省读 AIPACK_EVAL_MODEL */
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  timeoutMs?: number;
}

/** 合并显式参数与环境变量，得到最终生效的 LiveLlmSpec */
export function resolveLiveSpec(opts: ResolveLiveOptions = {}): LiveLlmSpec {
  const env = process.env;
  const raw = opts.model ?? env[LIVE_ENV_KEYS.model];
  if (!raw) {
    throw new Error(
      `live 模式需要指定模型：--model provider/modelId 或 ${LIVE_ENV_KEYS.model}（如 deepseek/deepseek-chat）`,
    );
  }
  const { provider, modelId } = parseModelSpec(raw);

  const envTemp = env[LIVE_ENV_KEYS.temperature];
  const temperature =
    opts.temperature ?? (envTemp !== undefined && envTemp !== '' ? Number(envTemp) : undefined);

  const spec: LiveLlmSpec = {
    provider,
    modelId,
    apiKey: opts.apiKey ?? env[LIVE_ENV_KEYS.apiKey] ?? getEnvApiKey(provider),
    baseUrl: opts.baseUrl ?? env[LIVE_ENV_KEYS.baseUrl],
    temperature: temperature ?? 0,
  };
  if (opts.timeoutMs !== undefined) spec.timeoutMs = opts.timeoutMs;
  return spec;
}

// ─── 装配 ─────────────────────────────────────────────────────────

/** 内置目录缺失时的兜底：按 provider 推断 api 与端点 */
function buildCustomModel(provider: string, modelId: string): AiModel {
  const meta = BUILTIN_PROVIDERS.find((p) => p.id === provider);
  const baseUrl = meta?.baseUrl;
  if (!baseUrl) {
    throw new Error(
      `未知 provider '${provider}'：内置提供商为 ${BUILTIN_PROVIDERS.map((p) => p.id).join(', ')}`,
    );
  }
  return {
    id: modelId,
    name: modelId,
    api: provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
    provider,
    baseUrl,
    reasoning: false,
    input: ['text'],
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

/**
 * 装配真实 LLM。不发起任何网络请求（只是闭包），可安全单测。
 *
 * 注意：createStreamFnFromAi 优先使用 runtime 传入的 model，
 * 因此必须把返回的 model 一起交给 createRuntime，否则 api 分派会不一致。
 */
export function createLiveLlm(spec: LiveLlmSpec): LiveLlm {
  const base = getBuiltinModel(spec.provider, spec.modelId);
  const aiModel: AiModel = base
    ? spec.baseUrl
      ? { ...base, baseUrl: spec.baseUrl }
      : base
    : buildCustomModel(spec.provider, spec.modelId);

  const options: SimpleStreamOptions = { temperature: spec.temperature ?? 0 };
  if (spec.apiKey) options.apiKey = spec.apiKey;
  if (spec.timeoutMs !== undefined) options.timeoutMs = spec.timeoutMs;

  return {
    spec,
    aiModel,
    model: adaptAiModel(aiModel),
    streamFn: createStreamFnFromAi(aiModel, options),
  };
}

/** 从 CLI/库参数一步到位：解析 spec → 装配 LLM */
export function resolveLiveLlm(opts: ResolveLiveOptions = {}): LiveLlm {
  return createLiveLlm(resolveLiveSpec(opts));
}

/** 报告 / 日志用的模型标识（'deepseek/deepseek-chat'） */
export function describeLiveLlm(spec: LiveLlmSpec): string {
  return `${spec.provider}/${spec.modelId}`;
}

/** live 模式前置检查：缺 Key 时给出可操作的错误信息 */
export function assertLiveReady(spec: LiveLlmSpec): void {
  if (spec.apiKey) return;
  const envName = BUILTIN_PROVIDERS.find((p) => p.id === spec.provider)?.envVar;
  throw new Error(
    `provider '${spec.provider}' 未配置 API Key：--api-key <key>、${LIVE_ENV_KEYS.apiKey} 或 ${envName ?? '<PROVIDER>_API_KEY'}`,
  );
}
