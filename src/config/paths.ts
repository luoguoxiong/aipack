import path from 'path';
import { homedir } from 'os';

export function getConfigPath(): string {
  const configDir = process.env.NANOBOT_CONFIG_DIR || path.join(homedir(), '.nanobot');
  return path.join(configDir, 'config.yaml');
}

export function getWorkspacePath(workspace: string): string {
  if (workspace.startsWith('~')) {
    return path.join(homedir(), workspace.slice(1));
  }
  return path.resolve(workspace);
}

export function getMemoryPath(baseDir: string): string {
  if (baseDir.startsWith('~')) {
    return path.join(homedir(), baseDir.slice(1));
  }
  return path.resolve(baseDir);
}

export function getChannelsDir(): string {
  const configDir = process.env.NANOBOT_CONFIG_DIR || path.join(homedir(), '.nanobot');
  return path.join(configDir, 'channels');
}
