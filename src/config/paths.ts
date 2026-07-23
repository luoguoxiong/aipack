import path from 'path';
import { homedir } from 'os';

export function getConfigPath(): string {
  const configDir = process.env.KOBOT_CONFIG_DIR || path.join(homedir(), '.kobot');
  return path.join(configDir, 'config.yaml');
}

/**
 * 将 ~ 开头的路径解析为绝对路径，否则返回 path.resolve(workspace)
 */
export function resolveHomePath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(homedir(), p.slice(1));
  }
  return path.resolve(p);
}

/**
 * 解析 workspace 配置值为绝对路径
 */
export function resolveWorkspace(workspace: string): string {
  return resolveHomePath(workspace);
}

/**
 * 将子路径（memory、sessions、logs 等）基于 workspace 解析为绝对路径。
 * - 如果 subPath 已经是绝对路径，直接返回
 * - 否则相对于 workspace 解析
 */
export function resolveSubPath(workspaceResolved: string, subPath: string): string {
  if (path.isAbsolute(subPath)) {
    return subPath;
  }
  return path.join(workspaceResolved, subPath);
}

/**
 * @deprecated Use resolveHomePath instead
 */
export function getWorkspacePath(workspace: string): string {
  return resolveHomePath(workspace);
}

/**
 * @deprecated Use resolveSubPath instead
 */
export function getMemoryPath(baseDir: string): string {
  if (baseDir.startsWith('~')) {
    return path.join(homedir(), baseDir.slice(1));
  }
  return path.resolve(baseDir);
}

export function getChannelsDir(): string {
  const configDir = process.env.KOBOT_CONFIG_DIR || path.join(homedir(), '.kobot');
  return path.join(configDir, 'channels');
}
