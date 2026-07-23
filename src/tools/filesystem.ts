import fs from 'fs';
import path from 'path';
import { Type } from "@earendil-works/pi-ai";
import { BaseTool, createToolResult, createToolError } from './base';

export class ReadFileTool extends BaseTool<typeof ReadFileTool.parameters> {
  name = 'read_file';
  label = 'Read File';
  description = 'Read the contents of a file';
  static parameters = Type.Object({
    file_path: Type.String({ description: 'The path to the file' }),
  });
  parameters = ReadFileTool.parameters;

  async execute(toolCallId: string, params: { file_path: string }) {
    try {
      const content = await fs.promises.readFile(params.file_path, 'utf-8');
      return createToolResult(content);
    } catch (err) {
      return createToolError(`Failed to read file: ${(err as Error).message}`);
    }
  }
}

export class WriteFileTool extends BaseTool<typeof WriteFileTool.parameters> {
  name = 'write_file';
  label = 'Write File';
  description = 'Write content to a file';
  static parameters = Type.Object({
    file_path: Type.String({ description: 'The path to the file' }),
    content: Type.String({ description: 'The content to write' }),
    append: Type.Boolean({ description: 'Append to file instead of overwriting', default: false }),
  });
  parameters = WriteFileTool.parameters;

  async execute(toolCallId: string, params: { file_path: string; content: string; append: boolean }) {
    try {
      const dir = path.dirname(params.file_path);
      if (dir && !fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
      }
      await fs.promises.writeFile(params.file_path, params.content, { flag: params.append ? 'a' : 'w' });
      return createToolResult(`File written successfully: ${params.file_path}`);
    } catch (err) {
      return createToolError(`Failed to write file: ${(err as Error).message}`);
    }
  }
}

export class ListDirectoryTool extends BaseTool<typeof ListDirectoryTool.parameters> {
  name = 'list_directory';
  label = 'List Directory';
  description = 'List files and directories in a directory';
  static parameters = Type.Object({
    path: Type.String({ description: 'The path to the directory', default: '.' }),
  });
  parameters = ListDirectoryTool.parameters;

  async execute(toolCallId: string, params: { path: string }) {
    try {
      const entries = await fs.promises.readdir(params.path, { withFileTypes: true });
      const result = entries.map(entry => {
        const type = entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other';
        return `${type}: ${entry.name}`;
      }).join('\n');
      return createToolResult(result);
    } catch (err) {
      return createToolError(`Failed to list directory: ${(err as Error).message}`);
    }
  }
}

export class CreateDirectoryTool extends BaseTool<typeof CreateDirectoryTool.parameters> {
  name = 'create_directory';
  label = 'Create Directory';
  description = 'Create a new directory';
  static parameters = Type.Object({
    path: Type.String({ description: 'The path to the directory' }),
  });
  parameters = CreateDirectoryTool.parameters;

  async execute(toolCallId: string, params: { path: string }) {
    try {
      await fs.promises.mkdir(params.path, { recursive: true });
      return createToolResult(`Directory created: ${params.path}`);
    } catch (err) {
      return createToolError(`Failed to create directory: ${(err as Error).message}`);
    }
  }
}

export class DeleteFileTool extends BaseTool<typeof DeleteFileTool.parameters> {
  name = 'delete_file';
  label = 'Delete File';
  description = 'Delete a file';
  static parameters = Type.Object({
    file_path: Type.String({ description: 'The path to the file' }),
  });
  parameters = DeleteFileTool.parameters;

  async execute(toolCallId: string, params: { file_path: string }) {
    try {
      await fs.promises.unlink(params.file_path);
      return createToolResult(`File deleted: ${params.file_path}`);
    } catch (err) {
      return createToolError(`Failed to delete file: ${(err as Error).message}`);
    }
  }
}

export class DeleteDirectoryTool extends BaseTool<typeof DeleteDirectoryTool.parameters> {
  name = 'delete_directory';
  label = 'Delete Directory';
  description = 'Delete a directory and all its contents';
  static parameters = Type.Object({
    path: Type.String({ description: 'The path to the directory' }),
  });
  parameters = DeleteDirectoryTool.parameters;

  async execute(toolCallId: string, params: { path: string }) {
    try {
      await fs.promises.rm(params.path, { recursive: true, force: true });
      return createToolResult(`Directory deleted: ${params.path}`);
    } catch (err) {
      return createToolError(`Failed to delete directory: ${(err as Error).message}`);
    }
  }
}

export class RenameFileTool extends BaseTool<typeof RenameFileTool.parameters> {
  name = 'rename_file';
  label = 'Rename File';
  description = 'Rename or move a file';
  static parameters = Type.Object({
    old_path: Type.String({ description: 'The current path' }),
    new_path: Type.String({ description: 'The new path' }),
  });
  parameters = RenameFileTool.parameters;

  async execute(toolCallId: string, params: { old_path: string; new_path: string }) {
    try {
      await fs.promises.rename(params.old_path, params.new_path);
      return createToolResult(`File renamed: ${params.old_path} -> ${params.new_path}`);
    } catch (err) {
      return createToolError(`Failed to rename file: ${(err as Error).message}`);
    }
  }
}

export function getFilesystemTools(): BaseTool[] {
  return [
    new ReadFileTool(),
    new WriteFileTool(),
    new ListDirectoryTool(),
    new CreateDirectoryTool(),
    new DeleteFileTool(),
    new DeleteDirectoryTool(),
    new RenameFileTool(),
  ];
}
