import type { Model } from './types';

// ─── 内置模型目录 ───────────────────────────────────────────────────
// 每个提供商的通用模型。baseUrl 指向 API 端点。

const OPENAI_BASE = 'https://api.openai.com/v1';
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const ANTHROPIC_BASE = 'https://api.anthropic.com';
const GROQ_BASE = 'https://api.groq.com/openai/v1';
const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const MISTRAL_BASE = 'https://api.mistral.ai/v1';
const XAI_BASE = 'https://api.x.ai/v1';
const CEREBRAS_BASE = 'https://api.cerebras.ai/v1';
const TOGETHER_BASE = 'https://api.together.xyz/v1';
const FIREWORKS_BASE = 'https://api.fireworks.ai/inference/v1';
const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1';
const MOONSHOT_BASE = 'https://api.moonshot.cn/v1';

export const BUILTIN_MODELS: Model[] = [
  // ── OpenAI ──────────────────────────────────────────────────────
  { id: 'gpt-4o', name: 'GPT-4o', api: 'openai-completions', provider: 'openai', baseUrl: OPENAI_BASE, reasoning: false, input: ['text', 'image'], contextWindow: 128000, maxTokens: 16384 },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', api: 'openai-completions', provider: 'openai', baseUrl: OPENAI_BASE, reasoning: false, input: ['text', 'image'], contextWindow: 128000, maxTokens: 16384 },
  { id: 'gpt-5', name: 'GPT-5', api: 'openai-completions', provider: 'openai', baseUrl: OPENAI_BASE, reasoning: true, input: ['text', 'image'], contextWindow: 200000, maxTokens: 16384 },
  { id: 'gpt-5-mini', name: 'GPT-5 Mini', api: 'openai-completions', provider: 'openai', baseUrl: OPENAI_BASE, reasoning: true, input: ['text', 'image'], contextWindow: 200000, maxTokens: 16384 },
  { id: 'o3', name: 'o3', api: 'openai-completions', provider: 'openai', baseUrl: OPENAI_BASE, reasoning: true, input: ['text', 'image'], contextWindow: 200000, maxTokens: 100000 },
  { id: 'o4-mini', name: 'o4-mini', api: 'openai-completions', provider: 'openai', baseUrl: OPENAI_BASE, reasoning: true, input: ['text', 'image'], contextWindow: 200000, maxTokens: 100000 },

  // ── DeepSeek ────────────────────────────────────────────────────
  // reasoning 模型会把大量 output token 花在 thinking 上，
  // maxTokens 必须开到 65536（官方上限），避免 thinking 吃掉预算后无空间生成 text/tool_call，
  // 导致 stopReason="length" 且实际零产出、用户被迫手动「继续」。
  { id: 'deepseek-chat', name: 'DeepSeek Chat', api: 'openai-completions', provider: 'deepseek', baseUrl: DEEPSEEK_BASE, reasoning: false, input: ['text'], contextWindow: 65536, maxTokens: 32768 },
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', api: 'openai-completions', provider: 'deepseek', baseUrl: DEEPSEEK_BASE, reasoning: true, input: ['text'], contextWindow: 65536, maxTokens: 65536 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', api: 'openai-completions', provider: 'deepseek', baseUrl: DEEPSEEK_BASE, reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 32768 },

  // ── Anthropic ───────────────────────────────────────────────────
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', api: 'anthropic-messages', provider: 'anthropic', baseUrl: ANTHROPIC_BASE, reasoning: true, input: ['text', 'image'], contextWindow: 200000, maxTokens: 16384 },
  { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', api: 'anthropic-messages', provider: 'anthropic', baseUrl: ANTHROPIC_BASE, reasoning: false, input: ['text', 'image'], contextWindow: 200000, maxTokens: 8192 },
  { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', api: 'anthropic-messages', provider: 'anthropic', baseUrl: ANTHROPIC_BASE, reasoning: false, input: ['text', 'image'], contextWindow: 200000, maxTokens: 8192 },

  // ── Groq ────────────────────────────────────────────────────────
  { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', api: 'openai-completions', provider: 'groq', baseUrl: GROQ_BASE, reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 32768 },
  { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant', api: 'openai-completions', provider: 'groq', baseUrl: GROQ_BASE, reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 8192 },

  // ── Google ──────────────────────────────────────────────────────
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', api: 'openai-completions', provider: 'google', baseUrl: GOOGLE_BASE, reasoning: false, input: ['text', 'image'], contextWindow: 1048576, maxTokens: 32768 },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', api: 'openai-completions', provider: 'google', baseUrl: GOOGLE_BASE, reasoning: true, input: ['text', 'image'], contextWindow: 1048576, maxTokens: 65536 },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', api: 'openai-completions', provider: 'google', baseUrl: GOOGLE_BASE, reasoning: true, input: ['text', 'image'], contextWindow: 1048576, maxTokens: 65536 },

  // ── OpenRouter ─────────────────────────────────────────────────
  { id: 'auto', name: 'Auto (OpenRouter)', api: 'openai-completions', provider: 'openrouter', baseUrl: OPENROUTER_BASE, reasoning: false, input: ['text', 'image'], contextWindow: 200000, maxTokens: 8192 },

  // ── Mistral ─────────────────────────────────────────────────────
  { id: 'mistral-large-latest', name: 'Mistral Large', api: 'openai-completions', provider: 'mistral', baseUrl: MISTRAL_BASE, reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 8192 },
  { id: 'mistral-small-latest', name: 'Mistral Small', api: 'openai-completions', provider: 'mistral', baseUrl: MISTRAL_BASE, reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 8192 },

  // ── xAI ────────────────────────────────────────────────────────
  { id: 'grok-3', name: 'Grok 3', api: 'openai-completions', provider: 'xai', baseUrl: XAI_BASE, reasoning: false, input: ['text', 'image'], contextWindow: 131072, maxTokens: 16384 },
  { id: 'grok-3-mini', name: 'Grok 3 Mini', api: 'openai-completions', provider: 'xai', baseUrl: XAI_BASE, reasoning: true, input: ['text', 'image'], contextWindow: 131072, maxTokens: 16384 },

  // ── Cerebras ───────────────────────────────────────────────────
  { id: 'llama3.1-8b', name: 'Llama 3.1 8B (Cerebras)', api: 'openai-completions', provider: 'cerebras', baseUrl: CEREBRAS_BASE, reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 8192 },

  // ── Together AI ────────────────────────────────────────────────
  { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', name: 'Llama 3.3 70B Turbo', api: 'openai-completions', provider: 'together', baseUrl: TOGETHER_BASE, reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 8192 },

  // ── Fireworks ───────────────────────────────────────────────────
  { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', name: 'Llama 3.3 70B (Fireworks)', api: 'openai-completions', provider: 'fireworks', baseUrl: FIREWORKS_BASE, reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 16384 },

  // ── NVIDIA NIM ─────────────────────────────────────────────────
  { id: 'meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B (NVIDIA)', api: 'openai-completions', provider: 'nvidia', baseUrl: NVIDIA_BASE, reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 16384 },

  // ── Moonshot ───────────────────────────────────────────────────
  { id: 'moonshot-v1-128k', name: 'Moonshot v1 128k', api: 'openai-completions', provider: 'moonshot', baseUrl: MOONSHOT_BASE, reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 8192 },
];

// ─── 图像模型目录 ───────────────────────────────────────────────────

export const BUILTIN_IMAGES_MODELS = [
  { id: 'dall-e-3', name: 'DALL-E 3', provider: 'openai', api: 'openai-images', input: ['text'], output: ['image'] },
  { id: 'dall-e-2', name: 'DALL-E 2', provider: 'openai', api: 'openai-images', input: ['text'], output: ['image'] },
  { id: 'google/gemini-2.5-flash-image', name: 'Gemini Flash Image', provider: 'openrouter', api: 'openrouter-images', input: ['text', 'image'], output: ['image', 'text'] },
];

// ─── 提供商元信息 ───────────────────────────────────────────────────

export interface ProviderMeta {
  id: string;
  name: string;
  envVar: string;
  baseUrl: string;
}

export const BUILTIN_PROVIDERS: ProviderMeta[] = [
  { id: 'openai', name: 'OpenAI', envVar: 'OPENAI_API_KEY', baseUrl: OPENAI_BASE },
  { id: 'deepseek', name: 'DeepSeek', envVar: 'DEEPSEEK_API_KEY', baseUrl: DEEPSEEK_BASE },
  { id: 'anthropic', name: 'Anthropic', envVar: 'ANTHROPIC_API_KEY', baseUrl: ANTHROPIC_BASE },
  { id: 'groq', name: 'Groq', envVar: 'GROQ_API_KEY', baseUrl: GROQ_BASE },
  { id: 'google', name: 'Google', envVar: 'GOOGLE_API_KEY', baseUrl: GOOGLE_BASE },
  { id: 'openrouter', name: 'OpenRouter', envVar: 'OPENROUTER_API_KEY', baseUrl: OPENROUTER_BASE },
  { id: 'mistral', name: 'Mistral', envVar: 'MISTRAL_API_KEY', baseUrl: MISTRAL_BASE },
  { id: 'xai', name: 'xAI', envVar: 'XAI_API_KEY', baseUrl: XAI_BASE },
  { id: 'cerebras', name: 'Cerebras', envVar: 'CEREBRAS_API_KEY', baseUrl: CEREBRAS_BASE },
  { id: 'together', name: 'Together AI', envVar: 'TOGETHER_API_KEY', baseUrl: TOGETHER_BASE },
  { id: 'fireworks', name: 'Fireworks', envVar: 'FIREWORKS_API_KEY', baseUrl: FIREWORKS_BASE },
  { id: 'nvidia', name: 'NVIDIA NIM', envVar: 'NVIDIA_API_KEY', baseUrl: NVIDIA_BASE },
  { id: 'moonshot', name: 'Moonshot AI', envVar: 'MOONSHOT_API_KEY', baseUrl: MOONSHOT_BASE },
];

export function getEnvApiKey(providerId: string): string | undefined {
  const provider = BUILTIN_PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return undefined;
  const env = typeof process !== 'undefined' ? process.env : {};
  return env[provider.envVar];
}

export function hasProviderConfigured(providerId: string): boolean {
  return !!getEnvApiKey(providerId);
}
