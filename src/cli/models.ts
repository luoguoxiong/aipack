import { logger } from '../utils/logger.js';
import { loadConfig, saveConfig } from '../config/loader.js';

export async function listModels(opts?: { configPath?: string }): Promise<void> {
  try {
    const config = await loadConfig(opts?.configPath);
    const models: string[] = [];
    
    if (config.agents.defaults.model) {
      models.push(config.agents.defaults.model);
    }
    
    for (const preset of Object.values(config.agents.model_presets || {})) {
      const p = preset as Record<string, unknown>;
      if (p.model) {
        models.push(p.model as string);
      }
    }
    
    console.log(`Available models (${models.length}):`);
    for (const model of models) {
      console.log(`  - ${model}`);
    }
  } catch (err) {
    logger.error({ err }, 'Failed to list models');
    process.exit(1);
  }
}

export async function setDefaultModel(model: string, opts?: { configPath?: string }): Promise<void> {
  try {
    const config = await loadConfig(opts?.configPath);
    config.agents.defaults.model = model;
    config.agents.defaults.provider = 'auto';
    await saveConfig(config, opts?.configPath);
    console.log(`Default model set to: ${model}`);
  } catch (err) {
    logger.error({ err }, 'Failed to set default model');
    process.exit(1);
  }
}

export async function createModelPreset(opts: {
  name: string;
  model: string;
  provider?: string;
  maxTokens?: number;
  contextWindow?: number;
  temperature?: number;
  configPath?: string;
}): Promise<void> {
  try {
    const config = await loadConfig(opts.configPath);
    
    if (!config.agents.model_presets) {
      config.agents.model_presets = {};
    }
    
    config.agents.model_presets[opts.name] = {
      model: opts.model,
      provider: opts.provider || 'auto',
      max_tokens: opts.maxTokens || 4096,
      context_window_tokens: opts.contextWindow || 128000,
      temperature: opts.temperature ?? 0.7,
    };
    
    await saveConfig(config, opts.configPath);
    console.log(`Model preset created: ${opts.name}`);
  } catch (err) {
    logger.error({ err }, 'Failed to create model preset');
    process.exit(1);
  }
}

export async function deleteModelPreset(name: string, opts?: { configPath?: string }): Promise<void> {
  try {
    const config = await loadConfig(opts?.configPath);
    
    if (!config.agents.model_presets || !config.agents.model_presets[name]) {
      console.log(`Model preset not found: ${name}`);
      return;
    }
    
    delete config.agents.model_presets[name];
    await saveConfig(config, opts?.configPath);
    console.log(`Model preset deleted: ${name}`);
  } catch (err) {
    logger.error({ err }, 'Failed to delete model preset');
    process.exit(1);
  }
}