/**
 * packages/eval/src/core/embedding.ts - OpenAI 兼容 embedding 客户端（M5）
 *
 * semantic 评分器的真实装配：POST {baseUrl}/embeddings（OpenAI 兼容协议，
 * DeepSeek / OpenAI / Moonshot / 各兼容网关通用）。
 *
 * env 优先级低于显式参数（与 live.ts 的 spec 解析对称）：
 *   AIPACK_EVAL_EMBEDDING_MODEL / AIPACK_EVAL_EMBEDDING_API_KEY /
 *   AIPACK_EVAL_EMBEDDING_BASE_URL
 */

import type { EmbedFn } from './scorer';

export interface EmbeddingConfig {
  /** embedding 模型 id（如 text-embedding-3-small） */
  model?: string;
  apiKey?: string;
  /** 缺省 https://api.openai.com/v1 */
  baseUrl?: string;
  /** 单请求超时 ms（缺省 30000） */
  timeoutMs?: number;
}

export const EMBEDDING_ENV_KEYS = {
  model: 'AIPACK_EVAL_EMBEDDING_MODEL',
  apiKey: 'AIPACK_EVAL_EMBEDDING_API_KEY',
  baseUrl: 'AIPACK_EVAL_EMBEDDING_BASE_URL',
} as const;

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 30_000;

/** 合并显式参数与环境变量，缺 model 抛可操作错误 */
export function resolveEmbeddingConfig(opts: EmbeddingConfig = {}): EmbeddingConfig & {
  model: string;
  apiKey: string;
  baseUrl: string;
} {
  const env = process.env;
  const model = opts.model ?? env[EMBEDDING_ENV_KEYS.model];
  if (!model) {
    throw new Error(
      `semantic 评分器需要 embedding 模型：--embed-model <id> 或 ${EMBEDDING_ENV_KEYS.model}`,
    );
  }
  const apiKey = opts.apiKey ?? env[EMBEDDING_ENV_KEYS.apiKey] ?? env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      `embedding 缺少 API Key：--embed-api-key <key>、${EMBEDDING_ENV_KEYS.apiKey} 或 OPENAI_API_KEY`,
    );
  }
  const baseUrl = (opts.baseUrl ?? env[EMBEDDING_ENV_KEYS.baseUrl] ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  return {
    model,
    apiKey,
    baseUrl,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/** 装配 OpenAI 兼容 embedding 函数 */
export function createOpenAiCompatibleEmbedFn(opts: EmbeddingConfig = {}): EmbedFn {
  const cfg = resolveEmbeddingConfig(opts);
  return async (text: string): Promise<number[]> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(`${cfg.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({ model: cfg.model, input: text }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`embedding HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
      const vec = json.data?.[0]?.embedding;
      if (!Array.isArray(vec)) throw new Error('embedding 响应缺少 data[0].embedding');
      return vec;
    } finally {
      clearTimeout(timer);
    }
  };
}
