/**
 * packages/eval/src/core/import.ts - trace 回流用例入库（M4）
 *
 * 把 observability-server `POST /api/v1/export-eval` 导出的 EvalCase JSON
 * 写入用例目录（入库 = 纳入日常 eval 回归）。入库前走 validateEvalCase
 * （fail fast），支持单用例 / 数组 / { cases: [...] } 三种文件形态，
 * 以及 suite / origin / id 前缀的人工修正（bad case 固化纪律）。
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CaseOrigin } from './types';
import { validateEvalCase } from './validate';
import { defaultCasesDir } from './loader';

export interface ImportOptions {
  /** 导出文件路径（单 case / 数组 / { cases: [...] }） */
  file: string;
  /** 用例目录（缺省 defaultCasesDir） */
  outDir?: string;
  /** 覆盖 suite */
  suite?: string;
  /** 覆盖 origin（'trace' | 'bugfix'） */
  origin?: CaseOrigin;
  /** case id 加前缀（如 'bugfix'），避免与既有 id 冲突 */
  prefix?: string;
  /** 只校验不写盘 */
  dryRun?: boolean;
}

export interface ImportResult {
  /** 写入的文件路径（相对 outDir） */
  written: string[];
  /** 校验/写入错误（带 case 上下文） */
  errors: string[];
}

function normalizeId(id: string): string {
  // 文件名 = id 的最后一段（'trace-export/t-1' → 't-1.json'），非法字符收敛
  const last = id.split('/').pop() ?? id;
  return last.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export async function importCases(opts: ImportOptions): Promise<ImportResult> {
  const outDir = resolve(opts.outDir ?? defaultCasesDir());
  const raw = await readFile(opts.file, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { written: [], errors: [`JSON 解析失败: ${(e as Error).message}`] };
  }

  let list: unknown[];
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { cases?: unknown[] }).cases)) {
    list = (parsed as { cases: unknown[] }).cases;
  } else list = [parsed];

  if (list.length === 0) return { written: [], errors: ['文件中没有用例'] };

  const written: string[] = [];
  const errors: string[] = [];
  /** 已占用文件名：suite → Set<fileName> */
  const taken = new Map<string, Set<string>>();
  const takeFor = (suiteName: string): Set<string> => {
    let set = taken.get(suiteName);
    if (!set) {
      set = new Set<string>();
      taken.set(suiteName, set);
    }
    return set;
  };
  if (!opts.dryRun) {
    // 同目录已存在的文件也占位，避免覆盖人工已修正的用例
    try {
      const suiteDirGuess = opts.suite ?? guessSuite(list);
      if (suiteDirGuess) {
        const existing = await readdir(resolve(outDir, suiteDirGuess)).catch(() => [] as string[]);
        for (const f of existing) takeFor(suiteDirGuess).add(f);
      }
    } catch {
      // outDir 不存在时忽略
    }
  }

  for (const [i, item] of list.entries()) {
    const c = item as Record<string, unknown>;
    const label = `#${i} ${(c.id as string) ?? '<missing id>'}`;
    if (!c || typeof c !== 'object') {
      errors.push(`${label}: 不是对象`);
      continue;
    }
    if (opts.suite) c.suite = opts.suite;
    if (opts.origin) c.origin = opts.origin;
    if (opts.prefix) c.id = `${opts.prefix}/${String(c.id ?? `case-${i}`)}`;

    const validation = validateEvalCase(c as never);
    if (validation.length > 0) {
      errors.push(`${label}: ${validation.join('; ')}`);
      continue;
    }

    const suite = String(c.suite);
    const takenSet = takeFor(suite);
    let fileName = `${normalizeId(String(c.id))}.json`;
    let n = 1;
    while (takenSet.has(fileName)) {
      fileName = `${normalizeId(String(c.id))}-${n}.json`;
      n += 1;
    }
    takenSet.add(fileName);

    if (opts.dryRun) {
      written.push(`${suite}/${fileName}`);
      continue;
    }
    const target = resolve(outDir, suite, fileName);
    try {
      await mkdir(resolve(outDir, suite), { recursive: true });
      await writeFile(target, `${JSON.stringify(c, null, 2)}\n`, 'utf-8');
      written.push(`${suite}/${fileName}`);
    } catch (e) {
      errors.push(`${label}: 写入失败 - ${(e as Error).message}`);
    }
  }

  return { written, errors };
}

function guessSuite(list: unknown[]): string | undefined {
  const first = list[0] as { suite?: unknown } | undefined;
  return typeof first?.suite === 'string' && first.suite ? first.suite : undefined;
}
