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
  description = '添加一个定时 cron 任务';
  static parameters = Type.Object({
    id: Type.String({ description: '任务的唯一标识符' }),
    cron: Type.String({ description: 'Cron 表达式' }),
    command: Type.String({ description: '要执行的命令' }),
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
      return createToolResult(`任务已添加: ${params.id}`);
    } catch (err) {
      return createToolError(`无效的 cron 表达式: ${(err as Error).message}`);
    }
  }
}

export class CronListTool extends BaseTool<typeof CronListTool.parameters> {
  name = 'cron_list';
  label = 'Cron List';
  description = '列出所有定时任务';
  static parameters = Type.Object({});
  parameters = CronListTool.parameters;

  async execute(toolCallId: string) {
    if (tasks.size === 0) {
      return createToolResult('无定时任务');
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
  description = '移除一个定时任务';
  static parameters = Type.Object({
    id: Type.String({ description: '任务 ID' }),
  });
  parameters = CronRemoveTool.parameters;

  async execute(toolCallId: string, params: { id: string }) {
    if (!tasks.has(params.id)) {
      return createToolError(`任务未找到: ${params.id}`);
    }
    tasks.delete(params.id);
    return createToolResult(`任务已移除: ${params.id}`);
  }
}

export class CronEnableTool extends BaseTool<typeof CronEnableTool.parameters> {
  name = 'cron_enable';
  label = 'Cron Enable';
  description = '启用或禁用一个任务';
  static parameters = Type.Object({
    id: Type.String({ description: '任务 ID' }),
    enabled: Type.Boolean({ description: '启用或禁用', default: true }),
  });
  parameters = CronEnableTool.parameters;

  async execute(toolCallId: string, params: { id: string; enabled: boolean }) {
    const task = tasks.get(params.id);
    if (!task) {
      return createToolError(`任务未找到: ${params.id}`);
    }
    task.enabled = params.enabled;
    return createToolResult(`任务 ${params.id} ${params.enabled ? '已启用' : '已禁用'}`);
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
