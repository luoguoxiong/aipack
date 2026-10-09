/**
 * CLI 元信息与目录约定
 */
import os from 'node:os';
import path from 'node:path';
import pkg from '../package.json';

/** 命令名：优先取 bin 名称（aipack），兜底包名去 scope */
export const APP_NAME =
  Object.keys(pkg.bin ?? {})[0] ?? pkg.name.replace(/^@[^/]+\//, '');
export const VERSION = pkg.version;

/** 全局配置目录（默认 ~/.aipack，可用 AIPACK_CONFIG_DIR 覆盖） */
export function defaultConfigDir(): string {
  return process.env.AIPACK_CONFIG_DIR ?? path.join(os.homedir(), '.aipack');
}

/**
 * CLI 会话存储目录（按工作目录分组）：
 *   ~/.aipack/cli-sessions/<cwd 安全编码>/<sessionKey>.json
 */
export function defaultSessionDir(cwd: string): string {
  return path.join(defaultConfigDir(), 'cli-sessions', encodeDir(cwd));
}

/**
 * 将路径编码为安全目录名。
 * encodeURIComponent 无碰撞（"/a/b" → "%2Fa%2Fb"），取代旧的非安全字符折叠为 "_" 的编码
 * （旧编码下 "/a/b" 与 "/a.b" 均折叠为 "_a_b"，不同目录共享同一会话存储）。
 */
export function encodeDir(p: string): string {
  return encodeURIComponent(p);
}

/** 旧版路径编码（非安全字符统一折叠为 _，存在碰撞），仅用于存量目录兼容探测 */
export function legacyEncodeDir(p: string): string {
  return p.replace(/[^a-zA-Z0-9_-]/g, '_');
}
