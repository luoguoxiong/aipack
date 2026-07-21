import { BaseTool, ToolContext, ToolResult, isToolErrorResult } from './base.js';
import { ProviderToolDefinition } from '../../providers/base.js';
import { logger } from '../../utils/logger.js';
import { getFilesystemTools } from './filesystem.js';
import { getShellTools } from './shell.js';
import { getWebTools } from './web.js';
import { getMemoryTools } from './memory.js';
import { getCronTools } from './cron.js';
import { getUtilityTools } from './utilities.js';
import { getSearchTools } from './search.js';
import { generateId, truncateText } from '../../utils/helpers.js';

export interface ToolExecutionRecord {
  tool_name: string;
  tool_call_id: string;
  arguments: unknown;
  result: ToolResult;
  duration_ms: number;
}

export class ToolRegistry {
  private tools: Map<string, BaseTool> = new Map();
  private executionHistory: ToolExecutionRecord[] = [];

  register(tool: BaseTool): void {
    this.tools.set(tool.name, tool);
    logger.debug({ tool: tool.name }, 'Registered tool');
  }

  registerMany(tools: BaseTool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  get(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): string[] {
    return Array.from(this.tools.keys());
  }

  getToolDefinitions(): ProviderToolDefinition[] {
    const defs: ProviderToolDefinition[] = [];
    for (const tool of this.tools.values()) {
      const def = tool.getDefinition();
      defs.push({
        name: def.name,
        description: def.description,
        input_schema: tool.toProviderTool().function.parameters,
      });
    }
    return defs;
  }

  async executeTool(
    toolName: string,
    toolCallId: string,
    args: unknown,
    context: ToolContext,
    options?: { maxResultChars?: number },
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        content: `Error: Unknown tool "${toolName}"`,
        is_error: true,
      };
    }

    const startTime = Date.now();
    let result: ToolResult;

    try {
      const validatedArgs = tool.validateArguments(args);
      result = await tool.execute(validatedArgs, context);
    } catch (err) {
      result = {
        content: `Error executing tool ${toolName}: ${(err as Error).message}`,
        is_error: true,
      };
    }

    const durationMs = Date.now() - startTime;

    const maxChars = options?.maxResultChars ?? 16000;
    if (result.content && result.content.length > maxChars) {
      result = {
        ...result,
        content: truncateText(result.content, maxChars) + `\n[truncated from ${result.content.length} chars]`,
      };
    }

    this.executionHistory.push({
      tool_name: toolName,
      tool_call_id: toolCallId,
      arguments: args,
      result,
      duration_ms: durationMs,
    });

    logger.debug(
      { tool: toolName, duration_ms: durationMs, is_error: result.is_error },
      'Tool executed',
    );

    return result;
  }

  getExecutionHistory(): ToolExecutionRecord[] {
    return [...this.executionHistory];
  }

  clearHistory(): void {
    this.executionHistory = [];
  }
}

export function createDefaultToolRegistry(options?: {
  filesystem?: boolean;
  shell?: boolean;
  web?: boolean;
  memory?: boolean;
  cron?: boolean;
  utilities?: boolean;
  search?: boolean;
}): ToolRegistry {
  const registry = new ToolRegistry();
  const opts = {
    filesystem: true,
    shell: true,
    web: true,
    memory: true,
    cron: true,
    utilities: true,
    search: true,
    ...options,
  };

  if (opts.filesystem) registry.registerMany(getFilesystemTools());
  if (opts.shell) registry.registerMany(getShellTools());
  if (opts.web) registry.registerMany(getWebTools());
  if (opts.memory) registry.registerMany(getMemoryTools());
  if (opts.cron) registry.registerMany(getCronTools());
  if (opts.utilities) registry.registerMany(getUtilityTools());
  if (opts.search) registry.registerMany(getSearchTools());

  return registry;
}

export { isToolErrorResult };
