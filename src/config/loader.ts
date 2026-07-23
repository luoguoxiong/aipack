import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { ConfigSchema, Config, defaultConfig } from './schema';
import { getConfigPath, resolveWorkspace, resolveSubPath } from './paths';

/**
 * 向后兼容：旧版配置中的子路径带 .kobot/ 前缀（如 .kobot/memory），
 * 现在 workspace 本身已指向 ~/.kobot，需要去除多余的前缀。
 */
function stripLegacyPrefix(subPath: string): string {
  if (subPath.startsWith('.kobot/')) {
    return subPath.slice(7);
  }
  return subPath;
}

export async function loadConfig(configPath?: string): Promise<Config> {
  const defaultConfigPath = getConfigPath();
  const resolvedPath = configPath || defaultConfigPath;
  
  let config: Config;
  
  if (!fs.existsSync(resolvedPath)) {
    config = defaultConfig();
    // 默认启用文件存储，使 session 持久化开箱即用
    config.sessions = { storage: 'file', storage_path: 'sessions' };
  } else {
    try {
      const content = await fs.promises.readFile(resolvedPath, 'utf-8');
      const raw = yaml.load(content) as unknown;
      config = ConfigSchema.parse(raw);
    } catch (err) {
      console.warn(`Failed to load config from ${resolvedPath}, using defaults:`, (err as Error).message);
      config = defaultConfig();
    }
  }

  // 将 workspace 解析为绝对路径，并保存在内部字段 workspace_resolved 中
  const workspaceResolved = resolveWorkspace(config.workspace);
  config.workspace_resolved = workspaceResolved;

  // 将所有相对子路径基于 workspace 解析为绝对路径
  // 先去除旧版 .kobot/ 前缀以保持向后兼容
  if (config.memory?.base_dir) {
    config.memory.base_dir = resolveSubPath(workspaceResolved, stripLegacyPrefix(config.memory.base_dir));
  }
  if (config.sessions?.storage_path) {
    config.sessions.storage_path = resolveSubPath(workspaceResolved, stripLegacyPrefix(config.sessions.storage_path));
  }
  if (config.logging?.file_path) {
    config.logging.file_path = resolveSubPath(workspaceResolved, stripLegacyPrefix(config.logging.file_path));
  }
  if (config.agents?.defaults?.workspace) {
    config.agents.defaults.workspace = resolveSubPath(workspaceResolved, stripLegacyPrefix(config.agents.defaults.workspace));
  }

  // 文件不存在时创建默认配置（仅当路径等于默认配置路径时）
  const isDefaultPath = resolvedPath === defaultConfigPath;
  if (isDefaultPath && !fs.existsSync(resolvedPath)) {
    try {
      await saveConfig(config, resolvedPath);
    } catch {
      // 写入失败时静默忽略（例如沙箱环境无写入权限）
    }
  }

  return config;
}

export async function saveConfig(config: Config, configPath?: string): Promise<void> {
  const resolvedPath = configPath || getConfigPath();
  const dir = path.dirname(resolvedPath);
  
  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true });
  }
  
  // 保存时不输出内部字段
  const { workspace_resolved, ...configToSave } = config;
  const content = yaml.dump(configToSave);
  await fs.promises.writeFile(resolvedPath, content, 'utf-8');
}

export { getConfigPath };
