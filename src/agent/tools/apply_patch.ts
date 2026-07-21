import { BaseTool, ToolContext, ToolResult, createToolResult, createToolError } from './base.js';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { FileStates } from './file_state.js';

const PatchEditSchema = z.object({
  path: z.string().describe(
    'Path to the file to edit. Relative paths resolve against the ' +
    'workspace; absolute paths and \'..\' obey the workspace access policy.',
  ),
  action: z.enum(['replace', 'add']).describe('Operation type: replace or add.'),
  old_text: z.string().optional().nullable().describe(
    'Exact text to search for in the file. Required for replace.',
  ),
  new_text: z.string().optional().nullable().describe(
    'Text to replace with or append. Required for replace and add.',
  ),
});

const ApplyPatchSchema = z.object({
  edits: z.array(PatchEditSchema).min(1).max(20).describe(
    'List of edits to apply. Each edit specifies a file and the change to make.',
  ),
  dry_run: z.boolean().optional().default(false).describe(
    'Validate and summarize the patch without writing files.',
  ),
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

function validatePatchPath(p: string): string {
  const normalized = p.trim();
  if (!normalized) {
    throw new PatchError('patch path cannot be empty');
  }
  if (normalized.includes('\0')) {
    throw new PatchError(`patch path contains a null byte: ${JSON.stringify(p)}`);
  }
  return normalized;
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
  const beforeLines = before.replace(/\r\n/g, '\n').split('\n').filter((_, i, arr) => i < arr.length - 1 || arr[i] !== '');
  const afterLines = after.replace(/\r\n/g, '\n').split('\n').filter((_, i, arr) => i < arr.length - 1 || arr[i] !== '');
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

export class ApplyPatchTool extends BaseTool {
  name = 'apply_patch';
  description = (
    'Default tool for code edits. Supports multi-file changes in a single call. ' +
    'Provide a list of structured edits, each specifying a file path, action ' +
    '(replace/add), and the exact text to change. ' +
    'Paths are resolved by the current workspace access policy. ' +
    'Set dry_run=true to validate and preview without writing files. ' +
    'Use edit_file only for small exact replacements on a single file.'
  );
  input_schema = ApplyPatchSchema;
  tags = ['filesystem', 'edit', 'patch'];

  private _fileStates: FileStates | null = null;

  setFileStates(states: FileStates): void {
    this._fileStates = states;
  }

  private resolvePath(filePath: string, workspace?: string): string {
    if (path.isAbsolute(filePath)) {
      return path.normalize(filePath);
    }
    const base = workspace || process.cwd();
    return path.resolve(base, filePath);
  }

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
      if (!params.edits || params.edits.length === 0) {
        throw new PatchError('must provide edits');
      }

      const writes: Map<string, string> = new Map();
      const summaries: PatchSummary[] = [];

      for (const edit of params.edits) {
        const rawPath = edit.path;
        const filePath = validatePatchPath(rawPath);
        const action = edit.action;
        const source = this.resolvePath(filePath, context.workspace);

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
              const raw = await fs.readFile(source);
              content = raw.toString('utf-8');
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
              const raw = await fs.readFile(source);
              content = raw.toString('utf-8');
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

      const backups: Map<string, Buffer | null> = new Map();
      for (const filePath of writes.keys()) {
        try {
          const data = await fs.readFile(filePath);
          backups.set(filePath, data);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            backups.set(filePath, null);
          } else {
            throw e;
          }
        }
      }

      try {
        for (const [filePath, content] of writes.entries()) {
          const dir = path.dirname(filePath);
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(filePath, content, 'utf-8');
        }
      } catch (e) {
        for (const [filePath, data] of backups.entries()) {
          if (data === null) {
            try {
              await fs.unlink(filePath);
            } catch {
              // ignore
            }
          } else {
            try {
              const dir = path.dirname(filePath);
              await fs.mkdir(dir, { recursive: true });
              await fs.writeFile(filePath, data);
            } catch {
              // ignore
            }
          }
        }
        throw e;
      }

      for (const filePath of writes.keys()) {
        if (this._fileStates) {
          this._fileStates.recordWrite(filePath);
        }
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
