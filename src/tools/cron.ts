import cronParser from 'cron-parser';
import { Type } from "@earendil-works/pi-ai";
import { BaseTool, createToolResult, createToolError } from './base';

interface ScheduledTask {
  id: string;
  cron: string;
  command: string;
  enabled: boolean;
  lastRun?: number;
  nextRun?: number;
}

const tasks: Map<string, ScheduledTask> = new Map();

export class CronAddTool extends BaseTool<typeof CronAddTool.parameters> {
  name = 'cron_add';
  label = 'Cron Add';
  description = 'Add a scheduled cron task';
  static parameters = Type.Object({
    id: Type.String({ description: 'Unique identifier for the task' }),
    cron: Type.String({ description: 'Cron expression' }),
    command: Type.String({ description: 'Command to execute' }),
  });
  parameters = CronAddTool.parameters;

  async execute(toolCallId: string, params: { id: string; cron: string; command: string }) {
    try {
      cronParser.parseExpression(params.cron);
      const nextRun = cronParser.parseExpression(params.cron).next().getTime();
      tasks.set(params.id, {
        id: params.id,
        cron: params.cron,
        command: params.command,
        enabled: true,
        nextRun,
      });
      return createToolResult(`Task added: ${params.id}`);
    } catch (err) {
      return createToolError(`Invalid cron expression: ${(err as Error).message}`);
    }
  }
}

export class CronListTool extends BaseTool<typeof CronListTool.parameters> {
  name = 'cron_list';
  label = 'Cron List';
  description = 'List all scheduled tasks';
  static parameters = Type.Object({});
  parameters = CronListTool.parameters;

  async execute(toolCallId: string) {
    if (tasks.size === 0) {
      return createToolResult('No scheduled tasks');
    }
    const result = Array.from(tasks.values()).map(task => 
      `${task.id}: ${task.cron} -> ${task.command} (${task.enabled ? 'enabled' : 'disabled'})`
    ).join('\n');
    return createToolResult(result);
  }
}

export class CronRemoveTool extends BaseTool<typeof CronRemoveTool.parameters> {
  name = 'cron_remove';
  label = 'Cron Remove';
  description = 'Remove a scheduled task';
  static parameters = Type.Object({
    id: Type.String({ description: 'The task ID' }),
  });
  parameters = CronRemoveTool.parameters;

  async execute(toolCallId: string, params: { id: string }) {
    if (!tasks.has(params.id)) {
      return createToolError(`Task not found: ${params.id}`);
    }
    tasks.delete(params.id);
    return createToolResult(`Task removed: ${params.id}`);
  }
}

export class CronEnableTool extends BaseTool<typeof CronEnableTool.parameters> {
  name = 'cron_enable';
  label = 'Cron Enable';
  description = 'Enable or disable a task';
  static parameters = Type.Object({
    id: Type.String({ description: 'The task ID' }),
    enabled: Type.Boolean({ description: 'Enable or disable', default: true }),
  });
  parameters = CronEnableTool.parameters;

  async execute(toolCallId: string, params: { id: string; enabled: boolean }) {
    const task = tasks.get(params.id);
    if (!task) {
      return createToolError(`Task not found: ${params.id}`);
    }
    task.enabled = params.enabled;
    return createToolResult(`Task ${params.id} ${params.enabled ? 'enabled' : 'disabled'}`);
  }
}

export function getCronTools(): BaseTool[] {
  return [
    new CronAddTool(),
    new CronListTool(),
    new CronRemoveTool(),
    new CronEnableTool(),
  ];
}

export function getCronTasks(): ScheduledTask[] {
  return Array.from(tasks.values());
}
