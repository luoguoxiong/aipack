import { LLMProvider } from './base.js';
import { registerProvider, createProvider } from './factory.js';
import { logger } from '../utils/logger.js';
import { AnthropicProvider, AnthropicProviderConfig } from './anthropic_provider.js';
import { AzureOpenAIProvider, AzureOpenAIProviderConfig } from './azure_openai_provider.js';
import { BedrockProvider, BedrockProviderConfig } from './bedrock_provider.js';
import { FallbackProvider, FallbackProviderConfig } from './fallback_provider.js';
import { GitHubCopilotProvider, GitHubCopilotProviderConfig } from './github_copilot_provider.js';
import { OpenAICodexProvider, OpenAICodexProviderConfig } from './openai_codex_provider.js';
import { OpenAICompatProvider, OpenAICompatProviderConfig } from './openai_compat_provider.js';
import { ImageGenerationProvider } from './image_generation.js';
import { TranscriptionProvider } from './transcription.js';
import type { ProviderConfig } from '../config/schema.js';

export interface ProviderRegistryEntry {
  name: string;
  factory: (config: Record<string, unknown>) => LLMProvider;
  detect?: (config: Record<string, unknown>) => boolean;
}

const providerRegistry: ProviderRegistryEntry[] = [];

export function registerProviderEntry(entry: ProviderRegistryEntry): void {
  providerRegistry.push(entry);
  registerProvider(entry.name, entry.factory as (config: ProviderConfig) => LLMProvider);
}

export function getProviderRegistry(): ProviderRegistryEntry[] {
  return [...providerRegistry];
}

export function loadBuiltinProviders(): void {
  registerProviderEntry({
    name: 'anthropic',
    factory: (config) => new AnthropicProvider(config as unknown as AnthropicProviderConfig),
    detect: (config) => {
      const baseUrl = (config.base_url as string | undefined) || '';
      const defaultModel = (config.default_model as string | undefined) || '';
      return (
        config.name === 'anthropic' ||
        baseUrl.includes('anthropic.com') ||
        defaultModel.startsWith('anthropic/') ||
        defaultModel.startsWith('claude-')
      );
    },
  });

  registerProviderEntry({
    name: 'azure_openai',
    factory: (config) => new AzureOpenAIProvider(config as unknown as AzureOpenAIProviderConfig),
    detect: (config) => {
      const baseUrl = (config.base_url as string | undefined) || '';
      return (
        config.name === 'azure_openai' ||
        baseUrl.includes('openai.azure.com') ||
        baseUrl.includes('azure.com')
      );
    },
  });

  registerProviderEntry({
    name: 'bedrock',
    factory: (config) => new BedrockProvider(config as unknown as BedrockProviderConfig),
    detect: (config) => {
      const baseUrl = (config.base_url as string | undefined) || '';
      const defaultModel = (config.default_model as string | undefined) || '';
      return (
        config.name === 'bedrock' ||
        baseUrl.includes('bedrock') ||
        baseUrl.includes('amazonaws.com') ||
        defaultModel.startsWith('bedrock/') ||
        defaultModel.includes('amazon.') ||
        defaultModel.includes('anthropic.claude')
      );
    },
  });

  registerProviderEntry({
    name: 'github_copilot',
    factory: (config) => new GitHubCopilotProvider(config as unknown as GitHubCopilotProviderConfig),
    detect: (config) => {
      const baseUrl = (config.base_url as string | undefined) || '';
      return (
        config.name === 'github_copilot' ||
        baseUrl.includes('githubcopilot.com') ||
        baseUrl.includes('copilot')
      );
    },
  });

  registerProviderEntry({
    name: 'openai_codex',
    factory: (config) => new OpenAICodexProvider(config as unknown as OpenAICodexProviderConfig),
    detect: (config) => {
      if (config.name === 'openai_codex' || config.name === 'codex') {
        return true;
      }
      return false;
    },
  });

  registerProviderEntry({
    name: 'openai_compat',
    factory: (config) => new OpenAICompatProvider(config as unknown as OpenAICompatProviderConfig),
    detect: () => true,
  });
}

export function createProviderFromConfig(config: Record<string, unknown>): LLMProvider | null {
  const name = config.name as string | undefined;
  if (name) {
    const factory = providerRegistry.find(p => p.name === name);
    if (factory) {
      return factory.factory(config);
    }
  }

  for (const entry of providerRegistry) {
    if (entry.detect && entry.detect(config)) {
      logger.debug({ provider: entry.name }, 'Detected provider type from config');
      return entry.factory(config);
    }
  }

  return createProvider(config as ProviderConfig);
}

let initialized = false;

export function ensureProvidersLoaded(): void {
  if (initialized) return;
  loadBuiltinProviders();
  initialized = true;
}

export { ImageGenerationProvider, TranscriptionProvider };
