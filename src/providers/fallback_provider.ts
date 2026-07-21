import {
  LLMProvider,
  LLMResponse,
  LLMRuntime,
  ProviderMessage,
  ProviderToolDefinition,
  StreamCallback,
  StreamResult,
} from './base.js';
import { logger } from '../utils/logger.js';

export interface FallbackProviderConfig {
  name: string;
  providers: LLMProvider[];
  max_retries?: number;
}

export class FallbackProvider extends LLMProvider {
  name = 'fallback';
  private providers: LLMProvider[];
  private maxRetries: number;

  constructor(config: FallbackProviderConfig) {
    super();
    this.name = config.name || 'fallback';
    this.providers = config.providers;
    this.maxRetries = config.max_retries ?? 2;
    if (this.providers.length === 0) {
      throw new Error('FallbackProvider requires at least one provider');
    }
  }

  private isRetryable(error: Error): boolean {
    const msg = (error.message || '').toLowerCase();
    const code = (error as unknown as Record<string, unknown>).code as string | undefined;
    return (
      msg.includes('429') ||
      msg.includes('rate limit') ||
      msg.includes('timeout') ||
      msg.includes('connection') ||
      msg.includes('server error') ||
      msg.includes('500') ||
      msg.includes('502') ||
      msg.includes('503') ||
      msg.includes('504') ||
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT'
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async withFallback<T>(fn: (provider: LLMProvider) => Promise<T>, context: string): Promise<T> {
    let lastError: Error | null = null;

    for (let providerIdx = 0; providerIdx < this.providers.length; providerIdx++) {
      const provider = this.providers[providerIdx];
      const isLast = providerIdx === this.providers.length - 1;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        try {
          if (attempt > 0 || providerIdx > 0) {
            logger.warn(
              {
                provider: provider.name,
                attempt: attempt + 1,
                context,
              },
              'Retrying with fallback provider',
            );
          }
          return await fn(provider);
        } catch (err) {
          const error = err as Error;
          lastError = error;

          if (!this.isRetryable(error) && attempt === 0) {
            break;
          }

          if (attempt < this.maxRetries) {
            const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
            logger.warn(
              {
                provider: provider.name,
                attempt: attempt + 1,
                error: error.message,
                delay_ms: delay,
                context,
              },
              'Request failed, retrying...',
            );
            await this.sleep(delay);
          }
        }
      }
    }

    if (lastError) {
      logger.error({ err: lastError, context }, 'All providers failed');
      throw lastError;
    }
    throw new Error('All providers failed');
  }

  async complete(
    messages: ProviderMessage[],
    tools: ProviderToolDefinition[],
    runtime: LLMRuntime,
    options?: {
      temperature?: number;
      max_tokens?: number;
      reasoning_effort?: string | null;
    },
  ): Promise<LLMResponse> {
    return this.withFallback(
      provider => provider.complete(messages, tools, runtime, options),
      'complete',
    );
  }

  async stream(
    messages: ProviderMessage[],
    tools: ProviderToolDefinition[],
    runtime: LLMRuntime,
    onDelta: StreamCallback,
    options?: {
      temperature?: number;
      max_tokens?: number;
      reasoning_effort?: string | null;
    },
  ): Promise<StreamResult> {
    return this.withFallback(
      provider => provider.stream(messages, tools, runtime, onDelta, options),
      'stream',
    );
  }
}
