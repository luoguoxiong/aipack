import fs from 'fs';
import path from 'path';
import { Type } from "../pi/ai";
import { BaseTool, createToolResult, createToolError } from './base';

let memoryBaseDir = '.kobot/memory';

export function setMemoryBaseDir(dir: string): void {
  memoryBaseDir = dir;
}

export class MemorySaveTool extends BaseTool<typeof MemorySaveTool.parameters> {
  name = 'memory_save';
  label = 'Memory Save';
  description = '保存一条记忆';
  static parameters = Type.Object({
    key: Type.String({ description: '记忆的键名' }),
    content: Type.String({ description: '要保存的内容' }),
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
      return createToolResult(`记忆已保存：${params.key}`);
    } catch (err) {
      return createToolError(`保存记忆失败：${(err as Error).message}`);
    }
  }
}

export class MemoryLoadTool extends BaseTool<typeof MemoryLoadTool.parameters> {
  name = 'memory_load';
  label = 'Memory Load';
  description = '加载一条记忆';
  static parameters = Type.Object({
    key: Type.String({ description: '记忆的键名' }),
  });
  parameters = MemoryLoadTool.parameters;

  async execute(toolCallId: string, params: { key: string }) {
    try {
      const filePath = path.join(path.resolve(memoryBaseDir), `${params.key}.json`);
      if (!fs.existsSync(filePath)) {
        return createToolError(`记忆未找到: ${params.key}`);
      }
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
      return createToolResult(data.content);
    } catch (err) {
      return createToolError(`加载记忆失败：${(err as Error).message}`);
    }
  }
}

export class MemoryListTool extends BaseTool<typeof MemoryListTool.parameters> {
  name = 'memory_list';
  label = 'Memory List';
  description = '列出所有记忆键名';
  static parameters = Type.Object({});
  parameters = MemoryListTool.parameters;

  async execute(toolCallId: string) {
    try {
      const dir = path.resolve(memoryBaseDir);
      if (!fs.existsSync(dir)) {
        return createToolResult('未找到记忆');
      }
      const entries = await fs.promises.readdir(dir);
      const keys = entries
        .filter(e => e.endsWith('.json'))
        .map(e => e.replace('.json', ''));
      return createToolResult(keys.join('\n') || '未找到记忆');
    } catch (err) {
      return createToolError(`列出记忆失败：${(err as Error).message}`);
    }
  }
}

export class MemoryDeleteTool extends BaseTool<typeof MemoryDeleteTool.parameters> {
  name = 'memory_delete';
  label = 'Memory Delete';
  description = '删除一条记忆';
  static parameters = Type.Object({
    key: Type.String({ description: '记忆的键名' }),
  });
  parameters = MemoryDeleteTool.parameters;

  async execute(toolCallId: string, params: { key: string }) {
    try {
      const filePath = path.join(path.resolve(memoryBaseDir), `${params.key}.json`);
      if (!fs.existsSync(filePath)) {
        return createToolError(`记忆未找到: ${params.key}`);
      }
      await fs.promises.unlink(filePath);
      return createToolResult(`记忆已删除: ${params.key}`);
    } catch (err) {
      return createToolError(`删除记忆失败: ${(err as Error).message}`);
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
