/**
 * apps/ai_office_agent/src/tools/file-tools.ts
 *
 * 工作区文件级工具:
 *   - file_list    列出工作区内文件(相对路径 + 大小),跳过 .trash/.bak/.aipack
 *   - file_delete  删除文件:移入 .trash 回收站(带时间戳),不做硬删除,可恢复
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Tool } from '@aipack/agent';
import type { Workspace } from './workspace.js';
import { resolveInWorkspace, assertExists } from './workspace.js';

const MAX_DEPTH = 3;

/** 递归列出工作区文件(跳过隐藏目录/回收站/备份) */
async function walkFiles(root: string, rel: string, depth: number, out: { path: string; size: number }[]): Promise<void> {
  if (depth > MAX_DEPTH) return;
  const dir = path.join(root, rel);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.endsWith('.bak')) continue; // 隐藏/.aipack/.trash + 备份
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    const abs = path.join(root, relPath);
    if (e.isDirectory()) {
      await walkFiles(root, relPath, depth + 1, out);
    } else if (e.isFile()) {
      const stat = await fs.stat(abs);
      out.push({ path: relPath, size: stat.size });
    }
  }
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 列出工作区文件(跳过隐藏/.trash/.bak),供 file_list 工具与 server 文件面板复用 */
export async function listWorkspaceFiles(ws: Workspace): Promise<{ path: string; size: number }[]> {
  const files: { path: string; size: number }[] = [];
  await walkFiles(ws.root, '', 0, files);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// ─── 查:file_list ────────────────────────────────────────────────

export function createFileListTool(ws: Workspace): Tool {
  return {
    name: 'file_list',
    description:
      '列出工作区内的文件(相对路径 + 大小,最多 3 层目录)。' +
      '当需要确认已生成哪些文件、或寻找某个文件时调用。',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '可选,只列某个子目录(相对工作区,如 "docs")' },
      },
    },
    permissions: ['fs:read'],
    async execute(_toolCallId, args) {
      const { dir } = (args ?? {}) as { dir?: string };
      try {
        const rel = dir ? resolveInWorkspace(ws.root, dir) : ws.root;
        // 仅当 dir 指定且为子目录时限制;否则列整个工作区
        const root = dir ? rel : ws.root;
        const base = dir ? path.relative(ws.root, root) : '';
        const files: { path: string; size: number }[] = [];
        await walkFiles(root, '', 0, files);
        if (!files.length) {
          return { content: [{ type: 'text', text: '工作区暂无文件(生成的文档会出现在这里)' }], details: { files: [] } };
        }
        const lines = files
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((f) => `${base ? `${base}/` : ''}${f.path} (${formatSize(f.size)})`);
        return {
          content: [{ type: 'text', text: `工作区文件(${files.length}):\n${lines.join('\n')}` }],
          details: { files: files.map((f) => ({ path: `${base ? `${base}/` : ''}${f.path}`, size: f.size })) },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `[file_list] ${(err as Error).message}` }],
          details: { error: (err as Error).message },
        };
      }
    },
  };
}

// ─── 删:file_delete(移入回收站)───────────────────────────────────

export function createFileDeleteTool(ws: Workspace): Tool {
  return {
    name: 'file_delete',
    description:
      '删除工作区文件:文件会被移入 .trash 回收站(带时间戳),而不是物理删除。' +
      '删除前请先向用户确认文件路径与意图。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '要删除的文件路径(相对工作区)' },
      },
      required: ['filePath'],
    },
    permissions: ['fs:write'],
    async execute(_toolCallId, args) {
      const { filePath } = (args ?? {}) as { filePath?: string };
      try {
        if (!filePath) throw new Error('缺少 filePath 参数');
        const abs = resolveInWorkspace(ws.root, filePath);
        await assertExists(abs);
        if (filePath.startsWith('.trash')) throw new Error('不能删除回收站内的文件');

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const trashPath = path.join(ws.root, '.trash', `${path.basename(abs)}.${stamp}`);
        await fs.rename(abs, trashPath);
        return {
          content: [{ type: 'text', text: `已删除 ${filePath}(移入回收站 .trash/)` }],
          details: { filePath, action: 'delete', trashPath: path.relative(ws.root, trashPath) },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `[file_delete] ${(err as Error).message}` }],
          details: { error: (err as Error).message },
        };
      }
    },
  };
}

/** 汇总导出文件工具集 */
export function createFileTools(ws: Workspace): Tool[] {
  return [createFileListTool(ws), createFileDeleteTool(ws)];
}
