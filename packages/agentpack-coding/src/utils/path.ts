/**
 * 路径工具：workspace 沙箱校验 + ~ 展开。
 *
 * 所有文件工具的路径参数都先经 resolveWithin 校验，
 * 确保解析后的绝对路径在 workspace 之内，防止 ../../ 逃逸，
 * 并通过 realpath 校验防止符号链接指向 workspace 之外。
 */

import path from 'path';
import { promises as fs } from 'fs';

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
 * 若路径存在则返回其真实路径（realpath）；不存在时向上找到最近存在的祖先，
 * 将祖先的真实路径与剩余段拼接返回。用于对"即将创建的文件"做沙箱校验。
 */
async function realpathOrNearest(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    // 路径不存在：向上查找最近存在的祖先
    let cur = p;
    const tail: string[] = [];
    for (;;) {
      const parent = path.dirname(cur);
      if (parent === cur) return p; // 到根仍不存在，返回原值（字符串级校验兜底）
      try {
        const real = await fs.realpath(cur);
        return path.join(real, ...tail.reverse());
      } catch {
        tail.push(path.basename(cur));
        cur = parent;
      }
    }
  }
}

/**
 * 将相对 workspace 的路径解析为绝对路径，并校验落在 workspace 内。
 *
 * - rel 为空或非字符串 → 失败
 * - 解析后路径以 ../ 开头或为其他绝对路径 → 失败（逃逸）
 * - 解析后路径的真实路径（realpath）超出 workspace 真实路径 → 失败（符号链接逃逸）
 * - 根目录（rel = '.' 或 ''）→ abs = workspace
 *
 * @param workspace workspace 根目录（绝对路径）
 * @param rel 相对 workspace 的路径
 */
export async function resolveWithin(workspace: string, rel: string): Promise<ResolveResult> {
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

  // 符号链接逃逸校验：字符串级校验无法阻止 workspace 内链接指向外部目录。
  // 仅当 workspace 真实存在时校验（workspace 尚不存在则退回字符串级结果）。
  try {
    const wsReal = await fs.realpath(ws);
    const absReal = await realpathOrNearest(abs);
    const realRel = path.relative(wsReal, absReal);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      return { ok: false, error: `路径 "${rel}" 通过符号链接指向 workspace 之外` };
    }
  } catch {
    // realpath 失败（如 workspace 不存在或权限问题）时退回字符串级校验结果
  }

  return { ok: true, abs, rel: relToWs || '.' };
}
