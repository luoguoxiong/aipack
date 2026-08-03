/**
 * 文本工具：行号格式化、二进制检测、子串计数、glob 转正则、目录遍历。
 *
 * 全部基于 Node 原生 API，零依赖。供 read_file / edit_file / grep / glob 工具复用。
 */

import fs from 'fs';
import path from 'path';

/**
 * cat -n 风格行号格式化：行号右对齐（宽度随最大行号自适应，至少 6）+ tab + 内容。
 * @param content 文件内容（不含行号）
 * @param startLine 起始行号（1-based，默认 1）
 */
export function formatLineNumbers(content: string, startLine = 1): string {
  const lines = content.split('\n');
  // 末尾若以 \n 结尾，split 会产生一个空串，移除以避免多算一行
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return '';
  const width = Math.max(6, String(startLine + lines.length - 1).length);
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width, ' ')}\t${line}`)
    .join('\n');
}

/** 二进制检测：前 8KB 内含 NUL 字节则视为二进制 */
export function isBinary(buf: Buffer): boolean {
  const slice = buf.subarray(0, Math.min(buf.length, 8192));
  return slice.includes(0);
}

/** 统计 needle 在 haystack 中出现次数（字面匹配，非正则） */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

/** 将文本截断到 maxBytes 以内，尾部追加 hint（不计入字节限制） */
export function truncateWithHint(text: string, maxBytes: number, hint: string): string {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return text;
  let cut = maxBytes;
  while (cut > 0 && Buffer.byteLength(text.slice(0, cut), 'utf-8') > maxBytes) cut--;
  return text.slice(0, cut) + hint;
}

/**
 * 把 glob 通配符转为正则表达式（锚定全文 ^...$）。
 *
 * 支持：
 *   - `*`   单层通配，不含路径分隔符 /
 *   - `**`  多层通配，含 /
 *   - `?`   单个字符（非 /）
 *   - `{a,b}` 分支
 *
 * 其他正则元字符会被转义。
 */
export function globToRegex(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (pattern[i] === '/') i++; // 消费 ** 后的 /
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
        i++;
      } else {
        const opts = pattern.slice(i + 1, end).split(',').join('|');
        re += `(?:${opts})`;
        i = end + 1;
      }
    } else if (c === '.' || '\\^$+()|[]'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

/** 默认忽略的目录名（grep / glob 遍历时跳过） */
export const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  '.cache',
  'coverage',
  '.turbo',
]);

export interface WalkOptions {
  /** 跳过的目录名集合（默认 DEFAULT_IGNORE_DIRS） */
  ignoreDirs?: Set<string>;
  /** 最大文件数上限（默认 10000，防超大目录树） */
  maxFiles?: number;
}

/**
 * 递归遍历目录，返回所有文件的**绝对路径**。
 * 跳过 ignoreDirs 中的目录；遇到不可读目录静默跳过。
 */
export async function walkDir(root: string, options: WalkOptions = {}): Promise<string[]> {
  const ignore = options.ignoreDirs ?? DEFAULT_IGNORE_DIRS;
  const maxFiles = options.maxFiles ?? 10000;
  const results: string[] = [];

  async function recurse(dir: string): Promise<void> {
    if (results.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 不可读目录跳过
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignore.has(entry.name)) continue;
        await recurse(full);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  }

  await recurse(root);
  return results;
}
