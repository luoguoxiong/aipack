import type { Provider, Model, ModelsOptions } from './types';
import { Models } from './models';
import { ImagesModels, createImagesModels } from './images';
import { BUILTIN_MODELS, BUILTIN_PROVIDERS, BUILTIN_IMAGES_MODELS } from './catalog';

// ─── 内置提供商 ─────────────────────────────────────────────────────

function createBuiltinProviders(): Provider[] {
  const providerMap = new Map<string, Model[]>();

  for (const model of BUILTIN_MODELS) {
    if (!providerMap.has(model.provider)) {
      providerMap.set(model.provider, []);
    }
    providerMap.get(model.provider)!.push(model);
  }

  return BUILTIN_PROVIDERS.map((meta) => ({
    id: meta.id,
    name: meta.name,
    models: providerMap.get(meta.id) ?? [],
    auth: {
      apiKey: {
        name: `${meta.name} API Key`,
        resolve: async () => {
          const key = process.env[meta.envVar];
          if (key) {
            return { auth: { apiKey: key, source: meta.envVar } };
          }
          return { auth: {} };
        },
      },
    },
  }));
}

export function builtinProviders(): Provider[] {
  return createBuiltinProviders();
}

export function builtinModels(options?: ModelsOptions): Models {
  const models = new Models(options);
  for (const provider of createBuiltinProviders()) {
    models.setProvider(provider);
  }
  return models;
}

export function builtinImagesModels(): ImagesModels {
  return createImagesModels();
}

// ─── 静态目录读取 ───────────────────────────────────────────────────

export function getBuiltinModel(provider: string, modelId: string): Model | undefined {
  return BUILTIN_MODELS.find((m) => m.provider === provider && m.id === modelId);
}

export function getBuiltinModels(provider?: string): Model[] {
  if (provider) {
    return BUILTIN_MODELS.filter((m) => m.provider === provider);
  }
  return BUILTIN_MODELS;
}

export function getBuiltinProviders() {
  return BUILTIN_PROVIDERS;
}
