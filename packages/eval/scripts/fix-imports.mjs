/**
 * packages/eval/scripts/fix-imports.mjs
 *
 * tsc 的 ESM 产物保留无扩展名的相对导入（import './types'），
 * Node 的 ESM 解析器要求显式扩展名且不支持目录导入。本脚本给
 * dist 内所有 .js 的相对导入（static import / export ... from /
 * dynamic import()）补全扩展名：
 *   - './types'      → './types.js'
 *   - './scorer'     → './scorer/index.js'   （目录导入）
 * 使 tsc 产物可直接被 Node 运行。tsup 不可用时的回退构建路径。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const distDir = new URL('../dist/', import.meta.url).pathname;

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.name.endsWith('.js')) yield full;
  }
}

const RE_FROM = /(\bimport\b[^;]*?\bfrom\s*|\bexport\b[^;]*?\bfrom\s*)(['"])(\.{1,2}\/[^'"]*)\2/g;
const RE_DYNAMIC = /\bimport\((['"])(\.{1,2}\/[^'"]*)\1\)/g;

/** 给相对 spec 补全扩展名（以导入文件所在目录为基准判断） */
function fixSpec(spec, fromDir) {
  if (/\.(js|mjs|cjs|json|node)$/.test(spec)) return spec;
  const base = join(fromDir, spec);
  if (existsSync(base + '.js')) return spec + '.js';
  if (existsSync(join(base, 'index.js'))) return spec + '/index.js';
  return spec + '.js'; // 兜底
}

let touched = 0;
for await (const file of walk(distDir)) {
  const fromDir = dirname(file);
  const src = await readFile(file, 'utf-8');
  let out = src
    .replace(RE_FROM, (_m, pre, q, spec) => `${pre}${q}${fixSpec(spec, fromDir)}${q}`)
    .replace(RE_DYNAMIC, (_m, q, spec) => `import(${q}${fixSpec(spec, fromDir)}${q})`);
  if (file.endsWith('/src/cli.js') && !out.startsWith('#!')) {
    out = '#!/usr/bin/env node\n' + out;
  }
  if (out !== src) {
    await writeFile(file, out, 'utf-8');
    touched += 1;
  }
}
console.log(`fix-imports: processed ${touched} file(s)`);
