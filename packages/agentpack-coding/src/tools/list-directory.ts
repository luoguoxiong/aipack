/**
 * list_directory 工具：列出目录内容（不递归）。
 *
 * 区分文件/目录，目录优先 + 名称排序；默认隐藏 dotfiles。
 */

import fs from 'fs';
import { createTextContent } from 'agentpack';
import type { Tool, ToolResult } from 'agentpack';
import type { CodingToolContext } from '../types';
import { resolveWithin } from '../utils/path';

export function createListDirectoryTool(ctx: CodingToolContext): Tool {
  return {
    name: 'list_directory',
    // 框架级 PermissionPolicy 能力声明：读取 workspace 内目录
    permissions: ['fs:read'],
    description:
      '列出目录内容（不递归）。返回格式区分文件与目录，按名称排序。' +
      'path 默认为 workspace 根目录。默认隐藏点开头文件。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于 workspace 的目录路径（默认 workspace 根）' },
      },
    },
    async execute(_id, args): Promise<ToolResult> {
      const a = (args ?? {}) as { path?: string };
      const rel = a.path ?? '.';
      const resolved = await resolveWithin(ctx.workspace, rel);
      if (!resolved.ok || !resolved.abs) {
        const err = resolved.error ?? 'resolve failed';
        return {
          content: [createTextContent(`list_directory 失败：${err}`)],
          details: { error: err },
        };
      }

      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(resolved.abs, { withFileTypes: true });
      } catch (e) {
        const err = (e as Error).message;
        return {
          content: [createTextContent(`list_directory 失败：${err}`)],
          details: { error: 'read error' },
        };
      }

      const visible = entries.filter((e) => !e.name.startsWith('.'));
      visible.sort((x, y) => {
        const xd = x.isDirectory();
        const yd = y.isDirectory();
        if (xd !== yd) return xd ? -1 : 1;
        return x.name.localeCompare(y.name);
      });

      if (visible.length === 0) {
        return {
          content: [createTextContent(`${rel}（空目录）`)],
          details: { count: 0 },
        };
      }

      const lines = visible.map((e) => {
        const isDir = e.isDirectory();
        return `${isDir ? '📁' : '📄'} ${e.name}${isDir ? '/' : ''}`;
      });
      return {
        content: [createTextContent(`${rel}（${visible.length} 项）\n${lines.join('\n')}`)],
        details: {
          count: visible.length,
          entries: visible.map((e) => ({ name: e.name, isDirectory: e.isDirectory() })),
        },
      };
    },
  };
}
