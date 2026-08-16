/**
 * grep 工具：在文件中搜索文本（支持正则）。
 *
 * Node 原生逐行匹配，零依赖。返回 path:line:content 格式（ripgrep 兼容）。
 * 默认忽略 node_modules/.git/dist；支持 glob 限定文件类型。
 */

import fs from 'fs';
import path from 'path';
import { createTextContent } from '@aipack-ai/agent';
import type { Tool, ToolResult } from '@aipack-ai/agent';
import type { CodingToolContext } from '../types';
import { resolveWithin } from '../utils/path';
import { walkDir, globToRegex, DEFAULT_IGNORE_DIRS, truncateWithHint } from '../utils/text';

export function createGrepTool(ctx: CodingToolContext): Tool {
  return {
    name: 'grep',
    // 框架级 PermissionPolicy 能力声明：读取 workspace 内文件内容
    permissions: ['fs:read'],
    description:
      '在文件中搜索文本（正则）。返回 path:line:content 格式。' +
      'path 可指定文件或目录（默认 workspace 根）；glob 限定文件类型。' +
      '默认忽略 node_modules/.git/dist。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '搜索模式（正则表达式）' },
        path: { type: 'string', description: '搜索范围（文件或目录，默认 workspace 根）' },
        glob: { type: 'string', description: '文件名通配符（如 *.ts）' },
        max_results: {
          type: 'integer',
          description: '返回上限（默认 100）',
          minimum: 1,
          maximum: 500,
        },
        ignore_case: { type: 'boolean', description: '是否忽略大小写（默认 false）' },
      },
      required: ['pattern'],
    },
    async execute(_id, args): Promise<ToolResult> {
      const a = (args ?? {}) as {
        pattern?: string;
        path?: string;
        glob?: string;
        max_results?: number;
        ignore_case?: boolean;
      };
      if (!a.pattern) {
        return {
          content: [createTextContent('grep 失败：pattern 不能为空')],
          details: { error: 'empty pattern' },
        };
      }

      let regex: RegExp;
      try {
        regex = new RegExp(a.pattern, a.ignore_case ? 'i' : '');
      } catch (e) {
        return {
          content: [createTextContent(`grep 失败：无效正则 ${(e as Error).message}`)],
          details: { error: 'invalid regex' },
        };
      }

      // LLM 输入不可信：max_results 代码级 clamp，防止超大值导致遍历失控
      const maxResults = Math.min(Math.max(a.max_results ?? 100, 1), 500);
      const resolved = await resolveWithin(ctx.workspace, a.path ?? '.');
      if (!resolved.ok || !resolved.abs) {
        const err = resolved.error ?? 'resolve failed';
        return {
          content: [createTextContent(`grep 失败：${err}`)],
          details: { error: err },
        };
      }

      // 确定搜索目标：文件 → 单文件；目录 → 递归遍历
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(resolved.abs);
      } catch {
        return {
          content: [createTextContent(`grep 失败：路径不存在 ${a.path ?? '.'}`)],
          details: { error: 'not found' },
        };
      }

      let files: string[];
      if (stat.isFile()) {
        files = [resolved.abs];
      } else {
        files = await walkDir(resolved.abs);
      }

      // glob 过滤（按文件名）
      let globRe: RegExp | null = null;
      if (a.glob) {
        try {
          globRe = globToRegex(a.glob);
        } catch {
          globRe = null;
        }
      }

      const matches: string[] = [];
      const ws = path.resolve(ctx.workspace);

      for (const file of files) {
        if (matches.length >= maxResults) break;
        // glob 过滤
        if (globRe && !globRe.test(path.basename(file))) continue;

        let content: string;
        try {
          content = await fs.promises.readFile(file, 'utf-8');
        } catch {
          continue; // 不可读文件跳过（二进制等）
        }

        const relPath = path.relative(ws, file);
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= maxResults) break;
          if (regex.test(lines[i])) {
            // 截断过长行
            const line = lines[i].length > 500 ? lines[i].slice(0, 500) + '…' : lines[i];
            matches.push(`${relPath}:${i + 1}:${line}`);
          }
        }
      }

      if (matches.length === 0) {
        return {
          content: [createTextContent('未找到匹配。')],
          details: { count: 0, pattern: a.pattern },
        };
      }

      const output = truncateWithHint(
        `找到 ${matches.length} 处匹配${matches.length >= maxResults ? '（已达上限）' : ''}：\n${matches.join('\n')}`,
        200_000,
        '\n... (输出已截断)',
      );

      return {
        content: [createTextContent(output)],
        details: {
          count: matches.length,
          pattern: a.pattern,
          truncated: matches.length >= maxResults,
        },
      };
    },
  };
}
