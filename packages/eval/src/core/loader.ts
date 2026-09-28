/**
 * packages/eval/src/core/loader.ts - 用例加载器
 *
 * 递归扫描用例目录（缺省 <包根>/eval/cases），解析 JSON 为 EvalCase，
 * 加载即校验（fail fast），重复 id 报错。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type { EvalCase } from './types';
import { validateEvalCase } from './validate';

/** 包根目录：从当前文件向上查找最近的 package.json（源码与 dist 产物通用） */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 兜底：回到源码相对位置（src/core → 上两级）
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function defaultCasesDir(): string {
  return join(packageRoot(), 'eval', 'cases');
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile() && (e.name.endsWith('.json') || e.name.endsWith('.jsonc'))) {
      yield full;
    }
  }
}

export interface LoadCasesResult {
  cases: EvalCase[];
  /** 相对用例目录的文件路径（诊断用） */
  sources: Map<string, string>;
  errors: string[];
}

/**
 * 加载用例目录。校验失败的文件进入 errors（不中断整体加载），
 * 但重复 id 一律报错（防套件意外覆盖）。
 */
export async function loadCases(casesDir?: string): Promise<LoadCasesResult> {
  const dir = resolve(casesDir ?? defaultCasesDir());
  const cases: EvalCase[] = [];
  const sources = new Map<string, string>();
  const errors: string[] = [];
  const seenIds = new Map<string, string>();

  let dirExists = true;
  try {
    await stat(dir);
  } catch {
    dirExists = false;
  }
  if (!dirExists) {
    return { cases, sources, errors: [`用例目录不存在: ${dir}`] };
  }

  for await (const file of walk(dir)) {
    const rel = file.slice(dir.length + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, 'utf-8'));
    } catch (e) {
      errors.push(`${rel}: JSON 解析失败 - ${(e as Error).message}`);
      continue;
    }

    // 支持单文件单用例或数组
    const list: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of list) {
      const c = item as EvalCase;
      const caseErrors = validateEvalCase(c);
      if (caseErrors.length > 0) {
        errors.push(`${rel}: ${caseErrors.join('; ')}`);
        continue;
      }
      const dup = seenIds.get(c.id);
      if (dup) {
        errors.push(`${rel}: id '${c.id}' 与 ${dup} 重复`);
        continue;
      }
      seenIds.set(c.id, rel);
      cases.push(c);
      sources.set(c.id, rel);
    }
  }

  return { cases, sources, errors };
}
