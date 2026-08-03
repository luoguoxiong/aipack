/**
 * Provider 兼容性检测
 *
 * 根据 provider ID、baseUrl 和 model ID 自动检测 provider 的兼容性配置，
 * 涵盖 thinking 格式、工具调用、缓存控制、消息格式等差异。
 */

import type { Model } from './types';

// ─── 兼容性标志 ────────────────────────────────────────────────────

export interface ProviderCompat {
  // ── 消息格式 ──
  /** 是否需要 tool result 中的 name 字段（如 DeepSeek） */
  requiresToolResultName: boolean;
  /** 是否需要在 tool result 之后插入空的 assistant 消息桥接 */
  requiresAssistantAfterToolResult: boolean;

  // ── 参数字段 ──
  /** 使用 max_completion_tokens 代替 max_tokens（如 o1 系列） */
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  /** 支持 developer role (o1 系列) */
  supportsDeveloperRole: boolean;
  /** 支持 reasoning_effort（OpenAI o1/o3） */
  supportsReasoningEffort: boolean;

  // ── 流式数据 ──
  /** 流式数据中是否包含 usage（如 DeepSeek stream 不含 usage） */
  supportsUsageInStreaming: boolean;

  // ── Thinking/Reasoning 格式 ──
  thinkingFormat: ThinkingFormat;

  // ── 工具调用 ──
  /** 工具定义中自动添加 strict: false */
  supportsStrictMode: boolean;

  // ── 缓存 ──
  cacheControlFormat: CacheControlFormat;

  // ── 会话亲和性 ──
  sendSessionAffinityHeaders: boolean;

  // ── 其他 ──
  /** 在 onPayload 中传入 transport 类型 */
  transport?: string;
}

export type ThinkingFormat =
  | 'openai'          // reasoning_effort（默认）
  | 'deepseek'        // thinking: { type: "enabled" } + reasoning_effort
  | 'zai'             // thinking: { type: "enabled", clear_thinking: false }
  | 'qwen'            // enable_thinking: true
  | 'qwen-chat-template' // chat_template_kwargs: { enable_thinking: true }
  | 'openrouter'      // reasoning: { effort: "high" }
  | 'ant-ling'        // reasoning: { effort: "high" }
  | 'together'        // reasoning: { enabled: true }
  | 'chat-template'   // chat_template_kwargs
  | 'none';           // 不支持

export type CacheControlFormat =
  | 'anthropic'       // cache_control: { type: "ephemeral" } 在 content block 上
  | 'openai'          // prompt_cache_key / prompt_cache_retention
  | 'none';

// ─── 默认值 ────────────────────────────────────────────────────────

const DEFAULT_COMPAT: ProviderCompat = {
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  maxTokensField: 'max_tokens',
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: true,
  thinkingFormat: 'none',
  supportsStrictMode: true,
  cacheControlFormat: 'none',
  sendSessionAffinityHeaders: false,
};

// ─── Provider 模式定义 ────────────────────────────────────────────

interface ProviderPattern {
  /** 匹配 provider ID（不区分大小写） */
  providerMatch?: RegExp;
  /** 匹配 baseUrl（不区分大小写） */
  urlMatch?: RegExp;
  /** 匹配 model ID（不区分大小写） */
  modelMatch?: RegExp;
  /** 对应的兼容性覆盖 */
  compat: Partial<ProviderCompat>;
}

const PROVIDER_PATTERNS: ProviderPattern[] = [
  // ── DeepSeek ──
  {
    providerMatch: /^deepseek$/i,
    compat: {
      requiresToolResultName: true,
      supportsUsageInStreaming: false,
      thinkingFormat: 'deepseek',
    },
  },

  // ── OpenAI ──
  {
    providerMatch: /^openai$/i,
    modelMatch: /^o1-/i,
    compat: {
      maxTokensField: 'max_completion_tokens',
      supportsDeveloperRole: true,
      supportsReasoningEffort: true,
      thinkingFormat: 'openai',
      cacheControlFormat: 'openai',
    },
  },
  {
    providerMatch: /^openai$/i,
    modelMatch: /^o3-/i,
    compat: {
      maxTokensField: 'max_completion_tokens',
      supportsDeveloperRole: true,
      supportsReasoningEffort: true,
      thinkingFormat: 'openai',
      cacheControlFormat: 'openai',
    },
  },
  {
    providerMatch: /^openai$/i,
    modelMatch: /^gpt-/i,
    compat: {
      cacheControlFormat: 'openai',
    },
  },

  // ── Anthropic ──
  {
    providerMatch: /^anthropic$/i,
    compat: {
      thinkingFormat: 'none', // Anthropic uses 'thinking' field, not through compat
      cacheControlFormat: 'anthropic',
    },
  },

  // ── Google / Gemini ──
  {
    providerMatch: /^(google|gemini)/i,
    compat: {
      requiresToolResultName: true,
      requiresAssistantAfterToolResult: true,
      supportsUsageInStreaming: false,
    },
  },

  // ── Mistral ──
  {
    providerMatch: /^mistral/i,
    compat: {
      supportsUsageInStreaming: false,
    },
  },

  // ── Groq ──
  {
    providerMatch: /^groq$/i,
    compat: {
      supportsUsageInStreaming: false,
    },
  },

  // ── Together ──
  {
    providerMatch: /^together/i,
    compat: {
      thinkingFormat: 'together',
    },
  },

  // ── OpenRouter ──
  {
    providerMatch: /^openrouter/i,
    compat: {
      thinkingFormat: 'openrouter',
      sendSessionAffinityHeaders: true,
    },
  },

  // ── ZAI ──
  {
    providerMatch: /^zai/i,
    compat: {
      thinkingFormat: 'zai',
    },
  },

  // ── Qwen (通义千问) ──
  {
    providerMatch: /^qwen/i,
    compat: {
      thinkingFormat: 'qwen',
    },
  },

  // ── Kimi / Moonshot ──
  {
    providerMatch: /^(kimi|moonshot)/i,
    compat: {
      requiresToolResultName: true,
      requiresAssistantAfterToolResult: false,
    },
  },

  // ── Ant Ling (蚂蚁灵积) ──
  {
    providerMatch: /^ant-ling/i,
    compat: {
      thinkingFormat: 'ant-ling',
    },
  },

  // ── GitHub Copilot ──
  {
    providerMatch: /^github-copilot/i,
    compat: {
      sendSessionAffinityHeaders: true,
    },
  },

  // ── Fireworks ──
  {
    providerMatch: /^fireworks/i,
    compat: {
      supportsUsageInStreaming: false,
    },
  },

  // ── 通用 URL 匹配：识别 OpenAI 兼容代理 ──
  {
    urlMatch: /deepseek/i,
    compat: {
      requiresToolResultName: true,
      supportsUsageInStreaming: false,
      thinkingFormat: 'deepseek',
    },
  },
  {
    urlMatch: /openrouter/i,
    compat: {
      thinkingFormat: 'openrouter',
      sendSessionAffinityHeaders: true,
    },
  },
  {
    urlMatch: /together/i,
    compat: {
      thinkingFormat: 'together',
    },
  },
  {
    urlMatch: /qwen|tongyi/i,
    compat: {
      thinkingFormat: 'qwen',
    },
  },
  {
    urlMatch: /moonshot|kimi/i,
    compat: {
      requiresToolResultName: true,
      requiresAssistantAfterToolResult: false,
    },
  },
  {
    urlMatch: /zai\.run/i,
    compat: {
      thinkingFormat: 'zai',
    },
  },
  {
    urlMatch: /groq/i,
    compat: {
      supportsUsageInStreaming: false,
    },
  },
  {
    urlMatch: /mistral/i,
    compat: {
      supportsUsageInStreaming: false,
    },
  },
  {
    urlMatch: /fireworks/i,
    compat: {
      supportsUsageInStreaming: false,
    },
  },
];

// ─── 检测函数 ──────────────────────────────────────────────────────

/**
 * 检测 provider 的兼容性配置
 *
 * 先匹配 provider ID，再回退匹配 baseUrl，最后匹配 model ID。
 */
export function detectCompat(model: Pick<Model, 'provider' | 'baseUrl' | 'id'>): ProviderCompat {
  const compat: ProviderCompat = { ...DEFAULT_COMPAT };

  for (const pattern of PROVIDER_PATTERNS) {
    let matched = false;

    if (pattern.providerMatch) {
      matched = pattern.providerMatch.test(model.provider);
    }

    if (!matched && pattern.urlMatch && model.baseUrl) {
      matched = pattern.urlMatch.test(model.baseUrl);
    }

    if (!matched && pattern.modelMatch && model.id) {
      matched = pattern.modelMatch.test(model.id);
    }

    if (matched) {
      Object.assign(compat, pattern.compat);
    }
  }

  return compat;
}

// ─── 更新 Model.compat 的便捷函数 ─────────────────────────────────

/**
 * 将检测结果写入 model.compat，用于传递到 stream 函数
 */
export function applyCompatToModel(model: Model): ProviderCompat {
  const compat = detectCompat(model);
  model.compat = model.compat ?? {};
  Object.assign(model.compat, compat);
  return compat;
}
