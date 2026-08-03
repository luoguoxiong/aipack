/**
 * 路径工具：workspace 沙箱校验 + ~ 展开。
 *
 * 所有文件工具的路径参数都先经 resolveWithin 校验，
 * 确保解析后的绝对路径在 workspace 之内，防止 ../../ 逃逸。
 */

import path from 'path';

export interface ResolveResult {
  ok: boolean;
  /** 解析后的绝对路径 */
  abs?: string;
  /** 相对 workspace 的路径（根目录为当前目录） */
  rel?: string;
  /** 失败原因 */
  error?: string;
}

/** 展开 ~ / ~/ 开头的路径为家目录绝对路径 */
export function expandHome(p: string): string {
  const home = process.env.HOME ?? '';
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/**
 * 将相对 workspace 的路径解析为绝对路径，并校验落在 workspace 内。
 *
 * - rel 为空或非字符串 → 失败
 * - 解析后路径以 ../ 开头或为其他绝对路径 → 失败（逃逸）
 * - 根目录（rel = '.' 或 ''）→ abs = workspace
 *
 * @param workspace workspace 根目录（绝对路径）
 * @param rel 相对 workspace 的路径
 */
export function resolveWithin(workspace: string, rel: string): ResolveResult {
  if (!rel || typeof rel !== 'string' || !rel.trim()) {
    return { ok: false, error: 'path 不能为空' };
  }
  const ws = path.resolve(workspace);
  const abs = path.resolve(ws, rel);
  const relToWs = path.relative(ws, abs);
  // 相对路径以 .. 开头表示逃逸；path.isAbsolute 为 true 表示跨盘符（Windows）
  if (relToWs.startsWith('..') || path.isAbsolute(relToWs)) {
    return { ok: false, error: `路径 "${rel}" 超出 workspace 边界` };
  }
  return { ok: true, abs, rel: relToWs || '.' };
}
