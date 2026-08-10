/**
 * write_file 工具：整体覆盖写入文件。
 *
 * 自动创建父目录；原子写（tmp + rename）防止中断后留下半截文件。
 */

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { createTextContent } from '@aipack/agent';
import type { Tool, ToolResult } from '@aipack/agent';
import type { CodingToolContext } from '../types';
import { resolveWithin } from '../utils/path';

export function createWriteFileTool(ctx: CodingToolContext): Tool {
  return {
    name: 'write_file',
    // 框架级 PermissionPolicy 能力声明：写入 workspace 内文件
    permissions: ['fs:write'],
    description:
      '写入文件（整体覆盖）。content 为完整新内容，会覆盖已有文件。' +
      '父目录不存在时自动创建。路径必须在 workspace 内。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于 workspace 的文件路径' },
        content: { type: 'string', description: '完整的文件内容（覆盖写入）' },
      },
      required: ['path', 'content'],
    },
    async execute(_id, args): Promise<ToolResult> {
      const a = (args ?? {}) as { path?: string; content?: string };
      if (a.content === undefined || a.content === null) {
        return {
          content: [createTextContent('write_file 失败：content 不能为空')],
          details: { error: 'empty content' },
        };
      }

      const resolved = await resolveWithin(ctx.workspace, a.path ?? '');
      if (!resolved.ok || !resolved.abs) {
        const err = resolved.error ?? 'resolve failed';
        return {
          content: [createTextContent(`write_file 失败：${err}`)],
          details: { error: err },
        };
      }

      const abs = resolved.abs;
      try {
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        // 原子写：tmp + rename
        const tmp = `${abs}.tmp-${randomBytes(4).toString('hex')}`;
        await fs.promises.writeFile(tmp, a.content, 'utf-8');
        await fs.promises.rename(tmp, abs);
      } catch (e) {
        return {
          content: [createTextContent(`write_file 失败：${(e as Error).message}`)],
          details: { error: 'write error' },
        };
      }

      const bytes = Buffer.byteLength(a.content, 'utf-8');
      const lineCount = a.content.split('\n').length;
      return {
        content: [createTextContent(`已写入 ${a.path}（${bytes} 字节，${lineCount} 行）`)],
        details: { path: a.path, bytes, lines: lineCount },
      };
    },
  };
}
