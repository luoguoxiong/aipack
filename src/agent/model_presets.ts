import { ModelPresetConfig } from '../config/schema.js';
import { LLMProvider, LLMRuntime } from '../providers/base.js';
import { logger } from '../utils/logger.js';

export type PresetSnapshotLoader = (name: string) => ProviderSnapshot;

export interface ProviderSnapshot {
  provider: LLMProvider;
  model: string;
  context_window_tokens: number;
  signature: unknown[];
  generation: GenerationSettings;
}

export interface GenerationSettings {
  max_tokens?: number;
  temperature?: number;
  reasoning_effort?: string | null;
}

export function defaultSelectionSignature(
  signature: unknown[] | null | undefined,
): unknown[] | null {
  if (!signature) return null;
  return signature.slice(0, 2);
}

export function configuredModelPresets(
  modelPresets: Record<string, ModelPresetConfig>,
  defaultPreset?: ModelPresetConfig,
): Record<string, ModelPresetConfig> {
  const result: Record<string, ModelPresetConfig> = { ...modelPresets };
  if (defaultPreset) {
    result['default'] = defaultPreset;
  }
  return result;
}

export function makePresetSnapshotLoader(
  config: unknown,
  providerSnapshotLoader: ((...args: unknown[]) => ProviderSnapshot) | null,
): PresetSnapshotLoader {
  if (providerSnapshotLoader !== null) {
    return (name: string) => providerSnapshotLoader({ preset_name: name });
  }
  return (name: string) => {
    logger.warn({ preset: name }, 'No provider snapshot loader available, using stub');
    throw new Error(`No provider snapshot loader configured for preset ${name}`);
  };
}

export function buildStaticPresetSnapshot(
  provider: LLMProvider,
  name: string,
  preset: ModelPresetConfig,
): ProviderSnapshot {
  return {
    provider,
    model: preset.model,
    context_window_tokens: preset.context_window_tokens,
    signature: ['model_preset', name, JSON.stringify(preset)],
    generation: {
      max_tokens: preset.max_tokens,
      temperature: preset.temperature,
      reasoning_effort: preset.reasoning_effort ?? null,
    },
  };
}

export function buildRuntimePresetSnapshot(
  name: string,
  presets: Record<string, ModelPresetConfig>,
  provider: LLMProvider,
  loader: PresetSnapshotLoader | null,
): ProviderSnapshot {
  if (loader !== null) {
    return loader(name);
  }
  return buildStaticPresetSnapshot(provider, name, presets[name]);
}

export function normalizePresetName(
  name: string | null | undefined,
  presets: Record<string, ModelPresetConfig>,
): string {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('model_preset must be a non-empty string');
  }
  const trimmed = name.trim();
  if (!(trimmed in presets)) {
    const available = Object.keys(presets).join(', ') || '(none)';
    throw new Error(`model_preset "${trimmed}" not found. Available: ${available}`);
  }
  return trimmed;
}

export function presetToGenerationSettings(preset: ModelPresetConfig): GenerationSettings {
  return {
    max_tokens: preset.max_tokens,
    temperature: preset.temperature,
    reasoning_effort: preset.reasoning_effort ?? null,
  };
}
