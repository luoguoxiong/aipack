import { LLMProvider, LLMRuntime } from './base.js';
import { OpenAICompatProvider } from './openai_compat_provider.js';
import { ProviderConfig } from '../config/schema.js';
import { logger } from '../utils/logger.js';

export type ProviderFactory = (config: ProviderConfig) => LLMProvider;

const providerRegistry: Map<string, ProviderFactory> = new Map();

export function registerProvider(name: string, factory: ProviderFactory): void {
  providerRegistry.set(name, factory);
}

export function createProvider(config: ProviderConfig): LLMProvider | null {
  const factory = providerRegistry.get(config.name);
  if (factory) {
    return factory(config);
  }
  // Fall back to openai_compat for any unknown provider with a base_url
  // (matches Python project behavior: custom provider names become OpenAI-compatible)
  if (config.base_url) {
    return new OpenAICompatProvider({
      name: config.name,
      api_key: config.api_key ?? undefined,
      base_url: config.base_url,
      extra_headers: config.extra_headers,
      extra_query: config.extra_query,
      extra_body: config.extra_body,
    });
  }
  return null;
}

registerProvider('openai', (config) => {
  return new OpenAICompatProvider({
    name: config.name,
    api_key: config.api_key ?? undefined,
    base_url: config.base_url || 'https://api.openai.com/v1',
    extra_headers: config.extra_headers,
    extra_query: config.extra_query,
    extra_body: config.extra_body,
  });
});

registerProvider('openai_compat', (config) => {
  if (!config.base_url) {
    throw new Error(`openai_compat provider "${config.name}" requires base_url`);
  }
  return new OpenAICompatProvider({
    name: config.name,
    api_key: config.api_key ?? undefined,
    base_url: config.base_url,
    extra_headers: config.extra_headers,
    extra_query: config.extra_query,
    extra_body: config.extra_body,
  });
});

registerProvider('anthropic', (config) => {
  return new OpenAICompatProvider({
    name: config.name,
    api_key: config.api_key ?? undefined,
    base_url: config.base_url || 'https://api.anthropic.com/v1',
    extra_headers: {
      'anthropic-version': '2023-06-01',
      ...config.extra_headers,
    },
    extra_query: config.extra_query,
    extra_body: config.extra_body,
  });
});

export function detectProvider(model: string): string {
  if (model.startsWith('anthropic/') || model.startsWith('claude-')) {
    return 'anthropic';
  }
  if (model.startsWith('openai/') || model.startsWith('gpt-')) {
    return 'openai';
  }
  return 'openai_compat';
}

export class ProviderFactoryService {
  private providers: Map<string, LLMProvider> = new Map();
  private providerConfigs: ProviderConfig[] = [];

  constructor(configs: ProviderConfig[]) {
    this.providerConfigs = configs;
    for (const config of configs) {
      const provider = createProvider(config);
      if (provider) {
        this.providers.set(config.name, provider);
      } else {
        logger.warn({ provider: config.name }, 'Unknown provider type, skipping');
      }
    }
  }

  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  resolveProvider(runtime: LLMRuntime): LLMProvider {
    const { provider, model } = runtime;

    // 1. Explicit provider name (not "auto")
    if (provider !== 'auto' && this.providers.has(provider)) {
      return this.providers.get(provider)!;
    }

    // 2. Model name prefix (e.g. "deepseek/deepseek-chat" -> "deepseek")
    if (model.includes('/')) {
      const prefix = model.split('/')[0];
      if (this.providers.has(prefix)) {
        return this.providers.get(prefix)!;
      }
    }

    // 3. Match by default_model
    for (const config of this.providerConfigs) {
      if (config.default_model === model) {
        const p = this.providers.get(config.name);
        if (p) return p;
      }
    }

    // 4. Detect by model name pattern
    const detectedProvider = detectProvider(model);
    if (this.providers.has(detectedProvider)) {
      return this.providers.get(detectedProvider)!;
    }

    // 5. Fall back to any available provider
    for (const [, p] of this.providers) {
      return p;
    }

    throw new Error(`No provider found for model: ${model}`);
  }

  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }
}
