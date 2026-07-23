import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { ConfigSchema, Config, defaultConfig } from './schema';
import { getConfigPath } from './paths';

export async function loadConfig(configPath?: string): Promise<Config> {
  const resolvedPath = configPath || getConfigPath();
  
  if (!fs.existsSync(resolvedPath)) {
    return defaultConfig();
  }
  
  try {
    const content = await fs.promises.readFile(resolvedPath, 'utf-8');
    const raw = yaml.load(content) as unknown;
    return ConfigSchema.parse(raw);
  } catch (err) {
    console.warn(`Failed to load config from ${resolvedPath}, using defaults:`, (err as Error).message);
    return defaultConfig();
  }
}

export async function saveConfig(config: Config, configPath?: string): Promise<void> {
  const resolvedPath = configPath || getConfigPath();
  const dir = path.dirname(resolvedPath);
  
  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true });
  }
  
  const content = yaml.dump(config);
  await fs.promises.writeFile(resolvedPath, content, 'utf-8');
}

export { getConfigPath };
