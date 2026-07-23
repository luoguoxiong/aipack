import fs from 'fs';
import path from 'path';
import { Type } from "@earendil-works/pi-ai";
import { BaseTool, createToolResult, createToolError } from './base';

let memoryBaseDir = '.nanobot/memory';

export function setMemoryBaseDir(dir: string): void {
  memoryBaseDir = dir;
}

export class MemorySaveTool extends BaseTool<typeof MemorySaveTool.parameters> {
  name = 'memory_save';
  label = 'Memory Save';
  description = 'Save a memory entry';
  static parameters = Type.Object({
    key: Type.String({ description: 'The key for the memory' }),
    content: Type.String({ description: 'The content to save' }),
  });
  parameters = MemorySaveTool.parameters;

  async execute(toolCallId: string, params: { key: string; content: string }) {
    try {
      const dir = path.resolve(memoryBaseDir);
      if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
      }
      const filePath = path.join(dir, `${params.key}.json`);
      await fs.promises.writeFile(filePath, JSON.stringify({ content: params.content, timestamp: Date.now() }), 'utf-8');
      return createToolResult(`Memory saved: ${params.key}`);
    } catch (err) {
      return createToolError(`Failed to save memory: ${(err as Error).message}`);
    }
  }
}

export class MemoryLoadTool extends BaseTool<typeof MemoryLoadTool.parameters> {
  name = 'memory_load';
  label = 'Memory Load';
  description = 'Load a memory entry';
  static parameters = Type.Object({
    key: Type.String({ description: 'The key for the memory' }),
  });
  parameters = MemoryLoadTool.parameters;

  async execute(toolCallId: string, params: { key: string }) {
    try {
      const filePath = path.join(path.resolve(memoryBaseDir), `${params.key}.json`);
      if (!fs.existsSync(filePath)) {
        return createToolError(`Memory not found: ${params.key}`);
      }
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
      return createToolResult(data.content);
    } catch (err) {
      return createToolError(`Failed to load memory: ${(err as Error).message}`);
    }
  }
}

export class MemoryListTool extends BaseTool<typeof MemoryListTool.parameters> {
  name = 'memory_list';
  label = 'Memory List';
  description = 'List all memory keys';
  static parameters = Type.Object({});
  parameters = MemoryListTool.parameters;

  async execute(toolCallId: string) {
    try {
      const dir = path.resolve(memoryBaseDir);
      if (!fs.existsSync(dir)) {
        return createToolResult('No memories found');
      }
      const entries = await fs.promises.readdir(dir);
      const keys = entries
        .filter(e => e.endsWith('.json'))
        .map(e => e.replace('.json', ''));
      return createToolResult(keys.join('\n') || 'No memories found');
    } catch (err) {
      return createToolError(`Failed to list memories: ${(err as Error).message}`);
    }
  }
}

export class MemoryDeleteTool extends BaseTool<typeof MemoryDeleteTool.parameters> {
  name = 'memory_delete';
  label = 'Memory Delete';
  description = 'Delete a memory entry';
  static parameters = Type.Object({
    key: Type.String({ description: 'The key for the memory' }),
  });
  parameters = MemoryDeleteTool.parameters;

  async execute(toolCallId: string, params: { key: string }) {
    try {
      const filePath = path.join(path.resolve(memoryBaseDir), `${params.key}.json`);
      if (!fs.existsSync(filePath)) {
        return createToolError(`Memory not found: ${params.key}`);
      }
      await fs.promises.unlink(filePath);
      return createToolResult(`Memory deleted: ${params.key}`);
    } catch (err) {
      return createToolError(`Failed to delete memory: ${(err as Error).message}`);
    }
  }
}

export function getMemoryTools(): BaseTool[] {
  return [
    new MemorySaveTool(),
    new MemoryLoadTool(),
    new MemoryListTool(),
    new MemoryDeleteTool(),
  ];
}
