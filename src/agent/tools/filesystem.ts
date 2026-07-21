import { BaseTool, ToolContext, ToolResult, createToolResult, createToolError } from './base.js';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const ReadFileSchema = z.object({
  file_path: z.string().describe('Path to the file to read'),
  offset: z.number().int().optional().describe('Starting line number (1-indexed)'),
  limit: z.number().int().optional().describe('Maximum number of lines to read'),
});

const WriteFileSchema = z.object({
  file_path: z.string().describe('Path to the file to write'),
  content: z.string().describe('Content to write to the file'),
  append: z.boolean().optional().default(false).describe('Whether to append to the file'),
});

const ListDirSchema = z.object({
  dir_path: z.string().describe('Path to the directory to list'),
  pattern: z.string().optional().describe('Glob pattern to filter files'),
});

const FileEditSchema = z.object({
  file_path: z.string().describe('Path to the file to edit'),
  old_string: z.string().describe('The exact text to replace'),
  new_string: z.string().describe('The replacement text'),
});

export class ReadFileTool extends BaseTool {
  name = 'read_file';
  description = 'Read the contents of a file from the workspace.';
  input_schema = ReadFileSchema;
  tags = ['filesystem', 'read'];

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
      const filePath = this.resolvePath(params.file_path, context.workspace);
      
      let content = await fs.readFile(filePath, 'utf-8');
      
      if (params.offset !== undefined || params.limit !== undefined) {
        const lines = content.split('\n');
        const start = params.offset ? params.offset - 1 : 0;
        const end = params.limit ? start + params.limit : undefined;
        content = lines.slice(start, end).join('\n');
      }
      
      return createToolResult(content);
    } catch (err) {
      return createToolError(`Error reading file: ${(err as Error).message}`);
    }
  }

  private resolvePath(filePath: string, workspace?: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    const base = workspace || process.cwd();
    return path.resolve(base, filePath);
  }
}

export class WriteFileTool extends BaseTool {
  name = 'write_file';
  description = 'Write content to a file in the workspace.';
  input_schema = WriteFileSchema;
  tags = ['filesystem', 'write'];

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
      const filePath = this.resolvePath(params.file_path, context.workspace);
      
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      
      if (params.append) {
        await fs.appendFile(filePath, params.content, 'utf-8');
      } else {
        await fs.writeFile(filePath, params.content, 'utf-8');
      }
      
      return createToolResult(`File written successfully: ${filePath}`);
    } catch (err) {
      return createToolError(`Error writing file: ${(err as Error).message}`);
    }
  }

  private resolvePath(filePath: string, workspace?: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    const base = workspace || process.cwd();
    return path.resolve(base, filePath);
  }
}

export class ListDirTool extends BaseTool {
  name = 'list_dir';
  description = 'List files in a directory.';
  input_schema = ListDirSchema;
  tags = ['filesystem', 'list'];

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
      const dirPath = this.resolvePath(params.dir_path, context.workspace);
      
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const result = entries.map(entry => {
        const type = entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other';
        return `${type.padEnd(5)} ${entry.name}`;
      }).join('\n');
      
      return createToolResult(result || '(empty directory)');
    } catch (err) {
      return createToolError(`Error listing directory: ${(err as Error).message}`);
    }
  }

  private resolvePath(dirPath: string, workspace?: string): string {
    if (path.isAbsolute(dirPath)) {
      return dirPath;
    }
    const base = workspace || process.cwd();
    return path.resolve(base, dirPath);
  }
}

export class EditFileTool extends BaseTool {
  name = 'edit_file';
  description = 'Edit a file by replacing a specific string with new content.';
  input_schema = FileEditSchema;
  tags = ['filesystem', 'edit'];

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
      const filePath = this.resolvePath(params.file_path, context.workspace);
      
      let content = await fs.readFile(filePath, 'utf-8');
      
      if (!content.includes(params.old_string)) {
        return createToolError(`Error: old_string not found in file. Make sure the text matches exactly.`);
      }
      
      const occurrences = content.split(params.old_string).length - 1;
      if (occurrences > 1) {
        return createToolError(`Error: old_string found ${occurrences} times in file. The old_string must be unique.`);
      }
      
      const newContent = content.replace(params.old_string, params.new_string);
      await fs.writeFile(filePath, newContent, 'utf-8');
      
      return createToolResult(`File edited successfully: ${filePath}`);
    } catch (err) {
      return createToolError(`Error editing file: ${(err as Error).message}`);
    }
  }

  private resolvePath(filePath: string, workspace?: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    const base = workspace || process.cwd();
    return path.resolve(base, filePath);
  }
}

export function getFilesystemTools(): BaseTool[] {
  return [
    new ReadFileTool(),
    new WriteFileTool(),
    new ListDirTool(),
    new EditFileTool(),
  ];
}
