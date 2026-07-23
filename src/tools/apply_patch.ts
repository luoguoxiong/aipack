import fs from 'fs';
import path from 'path';
import { Type } from "@earendil-works/pi-ai";
import { BaseTool, createToolResult, createToolError } from './base';

const PatchEditSchema = Type.Object({
  path: Type.String({ description: '要编辑的文件路径' }),
  action: Type.Enum({ replace: 'replace', add: 'add' }, { description: '操作类型: replace 或 add' }),
  old_text: Type.Optional(Type.String({ description: '要搜索的精确文本（replace 操作必填）' })),
  new_text: Type.Optional(Type.String({ description: '替换或追加的新文本（replace/add 操作必填）' })),
});

const ApplyPatchSchema = Type.Object({
  edits: Type.Array(PatchEditSchema, { description: '要应用的编辑列表（最多 20 个）', minItems: 1, maxItems: 20 }),
  dry_run: Type.Optional(Type.Boolean({ description: '预览模式，不实际写入文件', default: false })),
});

interface PatchSummary {
  action: string;
  path: string;
  added: number;
  deleted: number;
}

class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchError';
  }
}

function linesToText(lines: string[]): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + '\n';
}

function textLineCount(text: string): number {
  if (!text) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function lineDiffStats(before: string, after: string): { added: number; deleted: number } {
  const beforeLines = before.replace(/\r\n/g, '\n').split('\n');
  const afterLines = after.replace(/\r\n/g, '\n').split('\n');
  // Remove trailing empty line if present
  if (beforeLines[beforeLines.length - 1] === '') beforeLines.pop();
  if (afterLines[afterLines.length - 1] === '') afterLines.pop();
  const beforeLen = beforeLines.length;
  const afterLen = afterLines.length;
  const maxLen = Math.max(beforeLen, afterLen);
  let added = 0;
  let deleted = 0;
  for (let i = 0; i < maxLen; i++) {
    if (i >= beforeLen) {
      added++;
    } else if (i >= afterLen) {
      deleted++;
    } else if (beforeLines[i] !== afterLines[i]) {
      added++;
      deleted++;
    }
  }
  return { added, deleted };
}

function appendText(content: string, addition: string): string {
  let base = content.replace(/\r\n/g, '\n');
  let extra = addition.replace(/\r\n/g, '\n');
  if (base && extra && !base.endsWith('\n') && !extra.startsWith('\n')) {
    base += '\n';
  }
  let combined = base + extra;
  if (combined && !combined.endsWith('\n')) {
    combined += '\n';
  }
  return combined;
}

function formatSummary(summary: PatchSummary): string {
  let stats = '';
  if (summary.added || summary.deleted) {
    stats = ` (+${summary.added}/-${summary.deleted})`;
  }
  return `- ${summary.action} ${summary.path}${stats}`;
}

export class ApplyPatchTool extends BaseTool<typeof ApplyPatchTool.parameters> {
  name = 'apply_patch';
  label = 'Apply Patch';
  description = (
    '对代码文件进行结构化编辑的默认工具。支持在单次调用中修改多个文件。' +
    '提供 edits 列表，每个 edit 指定文件路径、操作（replace/add）和精确文本。' +
    '设置 dry_run=true 可预览而不实际写入。失败时自动回滚所有已写入的文件。'
  );
  static parameters = ApplyPatchSchema;
  parameters = ApplyPatchTool.parameters;

  private resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) {
      return path.normalize(filePath);
    }
    return path.resolve(process.cwd(), filePath);
  }

  async execute(toolCallId: string, params: { edits: { path: string; action: 'replace' | 'add'; old_text?: string; new_text?: string }[]; dry_run?: boolean }) {
    try {
      if (!params.edits || params.edits.length === 0) {
        throw new PatchError('must provide edits');
      }

      const writes: Map<string, string> = new Map();
      const summaries: PatchSummary[] = [];

      for (const edit of params.edits) {
        const filePath = edit.path;
        const action = edit.action;
        const source = this.resolvePath(filePath);

        if (action === 'add') {
          const newText = edit.new_text;
          if (newText === null || newText === undefined) {
            throw new PatchError(`new_text required for add: ${filePath}`);
          }

          let content: string;
          let exists: boolean;

          if (writes.has(source)) {
            content = writes.get(source)!;
            exists = true;
          } else {
            try {
              content = await fs.promises.readFile(source, 'utf-8');
              exists = true;
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
                content = '';
                exists = false;
              } else {
                throw e;
              }
            }
          }

          let actionName: string;
          let added: number;
          let deleted: number;

          if (exists) {
            const usesCrlf = content.includes('\r\n');
            const newNorm = appendText(content, newText);
            const finalContent = usesCrlf ? newNorm.replace(/\n/g, '\r\n') : newNorm;
            writes.set(source, finalContent);
            const stats = lineDiffStats(content, finalContent);
            added = stats.added;
            deleted = stats.deleted;
            actionName = 'update';
          } else {
            let newNorm = newText.replace(/\r\n/g, '\n');
            if (newNorm && !newNorm.endsWith('\n')) {
              newNorm += '\n';
            }
            writes.set(source, newNorm);
            added = textLineCount(newNorm);
            deleted = 0;
            actionName = 'add';
          }

          summaries.push({ action: actionName, path: filePath, added, deleted });
        } else if (action === 'replace') {
          const oldText = edit.old_text || '';
          if (!oldText) {
            throw new PatchError(`old_text required for replace: ${filePath}`);
          }
          const newText = edit.new_text;
          if (newText === null || newText === undefined) {
            throw new PatchError(`new_text required for replace: ${filePath}`);
          }

          let content: string;
          if (writes.has(source)) {
            content = writes.get(source)!;
          } else {
            try {
              content = await fs.promises.readFile(source, 'utf-8');
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new PatchError(`file to update does not exist: ${filePath}`);
              }
              throw e;
            }
          }

          const usesCrlf = content.includes('\r\n');
          const normContent = content.replace(/\r\n/g, '\n');
          const normOld = oldText.replace(/\r\n/g, '\n');

          const pos = normContent.indexOf(normOld);
          if (pos < 0) {
            throw new PatchError(`old_text not found in ${filePath}`);
          }
          if (normContent.indexOf(normOld, pos + 1) >= 0) {
            throw new PatchError(`old_text appears multiple times in ${filePath}`);
          }

          let newNorm = (
            normContent.slice(0, pos) +
            newText.replace(/\r\n/g, '\n') +
            normContent.slice(pos + normOld.length)
          );
          if (newNorm && !newNorm.endsWith('\n')) {
            newNorm += '\n';
          }
          const finalContent = usesCrlf ? newNorm.replace(/\n/g, '\r\n') : newNorm;

          writes.set(source, finalContent);
          const stats = lineDiffStats(content, finalContent);
          summaries.push({
            action: 'update',
            path: filePath,
            added: stats.added,
            deleted: stats.deleted,
          });
        } else {
          throw new PatchError(`unknown action: ${action}`);
        }
      }

      if (params.dry_run) {
        return createToolResult(
          'Patch dry-run succeeded:\n' + summaries.map(formatSummary).join('\n'),
        );
      }

      // Create backups before writing
      const backups: Map<string, Buffer | null> = new Map();
      for (const filePath of writes.keys()) {
        try {
          const data = await fs.promises.readFile(filePath);
          backups.set(filePath, data);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            backups.set(filePath, null);
          } else {
            throw e;
          }
        }
      }

      // Write all files
      try {
        for (const [filePath, content] of writes.entries()) {
          const dir = path.dirname(filePath);
          await fs.promises.mkdir(dir, { recursive: true });
          await fs.promises.writeFile(filePath, content, 'utf-8');
        }
      } catch (e) {
        // Rollback on failure
        for (const [filePath, data] of backups.entries()) {
          if (data === null) {
            try { await fs.promises.unlink(filePath); } catch { /* ignore */ }
          } else {
            try {
              const dir = path.dirname(filePath);
              await fs.promises.mkdir(dir, { recursive: true });
              await fs.promises.writeFile(filePath, data);
            } catch { /* ignore */ }
          }
        }
        throw e;
      }

      return createToolResult(
        'Patch applied:\n' + summaries.map(formatSummary).join('\n'),
      );
    } catch (e) {
      if (e instanceof PatchError) {
        return createToolError(`Error applying patch: ${e.message}`);
      }
      return createToolError(`Error applying patch: ${(e as Error).message}`);
    }
  }
}

export function getApplyPatchTools(): BaseTool[] {
  return [new ApplyPatchTool()];
}
