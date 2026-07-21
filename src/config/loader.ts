import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { Config, ConfigSchema, defaultConfig } from './schema.js';
import { getProjectConfigDir } from './paths.js';

export function getConfigDir(): string {
  return getProjectConfigDir();
}

export function getConfigPath(configPath?: string): string {
  if (configPath) {
    return path.resolve(configPath.replace('~', os.homedir()));
  }
  return path.join(getConfigDir(), 'config.json');
}

export function resolveConfigEnvVars(config: Config): Config {
  const envVarPattern = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
  
  function resolveValue(value: unknown): unknown {
    if (typeof value === 'string') {
      return value.replace(envVarPattern, (_, varName) => {
        return process.env[varName] || '';
      });
    }
    if (Array.isArray(value)) {
      return value.map(resolveValue);
    }
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = resolveValue(v);
      }
      return result;
    }
    return value;
  }
  
  return resolveValue(config) as Config;
}

export async function loadConfig(configPath?: string): Promise<Config> {
  const resolvedPath = getConfigPath(configPath);
  
  try {
    const content = await fs.readFile(resolvedPath, 'utf-8');
    const data = JSON.parse(content);
    const config = ConfigSchema.parse(data);
    return resolveConfigEnvVars(config);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaultConfig();
    }
    throw err;
  }
}

export async function saveConfig(config: Config, configPath?: string): Promise<void> {
  const resolvedPath = getConfigPath(configPath);
  const dir = path.dirname(resolvedPath);
  
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(resolvedPath, JSON.stringify(config, null, 2), 'utf-8');
}
