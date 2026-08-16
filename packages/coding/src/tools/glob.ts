/**
 * glob 工具：按通配符模式查找文件。
 *
 * Node 原生 fs.readdir 递归 + 自实现 globToRegex，零依赖。
 * 默认跳过 node_modules/.git/dist。返回相对 workspace 的路径列表。
 */

import fs from 'fs';
import path from 'path';
import { createTextContent } from '@aipack-ai/agent';
import type { Tool, ToolResult } from '@aipack-ai/agent';
import type { CodingToolContext } from '../types';
import { resolveWithin } from '../utils/path';
import { walkDir, globToRegex } from '../utils/text';

export function createGlobTool(ctx: CodingToolContext): Tool {
  return {
    name: 'glob',
    // 框架级 PermissionPolicy 能力声明：读取 workspace 内目录
    permissions: ['fs:read'],
    description:
      '按通配符模式查找文件。返回匹配的文件路径列表（相对 workspace）。' +
      '支持 *（单层）、**（多层）、?（单字符）、{a,b}（分支）。' +
      '默认忽略 node_modules/.git/dist。',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: '通配符模式（如 **/*.ts、src/**/*.test.ts）',
        },
        path: {
          type: 'string',
          description: '搜索根目录（默认 workspace 根）',
        },
        max_results: {
          type: 'integer',
          description: '返回上限（默认 100）',
          minimum: 1,
          maximum: 1000,
        },
      },
      required: ['pattern'],
    },
    async execute(_id, args): Promise<ToolResult> {
      const a = (args ?? {}) as {
        pattern?: string;
        path?: string;
        max_results?: number;
      };
      if (!a.pattern) {
        return {
          content: [createTextContent('glob 失败：pattern 不能为空')],
          details: { error: 'empty pattern' },
        };
      }

      let matcher: RegExp;
      try {
        matcher = globToRegex(a.pattern);
      } catch (e) {
        return {
          content: [createTextContent(`glob 失败：无效模式 ${(e as Error).message}`)],
          details: { error: 'invalid pattern' },
        };
      }

      // LLM 输入不可信：max_results 代码级 clamp，防止超大值导致遍历失控
      const maxResults = Math.min(Math.max(a.max_results ?? 100, 1), 1000);
      const resolved = await resolveWithin(ctx.workspace, a.path ?? '.');
      if (!resolved.ok || !resolved.abs) {
        const err = resolved.error ?? 'resolve failed';
        return {
          content: [createTextContent(`glob 失败：${err}`)],
          details: { error: err },
        };
      }

      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(resolved.abs);
      } catch {
        return {
          content: [createTextContent(`glob 失败：路径不存在 ${a.path ?? '.'}`)],
          details: { error: 'not found' },
        };
      }
      if (!stat.isDirectory()) {
        return {
          content: [createTextContent(`glob 失败：${a.path ?? '.'} 不是目录`)],
          details: { error: 'not directory' },
        };
      }

      const ws = path.resolve(ctx.workspace);
      // 遍历上限放宽到 10 万（walkDir 默认 1 万），避免大仓库漏扫尾部文件；
      // 匹配数量在下方循环内达到 maxResults 即提前 break。
      const allFiles = await walkDir(resolved.abs, { maxFiles: 100_000 });

      const matched: string[] = [];
      for (const file of allFiles) {
        if (matched.length >= maxResults) break;
        const relPath = path.relative(ws, file);
        // 同时尝试匹配相对路径与纯文件名，覆盖 **/*.ts 与 *.ts 两种用法
        if (matcher.test(relPath) || matcher.test(path.basename(file))) {
          matched.push(relPath);
        }
      }

      if (matched.length === 0) {
        return {
          content: [createTextContent('未找到匹配文件。')],
          details: { count: 0, pattern: a.pattern },
        };
      }

      const truncated = matched.length >= maxResults;
      return {
        content: [
          createTextContent(
            `找到 ${matched.length} 个文件${truncated ? '（已达上限）' : ''}：\n${matched.join('\n')}`,
          ),
        ],
        details: { count: matched.length, pattern: a.pattern, truncated },
      };
    },
  };
}
