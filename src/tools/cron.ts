import cronParser from 'cron-parser';
import { Type } from "../ai";
import { BaseTool, createToolResult, createToolError } from './base';

export interface ScheduledTask {
  id: string;
  cron: string;
  command: string;
  enabled: boolean;
  lastRun?: number;
  nextRun?: number;
}

/**
 * CronScheduler — 持有定时任务列表，支持多实例隔离
 * 每个 getCronTools() 调用会创建独立的调度器实例
 */
export class CronScheduler {
  readonly tasks: Map<string, ScheduledTask> = new Map();

  getTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values());
  }
}

// ─── Cron 工具（每个工具引用一个 scheduler 实例）─────────────────────

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

  private scheduler: CronScheduler;

  constructor(scheduler: CronScheduler) {
    super();
    this.scheduler = scheduler;
  }

  async execute(toolCallId: string, params: { id: string; cron: string; command: string }) {
    try {
      cronParser.parseExpression(params.cron);
      const nextRun = cronParser.parseExpression(params.cron).next().getTime();
      this.scheduler.tasks.set(params.id, {
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

  private scheduler: CronScheduler;

  constructor(scheduler: CronScheduler) {
    super();
    this.scheduler = scheduler;
  }

  async execute(toolCallId: string) {
    const tasks = this.scheduler.getTasks();
    if (tasks.length === 0) {
      return createToolResult('无定时任务');
    }
    const result = tasks.map(task =>
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

  private scheduler: CronScheduler;

  constructor(scheduler: CronScheduler) {
    super();
    this.scheduler = scheduler;
  }

  async execute(toolCallId: string, params: { id: string }) {
    if (!this.scheduler.tasks.has(params.id)) {
      return createToolError(`任务未找到: ${params.id}`);
    }
    this.scheduler.tasks.delete(params.id);
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

  private scheduler: CronScheduler;

  constructor(scheduler: CronScheduler) {
    super();
    this.scheduler = scheduler;
  }

  async execute(toolCallId: string, params: { id: string; enabled: boolean }) {
    const task = this.scheduler.tasks.get(params.id);
    if (!task) {
      return createToolError(`任务未找到: ${params.id}`);
    }
    task.enabled = params.enabled;
    return createToolResult(`任务 ${params.id} ${params.enabled ? '已启用' : '已禁用'}`);
  }
}

export function getCronTools(scheduler?: CronScheduler): BaseTool[] {
  const s = scheduler ?? new CronScheduler();
  return [
    new CronAddTool(s),
    new CronListTool(s),
    new CronRemoveTool(s),
    new CronEnableTool(s),
  ];
}
