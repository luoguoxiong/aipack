/**
 * credentials - 统一的 API 密钥解析与凭证存储
 *
 * 此前 stream-openai / stream-anthropic 各自维护一份 resolveApiKey，
 * 现在统一到此处，并支持注入 CredentialStore（默认 EnvCredentialStore，
 * 可替换为 KMS / Vault 等实现）。
 *
 * 解析优先级（resolveApiKey）：
 *   1. options.apiKey（显式传入）
 *   2. options.credentials（注入的 CredentialStore.read(providerId)）
 *   3. 环境变量（默认实现；<PROVIDER>_API_KEY，openai 额外回退 OPENAI_API_KEY）
 */

import type { Model, SimpleStreamOptions, CredentialStore } from './types';

// ─── 环境变量解析（同步，供默认场景与 EnvCredentialStore 使用）────────

/** 将 provider id 转成环境变量名：deepseek → DEEPSEEK_API_KEY */
export function envKeyName(providerId: string): string {
  return `${providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

/**
 * 从环境变量读取 provider 的 API key。
 * 兼容 openai：仅当 provider 确为 openai 时才回退到 OPENAI_API_KEY，
 * 避免把 OpenAI 密钥作为 Bearer 发往第三方端点（密钥泄露与错误计费）。
 */
export function resolveApiKeyFromEnv(
  providerId: string,
  env?: Record<string, string | undefined>,
): string | undefined {
  if (!env) return undefined;
  const providerKey = envKeyName(providerId);
  if (env[providerKey]) return env[providerKey];
  if (providerId === 'openai' && env['OPENAI_API_KEY']) return env['OPENAI_API_KEY'];
  return undefined;
}

// ─── 统一解析（异步，支持 CredentialStore 注入）──────────────────────

/**
 * 统一 API key 解析。优先级：显式 apiKey > 注入的 CredentialStore > 环境变量。
 * 注入的 store 读取失败时静默降级到环境变量，不阻断流程。
 */
export async function resolveApiKey(
  model: Pick<Model, 'provider'>,
  options: SimpleStreamOptions,
): Promise<string | undefined> {
  if (options.apiKey) return options.apiKey;

  if (options.credentials) {
    try {
      const credential = await options.credentials.read(model.provider);
      if (typeof credential === 'string' && credential) return credential;
    } catch {
      // store 读取失败降级 env
    }
  }

  const env = options.env ?? (typeof process !== 'undefined' ? process.env : undefined);
  return resolveApiKeyFromEnv(model.provider, env);
}

// ─── 默认实现：EnvCredentialStore ────────────────────────────────────

/**
 * 基于环境变量的 CredentialStore 默认实现（只读）。
 * 替换为 KMS / Vault 实现时保持 CredentialStore 接口即可。
 */
export class EnvCredentialStore implements CredentialStore {
  constructor(private readonly env: Record<string, string | undefined> = defaultEnv()) {}

  async read(providerId: string): Promise<string | undefined> {
    return resolveApiKeyFromEnv(providerId, this.env);
  }

  /** 环境变量无法枚举，返回空列表 */
  async list(): Promise<Array<{ providerId: string; type: string }>> {
    return [];
  }

  /** 环境变量只读：应用 fn 但忽略写入结果 */
  async modify(providerId: string, fn: (credential: unknown) => Promise<unknown>): Promise<void> {
    await fn(await this.read(providerId));
  }

  /** 环境变量只读：no-op */
  async delete(providerId: string): Promise<void> {
    void providerId;
  }
}

function defaultEnv(): Record<string, string | undefined> {
  return typeof process !== 'undefined' ? process.env : {};
}

/** 创建默认凭证存储（EnvCredentialStore） */
export function createEnvCredentialStore(
  env?: Record<string, string | undefined>,
): CredentialStore {
  return new EnvCredentialStore(env);
}
