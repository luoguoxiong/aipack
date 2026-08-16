/**
 * read_file 工具：读取文本文件，返回带行号内容（cat -n 风格）。
 *
 * 支持 offset/limit 分页；二进制文件检测；大文件截断提示。
 */

import fs from 'fs';
import { createTextContent } from '@aipack-ai/agent';
import type { Tool, ToolResult } from '@aipack-ai/agent';
import type { CodingToolContext } from '../types';
import { resolveWithin } from '../utils/path';
import { formatLineNumbers, isBinary, truncateWithHint } from '../utils/text';

export function createReadFileTool(ctx: CodingToolContext): Tool {
  return {
    name: 'read_file',
    // 框架级 PermissionPolicy 能力声明：读取 workspace 内文件
    permissions: ['fs:read'],
    description:
      '读取文本文件内容并返回带行号的格式（cat -n 风格）。' +
      'path 相对 workspace；可选 offset/limit 分页避免大文件超长。' +
      '二进制文件、不存在文件、workspace 外路径返回错误。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于 workspace 的文件路径' },
        offset: {
          type: 'integer',
          description: '起始行号（1-based，默认 1）',
          minimum: 1,
        },
        limit: {
          type: 'integer',
          description: '读取行数（默认 2000，最大 5000）',
          minimum: 1,
          maximum: 5000,
        },
      },
      required: ['path'],
    },
    async execute(_id, args): Promise<ToolResult> {
      const a = (args ?? {}) as { path?: string; offset?: number; limit?: number };
      const offset = a.offset ?? 1;
      let limit = a.limit ?? 2000;
      if (limit > 5000) limit = 5000;

      const resolved = await resolveWithin(ctx.workspace, a.path ?? '');
      if (!resolved.ok || !resolved.abs) {
        const err = resolved.error ?? 'resolve failed';
        return {
          content: [createTextContent(`read_file 失败：${err}`)],
          details: { error: err },
        };
      }

      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(resolved.abs);
      } catch {
        return {
          content: [createTextContent(`read_file 失败：文件不存在 ${a.path}`)],
          details: { error: 'not found' },
        };
      }
      if (stat.isDirectory()) {
        return {
          content: [createTextContent(`read_file 失败：${a.path} 是目录，请用 list_directory`)],
          details: { error: 'is directory' },
        };
      }

      let buf: Buffer;
      try {
        buf = await fs.promises.readFile(resolved.abs);
      } catch (e) {
        return {
          content: [createTextContent(`read_file 失败：读取错误 ${(e as Error).message}`)],
          details: { error: 'read error' },
        };
      }

      if (isBinary(buf)) {
        return {
          content: [createTextContent(`read_file 失败：${a.path} 是二进制文件`)],
          details: { error: 'binary' },
        };
      }

      const content = buf.toString('utf-8');
      const allLines = content.split('\n');
      // 末尾以 \n 结尾时 split 产生空串，移除以避免多算一行
      if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();
      const totalLines = allLines.length;

      const startIdx = Math.min(Math.max(offset - 1, 0), totalLines);
      const endIdx = Math.min(startIdx + limit, totalLines);
      const sliced = allLines.slice(startIdx, endIdx).join('\n');

      let result: string;
      if (totalLines === 0) {
        result = '(空文件)';
      } else {
        result = formatLineNumbers(sliced, startIdx + 1);
        if (endIdx < totalLines) {
          result += `\n... (已截断，共 ${totalLines} 行，可用 offset=${endIdx + 1} 继续读取)`;
        }
      }

      // 截断超长输出（约 200KB，防 context 爆炸）
      result = truncateWithHint(result, 200_000, '\n... (输出过长已截断)');

      return {
        content: [createTextContent(result)],
        details: {
          path: a.path,
          totalLines,
          shown: endIdx - startIdx,
          offset: startIdx + 1,
        },
      };
    },
  };
}
