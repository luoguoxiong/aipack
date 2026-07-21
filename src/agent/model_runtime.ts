import { ModelPresetConfig } from '../config/schema.js';
import { LLMRuntime, LLMProvider } from '../providers/base.js';
import {
  ProviderSnapshot,
  PresetSnapshotLoader,
  defaultSelectionSignature,
  normalizePresetName,
  buildRuntimePresetSnapshot,
} from './model_presets.js';
import { logger } from '../utils/logger.js';

export type ProviderSnapshotLoader = () => ProviderSnapshot;

function runtimeFromProviderSnapshot(
  snapshot: ProviderSnapshot,
  modelPreset: string | null = null,
): LLMRuntime {
  return {
    model: snapshot.model,
    provider: snapshot.provider.name,
    max_tokens: snapshot.generation.max_tokens ?? 8192,
    context_window_tokens: snapshot.context_window_tokens,
    temperature: snapshot.generation.temperature ?? 0.1,
    reasoning_effort: snapshot.generation.reasoning_effort ?? null,
    model_preset: modelPreset,
  };
}

export class ModelRuntimeResolver {
  private _runtime: LLMRuntime;
  private _modelPresets: Record<string, ModelPresetConfig>;
  private _providerSnapshotLoader: ProviderSnapshotLoader | null;
  private _presetSnapshotLoader: PresetSnapshotLoader | null;
  private _tracksProviderGeneration: boolean;
  private _defaultSelectionSignature: unknown[] | null;

  constructor(
    initialRuntime: LLMRuntime,
    options?: {
      modelPresets?: Record<string, ModelPresetConfig>;
      providerSnapshotLoader?: ProviderSnapshotLoader | null;
      presetSnapshotLoader?: PresetSnapshotLoader | null;
    },
  ) {
    this._runtime = initialRuntime;
    this._modelPresets = { ...(options?.modelPresets || {}) };
    this._providerSnapshotLoader = options?.providerSnapshotLoader ?? null;
    this._presetSnapshotLoader = options?.presetSnapshotLoader ?? null;
    this._tracksProviderGeneration = initialRuntime.model_preset == null;
    this._defaultSelectionSignature = defaultSelectionSignature(
      (initialRuntime as unknown as { snapshot_signature?: unknown[] }).snapshot_signature ?? null,
    );
  }

  get runtime(): LLMRuntime {
    return this._runtime;
  }

  get modelPresets(): Record<string, ModelPresetConfig> {
    return { ...this._modelPresets };
  }

  get modelPreset(): string | null {
    return this._runtime.model_preset ?? null;
  }

  get providerSignature(): unknown[] | null {
    return (this._runtime as unknown as { snapshot_signature?: unknown[] }).snapshot_signature ?? null;
  }

  current(refresh = false): LLMRuntime {
    if (refresh) {
      this.refresh();
      this._refreshProviderGeneration();
    }
    return this._runtime;
  }

  resolveSnapshot(
    snapshot: ProviderSnapshot,
    modelPreset: string | null = null,
  ): LLMRuntime {
    return runtimeFromProviderSnapshot(snapshot, modelPreset);
  }

  adoptSnapshot(
    snapshot: ProviderSnapshot,
    modelPreset: string | null = null,
  ): LLMRuntime {
    const runtime = this.resolveSnapshot(snapshot, modelPreset);
    this._runtime = runtime;
    this._tracksProviderGeneration = modelPreset == null;
    this._defaultSelectionSignature = defaultSelectionSignature(
      (runtime as unknown as { snapshot_signature?: unknown[] }).snapshot_signature ?? null,
    );
    return runtime;
  }

  resolvePreset(name: string | null | undefined): LLMRuntime {
    const normalized = normalizePresetName(name, this._modelPresets);
    const snapshot = buildRuntimePresetSnapshot(
      normalized,
      this._modelPresets,
      this._runtime as unknown as LLMProvider,
      this._presetSnapshotLoader,
    );
    return this.resolveSnapshot(snapshot, normalized);
  }

  selectPreset(name: string | null | undefined): LLMRuntime {
    const runtime = this.resolvePreset(name);
    this._runtime = runtime;
    this._tracksProviderGeneration = false;
    return runtime;
  }

  selectModel(model: string): LLMRuntime {
    if (typeof model !== 'string' || !model.trim()) {
      throw new Error('model must be a non-empty string');
    }
    this._runtime = {
      ...this._runtime,
      model: model.trim(),
      model_preset: null,
    };
    return this._runtime;
  }

  selectContextWindow(contextWindowTokens: number): LLMRuntime {
    if (typeof contextWindowTokens !== 'number' || !Number.isInteger(contextWindowTokens)) {
      throw new TypeError('context_window_tokens must be an integer');
    }
    this._runtime = {
      ...this._runtime,
      context_window_tokens: contextWindowTokens,
    };
    return this._runtime;
  }

  private _refreshProviderGeneration(): LLMRuntime | null {
    if (!this._tracksProviderGeneration) {
      return null;
    }
    const runtime = this._runtime;
    const capturedGen = (runtime as unknown as { generation?: number }).generation;
    if (capturedGen === (runtime as unknown as { generation?: number }).generation) {
      return null;
    }
    this._runtime = { ...runtime };
    return this._runtime;
  }

  refresh(): LLMRuntime | null {
    if (this._providerSnapshotLoader === null) {
      return null;
    }

    const snapshot = this._providerSnapshotLoader();
    const defaultSelection = defaultSelectionSignature(snapshot.signature);
    const activePreset = this._runtime.model_preset;

    let runtime: LLMRuntime;
    let tracksProviderGen: boolean;

    if (activePreset && (this._defaultSelectionSignature == null || 
        JSON.stringify(this._defaultSelectionSignature) === JSON.stringify(defaultSelection))) {
      runtime = this.resolvePreset(activePreset);
      tracksProviderGen = false;
    } else {
      runtime = this.resolveSnapshot(snapshot);
      tracksProviderGen = true;
    }

    const unchanged = (
      JSON.stringify((runtime as unknown as { snapshot_signature?: unknown[] }).snapshot_signature) ===
      JSON.stringify((this._runtime as unknown as { snapshot_signature?: unknown[] }).snapshot_signature) &&
      runtime.model_preset === this._runtime.model_preset
    );

    if (unchanged) {
      this._defaultSelectionSignature = defaultSelection;
      return null;
    }

    this._runtime = runtime;
    this._tracksProviderGeneration = tracksProviderGen;
    this._defaultSelectionSignature = defaultSelection;
    return runtime;
  }

  resolveOverride(
    options: {
      model?: string | null;
      modelPreset?: string | null;
      config?: unknown;
    } = {},
  ): LLMRuntime | null {
    const { model, modelPreset } = options;

    if (model != null && modelPreset != null) {
      throw new Error('model and model_preset are mutually exclusive');
    }
    if (modelPreset != null) {
      return this.resolvePreset(modelPreset);
    }
    if (model == null) {
      return null;
    }

    return {
      ...this._runtime,
      model,
      model_preset: null,
    };
  }
}
