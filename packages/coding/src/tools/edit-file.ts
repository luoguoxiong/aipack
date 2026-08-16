/**
 * edit_file 工具：字符串精确替换修改文件局部内容。
 *
 * old_string 必须唯一匹配（否则报错引导 read_file），replace_all 兜底。
 * 节省 token 且更安全（唯一性校验防误改）。
 */

import fs from 'fs';
import { randomBytes } from 'crypto';
import { createTextContent } from '@aipack-ai/agent';
import type { Tool, ToolResult } from '@aipack-ai/agent';
import type { CodingToolContext } from '../types';
import { resolveWithin } from '../utils/path';
import { countOccurrences } from '../utils/text';

export function createEditFileTool(ctx: CodingToolContext): Tool {
  return {
    name: 'edit_file',
    // 框架级 PermissionPolicy 能力声明：修改 workspace 内文件
    permissions: ['fs:write'],
    description:
      '通过 old_string 替换为 new_string 精确修改文件局部内容。' +
      'old_string 必须在文件中唯一匹配（否则报错，需补充更多上下文使其唯一，或设 replace_all=true）。' +
      '适合小幅修改，比 write_file 节省 token。无法创建新文件（用 write_file）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于 workspace 的文件路径' },
        old_string: { type: 'string', description: '要被替换的原文（必须精确匹配，含空白）' },
        new_string: { type: 'string', description: '替换后的新内容' },
        replace_all: {
          type: 'boolean',
          description: '是否替换所有匹配（默认 false，要求 old_string 唯一）',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async execute(_id, args): Promise<ToolResult> {
      const a = (args ?? {}) as {
        path?: string;
        old_string?: string;
        new_string?: string;
        replace_all?: boolean;
      };
      const replaceAll = a.replace_all ?? false;

      if (!a.old_string) {
        return {
          content: [createTextContent('edit_file 失败：old_string 不能为空')],
          details: { error: 'empty old_string' },
        };
      }
      if (a.new_string === undefined || a.new_string === null) {
        return {
          content: [createTextContent('edit_file 失败：new_string 不能为空')],
          details: { error: 'empty new_string' },
        };
      }

      const resolved = await resolveWithin(ctx.workspace, a.path ?? '');
      if (!resolved.ok || !resolved.abs) {
        const err = resolved.error ?? 'resolve failed';
        return {
          content: [createTextContent(`edit_file 失败：${err}`)],
          details: { error: err },
        };
      }

      let original: string;
      try {
        original = await fs.promises.readFile(resolved.abs, 'utf-8');
      } catch {
        return {
          content: [
            createTextContent(
              `edit_file 失败：文件不存在 ${a.path}（edit_file 无法创建新文件，请用 write_file）`,
            ),
          ],
          details: { error: 'not found' },
        };
      }

      const count = countOccurrences(original, a.old_string);
      if (count === 0) {
        return {
          content: [
            createTextContent(
              `edit_file 失败：未找到匹配的 old_string。请用 read_file 查看 ${a.path} 的实际内容后再修改。`,
            ),
          ],
          details: { error: 'no match' },
        };
      }
      if (count > 1 && !replaceAll) {
        return {
          content: [
            createTextContent(
              `edit_file 失败：old_string 在文件中匹配 ${count} 次（非唯一）。请补充更多上下文使其唯一，或设置 replace_all: true。`,
            ),
          ],
          details: { error: 'multiple matches', count },
        };
      }

      const updated = replaceAll
        ? original.split(a.old_string).join(a.new_string)
        : original.replace(a.old_string, a.new_string);

      // 原子写
      try {
        const tmp = `${resolved.abs}.tmp-${randomBytes(4).toString('hex')}`;
        await fs.promises.writeFile(tmp, updated, 'utf-8');
        await fs.promises.rename(tmp, resolved.abs);
      } catch (e) {
        return {
          content: [createTextContent(`edit_file 失败：写入错误 ${(e as Error).message}`)],
          details: { error: 'write error' },
        };
      }

      const replaced = replaceAll ? count : 1;
      const lineCount = updated.split('\n').length;
      return {
        content: [createTextContent(`已修改 ${a.path}（替换 ${replaced} 处，新文件 ${lineCount} 行）`)],
        details: { path: a.path, replaced, lines: lineCount },
      };
    },
  };
}
