import { LLMProvider, GenerationSettings } from '../providers/base.js';

export class LLMRuntime {
  readonly provider: LLMProvider;
  readonly model: string;
  readonly generation: GenerationSettings;
  readonly contextWindowTokens: number;
  readonly modelPreset?: string | null;
  readonly snapshotSignature?: unknown[] | null;

  constructor(options: {
    provider: LLMProvider;
    model: string;
    generation: GenerationSettings;
    contextWindowTokens: number;
    modelPreset?: string | null;
    snapshotSignature?: unknown[] | null;
  }) {
    this.provider = options.provider;
    this.model = options.model;
    this.generation = options.generation;
    this.contextWindowTokens = options.contextWindowTokens;
    this.modelPreset = options.modelPreset ?? null;
    this.snapshotSignature = options.snapshotSignature ?? null;
  }

  static capture(
    provider: LLMProvider,
    model: string,
    options: {
      contextWindowTokens: number;
      modelPreset?: string | null;
      snapshotSignature?: unknown[] | null;
    },
  ): LLMRuntime {
    const defaults: GenerationSettings = {};
    const generation = (provider as any).generation || defaults;
    return new LLMRuntime({
      provider,
      model,
      generation: {
        temperature: typeof generation.temperature === 'number' ? generation.temperature : defaults.temperature,
        max_tokens: typeof generation.max_tokens === 'number' ? generation.max_tokens : defaults.max_tokens,
        reasoning_effort: generation.reasoning_effort ?? defaults.reasoning_effort,
      },
      contextWindowTokens: options.contextWindowTokens,
      modelPreset: options.modelPreset,
      snapshotSignature: options.snapshotSignature,
    });
  }

  withGenerationOverrides(options: {
    temperature?: number | null;
    max_tokens?: number | null;
    reasoning_effort?: string | null;
  }): LLMRuntime {
    const generation = this.generation;
    return new LLMRuntime({
      provider: this.provider,
      model: this.model,
      generation: {
        temperature: options.temperature ?? generation.temperature,
        max_tokens: options.max_tokens ?? generation.max_tokens,
        reasoning_effort: options.reasoning_effort ?? generation.reasoning_effort,
      },
      contextWindowTokens: this.contextWindowTokens,
      modelPreset: this.modelPreset,
      snapshotSignature: this.snapshotSignature,
    });
  }
}