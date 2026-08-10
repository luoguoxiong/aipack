import type {
  Model,
  Context,
  SimpleStreamOptions,
  StreamOptions,
  StreamResult,
  StreamEvent,
  AssistantMessage,
  Provider,
  ResolvedAuth,
  Api,
  ModelsOptions,
  CredentialStore,
} from './types';
import { hasApi } from './types';
import { streamOpenAI } from './stream-openai';
import { streamAnthropic } from './stream-anthropic';
import { BUILTIN_MODELS, BUILTIN_PROVIDERS, getEnvApiKey } from './catalog';
import { createEnvCredentialStore, resolveApiKeyFromEnv, envKeyName } from './credentials';

// ─── 内置提供者工厂 ────────────────────────────────────

function createBuiltinProvider(
  meta: typeof BUILTIN_PROVIDERS[number],
  models: Model[],
): Provider {
  return {
    id: meta.id,
    name: meta.name,
    models,
    auth: {
      apiKey: {
        name: `${meta.name} API Key`,
        resolve: async () => {
          const key = getEnvApiKey(meta.id);
          if (key) {
            return { auth: { apiKey: key, source: meta.envVar } };
          }
          return { auth: {} };
        },
      },
    },
  };
}

// ─── Models 类 ─────────────────────────────────────────────────

export class Models {
  private providers = new Map<string, Provider>();
  private credentials: CredentialStore;

  constructor(options: ModelsOptions = {}) {
    // 默认 EnvCredentialStore（约定名 <PROVIDER>_API_KEY），可注入 KMS / Vault 实现
    this.credentials = options.credentials ?? createEnvCredentialStore();
  }

  // ── 提供者管理 ──

  setProvider(provider: Provider): void {
    this.providers.set(provider.id, provider);
  }

  getProvider(id: string): Provider | undefined {
    return this.providers.get(id);
  }

  getProviders(): Provider[] {
    return Array.from(this.providers.values());
  }

  // ── 模型查询 ──

  getModels(providerId?: string): Model[] {
    if (providerId) {
      return this.getProvider(providerId)?.models ?? [];
    }
    return this.getProviders().flatMap((p) => p.models);
  }

  getModel(providerIdOrModel: string, modelId?: string): Model | undefined {
    // 支持 getModel(id, provider) 和 getModel(provider, modelId) 两种调用方式
    if (modelId) {
      const provider = this.getProvider(providerIdOrModel);
      return provider?.models.find((m) => m.id === modelId);
    }
    // 在所有提供者中搜索此 ID 的模型
    for (const provider of this.getProviders()) {
      const model = provider.models.find((m) => m.id === providerIdOrModel);
      if (model) return model;
    }
    return undefined;
  }

  // ── 认证解析 ──

  /**
   * 解析 provider 的认证信息。优先级与 resolveApiKey 一致：
   * 注入的 CredentialStore → 环境变量（约定名 <PROVIDER>_API_KEY）→ 自定义 auth 解析器。
   */
  async getAuth(providerOrModel: string | Model): Promise<ResolvedAuth | undefined> {
    const providerId = typeof providerOrModel === 'string' ? providerOrModel : providerOrModel.provider;
    const provider = this.getProvider(providerId);

    // 1. 注入的 CredentialStore（读取失败降级）
    try {
      const credential = await this.credentials.read(providerId);
      if (typeof credential === 'string' && credential) {
        return { apiKey: credential, source: 'credential-store' };
      }
    } catch {
      // 降级到环境变量
    }

    // 2. 环境变量（约定名，与 resolveApiKeyFromEnv 一致）
    const env = typeof process !== 'undefined' ? process.env : undefined;
    const envKey = resolveApiKeyFromEnv(providerId, env);
    if (envKey) return { apiKey: envKey, source: envKeyName(providerId) };

    // 3. 自定义 provider 的 auth 解析器（headers / baseUrl 等扩展认证）
    if (provider?.auth?.apiKey) {
      const result = await provider.auth.apiKey.resolve();
      if (result.auth.apiKey || result.auth.headers || result.auth.baseUrl) {
        return {
          apiKey: result.auth.apiKey,
          headers: result.auth.headers,
          baseUrl: result.auth.baseUrl,
          source: result.auth.source ?? providerId,
        };
      }
    }

    return undefined;
  }

  // ── 流式 / 完整响应 ──

  stream(model: Model, context: Context, options: StreamOptions = {}): StreamResult {
    return this.dispatchStream(model, context, options);
  }

  complete(model: Model, context: Context, options: StreamOptions = {}): Promise<AssistantMessage> {
    return this.dispatchStream(model, context, options).result();
  }

  streamSimple(model: Model, context: Context, options: SimpleStreamOptions = {}): StreamResult {
    return this.dispatchStream(model, context, options);
  }

  completeSimple(model: Model, context: Context, options: SimpleStreamOptions = {}): Promise<AssistantMessage> {
    return this.dispatchStream(model, context, options).result();
  }

  private dispatchStream(
    model: Model,
    context: Context,
    options: SimpleStreamOptions | StreamOptions,
  ): StreamResult {
    // 透传选项；未显式注入 credentials 时使用本实例的 CredentialStore
    const mergedOptions: SimpleStreamOptions = { ...options };
    if (!mergedOptions.credentials) {
      mergedOptions.credentials = this.credentials;
    }

    // 根据 model.api 确定流式实现的类型
    if (hasApi(model, 'anthropic-messages')) {
      // 对于 Anthropic，异步解析密钥，由流函数自行处理
      return streamAnthropic(model, context, mergedOptions);
    }

    // 默认：兼容 OpenAI
    return streamOpenAI(model, context, mergedOptions);
  }

  // ── 刷新（静态提供者无操作） ──

  async refresh(_providerId?: string): Promise<{ aborted: boolean; errors: Map<string, Error> }> {
    return { aborted: false, errors: new Map() };
  }
}

// ─── 工厂函数 ──────────────────────────────────────────────────────

export function createModels(options: ModelsOptions = {}): Models {
  return new Models(options);
}
