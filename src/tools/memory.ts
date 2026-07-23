import fs from 'fs';
import path from 'path';
import { Type } from "@earendil-works/pi-ai";
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
      return createToolResult(`Memory saved: ${params.key}`);
    } catch (err) {
      return createToolError(`Failed to save memory: ${(err as Error).message}`);
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
  description = '列出所有记忆键名';
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
  description = '删除一条记忆';
  static parameters = Type.Object({
    key: Type.String({ description: '记忆的键名' }),
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

export class MemorySearchTool extends BaseTool<typeof MemorySearchTool.parameters> {
  name = 'memory_search';
  label = 'Memory Search';
  description = '搜索记忆条目，匹配 key 或 content 字段';
  static parameters = Type.Object({
    query: Type.String({ description: '搜索关键词' }),
    limit: Type.Integer({ description: '最大返回结果数', default: 10 }),
  });
  parameters = MemorySearchTool.parameters;

  async execute(toolCallId: string, params: { query: string; limit: number }) {
    try {
      const dir = path.resolve(memoryBaseDir);
      if (!fs.existsSync(dir)) {
        return createToolResult('No matching memory entries found.');
      }
      const entries = await fs.promises.readdir(dir);
      const results: string[] = [];
      const query = params.query.toLowerCase();

      for (const file of entries) {
        if (!file.endsWith('.json')) continue;
        try {
          const data = JSON.parse(await fs.promises.readFile(path.join(dir, file), 'utf-8'));
          const keyMatch = file.replace('.json', '').toLowerCase().includes(query);
          const contentMatch = (data.content || '').toLowerCase().includes(query);
          if (keyMatch || contentMatch) {
            results.push(`- ${file.replace('.json', '')}: ${String(data.content).slice(0, 100)}${String(data.content).length > 100 ? '...' : ''}`);
            if (results.length >= params.limit) break;
          }
        } catch {
          continue;
        }
      }

      if (results.length === 0) {
        return createToolResult('No matching memory entries found.');
      }
      return createToolResult(`Found ${results.length} result(s):\n${results.join('\n')}`);
    } catch (err) {
      return createToolError(`Failed to search memory: ${(err as Error).message}`);
    }
  }
}

export function getMemoryTools(): BaseTool[] {
  return [
    new MemorySaveTool(),
    new MemoryLoadTool(),
    new MemoryListTool(),
    new MemoryDeleteTool(),
    new MemorySearchTool(),
  ];
}
