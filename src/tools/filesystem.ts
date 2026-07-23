import fs from 'fs';
import path from 'path';
import { Type } from "@earendil-works/pi-ai";
import { BaseTool, createToolResult, createToolError } from './base';

export class ReadFileTool extends BaseTool<typeof ReadFileTool.parameters> {
  name = 'read_file';
  label = 'Read File';
  description = '读取文件内容';
  static parameters = Type.Object({
    file_path: Type.String({ description: '文件路径' }),
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
  description = '写入内容到文件';
  static parameters = Type.Object({
    file_path: Type.String({ description: '文件路径' }),
    content: Type.String({ description: '要写入的内容' }),
    append: Type.Boolean({ description: '追加到文件而非覆盖', default: false }),
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
  description = '列出目录中的文件和目录';
  static parameters = Type.Object({
    path: Type.String({ description: '目录路径', default: '.' }),
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
  description = '创建新目录';
  static parameters = Type.Object({
    path: Type.String({ description: '目录路径' }),
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
  description = '删除文件';
  static parameters = Type.Object({
    file_path: Type.String({ description: '文件路径' }),
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
  description = '删除目录及其所有内容';
  static parameters = Type.Object({
    path: Type.String({ description: '目录路径' }),
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
  description = '重命名或移动文件';
  static parameters = Type.Object({
    old_path: Type.String({ description: '当前路径' }),
    new_path: Type.String({ description: '新路径' }),
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
