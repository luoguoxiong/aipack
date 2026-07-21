import { BaseTool, ToolContext, ToolResult, createToolResult, createToolError } from './base.js';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { getProjectConfigDir } from '../../config/paths.js';

const MemoryStoreSchema = z.object({
  key: z.string().describe('The key to store the memory under'),
  value: z.string().describe('The value to store'),
});

const MemoryRecallSchema = z.object({
  key: z.string().describe('The key to recall from memory'),
});

const MemorySearchSchema = z.object({
  query: z.string().describe('Search query for memory entries'),
  limit: z.number().int().optional().default(10).describe('Maximum number of results'),
});

const MemoryListSchema = z.object({
  prefix: z.string().optional().describe('Only list keys with this prefix'),
  limit: z.number().int().optional().default(50).describe('Maximum number of keys to list'),
});

const MemoryDeleteSchema = z.object({
  key: z.string().describe('The key to delete from memory'),
});

export class MemoryStoreTool extends BaseTool {
  name = 'memory_store';
  description = 'Store a key-value pair in long-term memory.';
  input_schema = MemoryStoreSchema;
  tags = ['memory'];

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
      const memoryDir = this.getMemoryDir(context);
      await fs.mkdir(memoryDir, { recursive: true });

      const safeKey = this.sanitizeKey(params.key);
      const filePath = path.join(memoryDir, `${safeKey}.json`);
      
      const entry = {
        key: params.key,
        value: params.value,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      try {
        const existing = JSON.parse(await fs.readFile(filePath, 'utf-8'));
        entry.created_at = existing.created_at;
      } catch {
        // File doesn't exist yet
      }

      await fs.writeFile(filePath, JSON.stringify(entry, null, 2), 'utf-8');
      return createToolResult(`Memory stored: ${params.key}`);
    } catch (err) {
      return createToolError(`Failed to store memory: ${(err as Error).message}`);
    }
  }

  private getMemoryDir(context: ToolContext): string {
    const workspace = context.workspace || getProjectConfigDir();
    return path.join(workspace, 'memory');
  }

  private sanitizeKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9_\-]/g, '_').toLowerCase();
  }
}

export class MemoryRecallTool extends BaseTool {
  name = 'memory_recall';
  description = 'Recall a value from long-term memory by key.';
  input_schema = MemoryRecallSchema;
  tags = ['memory'];

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
      const memoryDir = this.getMemoryDir(context);
      const safeKey = this.sanitizeKey(params.key);
      const filePath = path.join(memoryDir, `${safeKey}.json`);

      try {
        const data = JSON.parse(await fs.readFile(filePath, 'utf-8'));
        return createToolResult(`Key: ${data.key}\nValue: ${data.value}\nUpdated: ${data.updated_at}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return createToolError(`Memory key not found: ${params.key}`);
        }
        throw err;
      }
    } catch (err) {
      return createToolError(`Failed to recall memory: ${(err as Error).message}`);
    }
  }

  private getMemoryDir(context: ToolContext): string {
    const workspace = context.workspace || getProjectConfigDir();
    return path.join(workspace, 'memory');
  }

  private sanitizeKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9_\-]/g, '_').toLowerCase();
  }
}

export class MemorySearchTool extends BaseTool {
  name = 'memory_search';
  description = 'Search memory entries by query string.';
  input_schema = MemorySearchSchema;
  tags = ['memory'];

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
      const memoryDir = this.getMemoryDir(context);

      try {
        const files = await fs.readdir(memoryDir);
        const results: string[] = [];
        const query = params.query.toLowerCase();

        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          try {
            const data = JSON.parse(await fs.readFile(path.join(memoryDir, file), 'utf-8'));
            const keyMatch = data.key?.toLowerCase().includes(query);
            const valueMatch = data.value?.toLowerCase().includes(query);
            if (keyMatch || valueMatch) {
              results.push(`- ${data.key}: ${String(data.value).slice(0, 100)}${String(data.value).length > 100 ? '...' : ''}`);
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
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return createToolResult('No memory entries found.');
        }
        throw err;
      }
    } catch (err) {
      return createToolError(`Failed to search memory: ${(err as Error).message}`);
    }
  }

  private getMemoryDir(context: ToolContext): string {
    const workspace = context.workspace || getProjectConfigDir();
    return path.join(workspace, 'memory');
  }
}

export class MemoryListTool extends BaseTool {
  name = 'memory_list';
  description = 'List all memory keys.';
  input_schema = MemoryListSchema;
  tags = ['memory'];

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
      const memoryDir = this.getMemoryDir(context);

      try {
        const files = await fs.readdir(memoryDir);
        const keys: string[] = [];

        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          try {
            const data = JSON.parse(await fs.readFile(path.join(memoryDir, file), 'utf-8'));
            if (params.prefix && !data.key?.startsWith(params.prefix)) continue;
            keys.push(data.key);
            if (keys.length >= params.limit) break;
          } catch {
            continue;
          }
        }

        if (keys.length === 0) {
          return createToolResult('No memory entries found.');
        }
        return createToolResult(`Memory keys (${keys.length}):\n${keys.map(k => `- ${k}`).join('\n')}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return createToolResult('No memory entries found.');
        }
        throw err;
      }
    } catch (err) {
      return createToolError(`Failed to list memory: ${(err as Error).message}`);
    }
  }

  private getMemoryDir(context: ToolContext): string {
    const workspace = context.workspace || getProjectConfigDir();
    return path.join(workspace, 'memory');
  }
}

export class MemoryDeleteTool extends BaseTool {
  name = 'memory_delete';
  description = 'Delete a memory entry by key.';
  input_schema = MemoryDeleteSchema;
  tags = ['memory'];

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
      const memoryDir = this.getMemoryDir(context);
      const safeKey = params.key.replace(/[^a-zA-Z0-9_\-]/g, '_').toLowerCase();
      const filePath = path.join(memoryDir, `${safeKey}.json`);

      try {
        await fs.unlink(filePath);
        return createToolResult(`Memory deleted: ${params.key}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return createToolError(`Memory key not found: ${params.key}`);
        }
        throw err;
      }
    } catch (err) {
      return createToolError(`Failed to delete memory: ${(err as Error).message}`);
    }
  }

  private getMemoryDir(context: ToolContext): string {
    const workspace = context.workspace || getProjectConfigDir();
    return path.join(workspace, 'memory');
  }
}

export function getMemoryTools(): BaseTool[] {
  return [
    new MemoryStoreTool(),
    new MemoryRecallTool(),
    new MemorySearchTool(),
    new MemoryListTool(),
    new MemoryDeleteTool(),
  ];
}
