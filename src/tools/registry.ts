import { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";
import { BaseTool, ToolContext, ToolResult, isToolErrorResult } from "./base";
import { getFilesystemTools } from "./filesystem";
import { getShellTools } from "./shell";
import { getWebTools } from "./web";
import { getMemoryTools } from "./memory";
import { getCronTools } from "./cron";
import { getUtilityTools } from "./utilities";
import { getSearchTools } from "./search";
import { getApplyPatchTools } from "./apply_patch";
import { getSchedulerTools, TaskScheduler } from "./scheduler";
import { getSelfTools } from "./self";
import { getMessageTools } from "./message";

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

  getAgentTools(): AgentTool<TSchema>[] {
    return Array.from(this.tools.values()).map(tool => tool.toAgentTool());
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
      return createToolError(`Unknown tool "${toolName}"`);
    }

    const startTime = Date.now();
    let result: ToolResult;

    try {
      const validatedArgs = tool.validateArguments(args);
      result = await tool.execute(toolCallId, validatedArgs);
    } catch (err) {
      result = createToolError(`Error executing tool ${toolName}: ${(err as Error).message}`);
    }

    const durationMs = Date.now() - startTime;

    const maxChars = options?.maxResultChars ?? 16000;
    const textContent = result.content.filter(c => c.type === 'text').map(c => c.text).join('');
    if (textContent.length > maxChars) {
      result = {
        ...result,
        content: [{ type: 'text', text: textContent.slice(0, maxChars) + `\n[truncated from ${textContent.length} chars]` }],
      };
    }

    this.executionHistory.push({
      tool_name: toolName,
      tool_call_id: toolCallId,
      arguments: args,
      result,
      duration_ms: durationMs,
    });

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
  apply_patch?: boolean;
  scheduler?: boolean;
  self?: boolean;
  message?: boolean;
  schedulerInstance?: TaskScheduler;
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
    apply_patch: true,
    scheduler: true,
    self: true,
    message: true,
    ...options,
  };

  if (opts.filesystem) registry.registerMany(getFilesystemTools());
  if (opts.shell) registry.registerMany(getShellTools());
  if (opts.web) registry.registerMany(getWebTools());
  if (opts.memory) registry.registerMany(getMemoryTools());
  if (opts.cron) registry.registerMany(getCronTools());
  if (opts.utilities) registry.registerMany(getUtilityTools());
  if (opts.search) registry.registerMany(getSearchTools());
  if (opts.apply_patch) registry.registerMany(getApplyPatchTools());
  if (opts.scheduler) registry.registerMany(getSchedulerTools(options?.schedulerInstance));
  if (opts.self) registry.registerMany(getSelfTools());
  if (opts.message) registry.registerMany(getMessageTools());

  return registry;
}

function createToolError(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: message }],
    details: { error: message },
  };
}
