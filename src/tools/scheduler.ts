import { Type } from "@earendil-works/pi-ai";
import { BaseTool, createToolResult, createToolError } from './base';
import { logger } from '../utils/logger';
import cronParser from 'cron-parser';

export type TaskStatus = 'pending' | 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled';
export type TaskType = 'cron' | 'once' | 'interval';

export interface ScheduledTask {
  id: string;
  type: TaskType;
  name?: string;
  description?: string;
  payload: string;
  schedule: string;
  created_at: string;
  updated_at: string;
  status: TaskStatus;
  next_run_at?: string;
  last_run_at?: string;
  run_count: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskSchedulerOptions {
  maxTasks?: number;
  checkIntervalMs?: number;
}

export type TaskHandler = (task: ScheduledTask) => Promise<void>;

let taskIdCounter = 0;

function generateTaskId(): string {
  taskIdCounter++;
  return `task_${Date.now()}_${taskIdCounter}`;
}

export class TaskScheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private handler: TaskHandler | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private maxTasks: number;
  private checkIntervalMs: number;
  private running = false;

  constructor(options?: TaskSchedulerOptions) {
    this.maxTasks = options?.maxTasks || 1000;
    this.checkIntervalMs = options?.checkIntervalMs || 1000;
  }

  setHandler(handler: TaskHandler): void {
    this.handler = handler;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this._scheduleNextCheck();
    logger.info('Task scheduler started');
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('Task scheduler stopped');
  }

  private _scheduleNextCheck(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this._checkAndRunTasks().catch(err => {
        logger.error({ error: err.message }, 'Error checking scheduled tasks');
      });
      this._scheduleNextCheck();
    }, this.checkIntervalMs);
  }

  private async _checkAndRunTasks(): Promise<void> {
    const now = Date.now();
    const toRun: ScheduledTask[] = [];

    for (const task of this.tasks.values()) {
      if (task.status !== 'scheduled' && task.status !== 'pending') continue;
      if (!task.next_run_at) continue;
      const nextRun = new Date(task.next_run_at).getTime();
      if (nextRun <= now) {
        toRun.push(task);
      }
    }

    for (const task of toRun) {
      await this._runTask(task);
    }
  }

  private async _runTask(task: ScheduledTask): Promise<void> {
    if (!this.handler) {
      logger.warn({ task: task.id }, 'No task handler set, skipping task');
      return;
    }

    task.status = 'running';
    task.last_run_at = new Date().toISOString();
    task.run_count += 1;
    task.updated_at = task.last_run_at;

    try {
      await this.handler(task);
      task.status = 'completed';
      task.error = undefined;
    } catch (err) {
      task.status = 'failed';
      task.error = (err as Error).message;
      logger.error({ task: task.id, error: (err as Error).message }, 'Scheduled task failed');
    }

    task.updated_at = new Date().toISOString();

    if (task.type === 'cron' || task.type === 'interval') {
      this._scheduleNextRun(task);
    }
    // One-time tasks stay completed
  }

  private _scheduleNextRun(task: ScheduledTask): void {
    try {
      if (task.type === 'cron') {
        const interval = cronParser.parseExpression(task.schedule);
        const next = interval.next();
        task.next_run_at = next.toISOString();
        task.status = 'scheduled';
      } else if (task.type === 'interval') {
        const ms = this._parseInterval(task.schedule);
        task.next_run_at = new Date(Date.now() + ms).toISOString();
        task.status = 'scheduled';
      }
    } catch (err) {
      task.status = 'failed';
      task.error = `Invalid schedule: ${(err as Error).message}`;
      logger.error({ task: task.id, error: task.error }, 'Failed to schedule next run');
    }
    task.updated_at = new Date().toISOString();
  }

  private _parseInterval(s: string): number {
    const match = s.match(/^every\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/i);
    if (!match) {
      throw new Error(`Invalid interval format: ${s}. Use "every N<unit>"`);
    }
    const num = parseInt(match[1], 10);
    const unit = (match[2] || 's').toLowerCase();
    const multipliers: Record<string, number> = {
      s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
      m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
      h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000,
      d: 86400000, day: 86400000, days: 86400000,
    };
    const mult = multipliers[unit];
    if (!mult) throw new Error(`Unknown time unit: ${unit}`);
    return num * mult;
  }

  addTask(params: {
    type: TaskType;
    schedule: string;
    payload: string;
    name?: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }): ScheduledTask {
    if (this.tasks.size >= this.maxTasks) {
      throw new Error(`Maximum number of tasks (${this.maxTasks}) reached`);
    }

    const now = new Date().toISOString();
    const task: ScheduledTask = {
      id: generateTaskId(),
      type: params.type,
      name: params.name,
      description: params.description,
      payload: params.payload,
      schedule: params.schedule,
      created_at: now,
      updated_at: now,
      status: 'pending',
      run_count: 0,
      metadata: params.metadata,
    };

    this._scheduleNextRun(task);
    this.tasks.set(task.id, task);
    logger.debug({ task: task.id, type: params.type, schedule: params.schedule }, 'Task added');
    return task;
  }

  removeTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    this.tasks.delete(id);
    logger.debug({ task: id }, 'Task removed');
    return true;
  }

  cancelTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    task.status = 'cancelled';
    task.next_run_at = undefined;
    task.updated_at = new Date().toISOString();
    logger.debug({ task: id }, 'Task cancelled');
    return true;
  }

  getTask(id: string): ScheduledTask | undefined {
    return this.tasks.get(id);
  }

  listTasks(options?: {
    status?: TaskStatus | TaskStatus[];
    type?: TaskType | TaskType[];
    limit?: number;
    offset?: number;
  }): ScheduledTask[] {
    let tasks = Array.from(this.tasks.values());

    if (options?.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      tasks = tasks.filter(t => statuses.includes(t.status));
    }
    if (options?.type) {
      const types = Array.isArray(options.type) ? options.type : [options.type];
      tasks = tasks.filter(t => types.includes(t.type));
    }

    tasks.sort((a, b) => {
      const aNext = a.next_run_at ? new Date(a.next_run_at).getTime() : Infinity;
      const bNext = b.next_run_at ? new Date(b.next_run_at).getTime() : Infinity;
      return aNext - bNext;
    });

    const offset = options?.offset || 0;
    const limit = options?.limit;
    if (limit !== undefined) {
      tasks = tasks.slice(offset, offset + limit);
    } else if (offset > 0) {
      tasks = tasks.slice(offset);
    }

    return tasks;
  }

  clearCompleted(): number {
    let count = 0;
    for (const [id, task] of this.tasks) {
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        this.tasks.delete(id);
        count++;
      }
    }
    if (count > 0) {
      logger.debug({ count }, 'Cleared completed/failed/cancelled tasks');
    }
    return count;
  }

  size(): number {
    return this.tasks.size;
  }
}

// --- Tools ---

const TaskListSchema = Type.Object({
  status: Type.Optional(Type.Enum({
    pending: 'pending', scheduled: 'scheduled', running: 'running',
    completed: 'completed', failed: 'failed', cancelled: 'cancelled',
  }, { description: '按任务状态过滤' })),
  type: Type.Optional(Type.Enum({
    cron: 'cron', once: 'once', interval: 'interval',
  }, { description: '按任务类型过滤' })),
  limit: Type.Optional(Type.Integer({ description: '最大返回数（默认 50）', minimum: 1, maximum: 100 })),
  offset: Type.Optional(Type.Integer({ description: '跳过前 N 个任务', minimum: 0 })),
});

const TaskAddSchema = Type.Object({
  type: Type.Enum({
    cron: 'cron', once: 'once', interval: 'interval',
  }, { description: '任务类型: cron（cron 表达式循环）、once（一次性延迟）、interval（间隔循环）' }),
  schedule: Type.String({ description: '调度: cron 表达式、ISO 时间戳或 "+N seconds"、 "every N minutes"' }),
  message: Type.String({ description: '任务触发时要发送的消息内容' }),
  name: Type.Optional(Type.String({ description: '任务名称' })),
  description: Type.Optional(Type.String({ description: '任务描述' })),
});

const TaskRemoveSchema = Type.Object({
  id: Type.String({ description: '要移除的任务 ID' }),
});

const TaskCancelSchema = Type.Object({
  id: Type.String({ description: '要取消的任务 ID' }),
});

const TaskClearSchema = Type.Object({});

export class TaskListTool extends BaseTool<typeof TaskListTool.parameters> {
  name = 'task_list';
  label = 'Task List';
  description = '列出已调度的任务，支持按状态或类型过滤';
  static parameters = TaskListSchema;
  parameters = TaskListTool.parameters;

  private scheduler: TaskScheduler | null = null;

  setScheduler(scheduler: TaskScheduler): void {
    this.scheduler = scheduler;
  }

  async execute(toolCallId: string, params: { status?: string; type?: string; limit?: number; offset?: number }) {
    try {
      if (!this.scheduler) {
        return createToolError('Task scheduler not available');
      }

      const tasks = this.scheduler.listTasks({
        status: params.status as any,
        type: params.type as any,
        limit: params.limit || 50,
        offset: params.offset,
      });

      if (tasks.length === 0) {
        return createToolResult('No scheduled tasks.');
      }

      const lines = tasks.map(task => {
        const next = task.next_run_at ? `next: ${task.next_run_at}` : '';
        const name = task.name ? ` [${task.name}]` : '';
        return `[${task.id}] ${task.type}${name} - ${task.status} ${next}`.trim();
      });

      return createToolResult(
        `Scheduled tasks (${this.scheduler.size()} total, showing ${tasks.length}):\n${lines.join('\n')}`,
      );
    } catch (err) {
      return createToolError(`Failed to list tasks: ${(err as Error).message}`);
    }
  }
}

export class TaskAddTool extends BaseTool<typeof TaskAddTool.parameters> {
  name = 'task_add';
  label = 'Task Add';
  description = '添加新的调度任务。支持 cron 表达式、一次性延迟和间隔循环。任务触发时会发送消息。';
  static parameters = TaskAddSchema;
  parameters = TaskAddTool.parameters;

  private scheduler: TaskScheduler | null = null;

  setScheduler(scheduler: TaskScheduler): void {
    this.scheduler = scheduler;
  }

  async execute(toolCallId: string, params: { type: string; schedule: string; message: string; name?: string; description?: string }) {
    try {
      if (!this.scheduler) {
        return createToolError('Task scheduler not available');
      }

      let schedule = params.schedule;

      if (params.type === 'once') {
        if (schedule.startsWith('+')) {
          const ms = this._parseDelay(schedule.slice(1));
          schedule = new Date(Date.now() + ms).toISOString();
        } else {
          const date = new Date(schedule);
          if (isNaN(date.getTime())) {
            return createToolError(`Invalid schedule: ${schedule}. Use ISO timestamp or "+30s" format`);
          }
          schedule = date.toISOString();
        }
      }

      const task = this.scheduler.addTask({
        type: params.type as TaskType,
        schedule,
        payload: params.message,
        name: params.name,
        description: params.description,
      });

      return createToolResult(
        `Task added:\n` +
        `  ID: ${task.id}\n` +
        `  Type: ${task.type}\n` +
        `  Schedule: ${task.schedule}\n` +
        `  Next run: ${task.next_run_at || 'N/A'}\n` +
        `  Status: ${task.status}`,
      );
    } catch (err) {
      return createToolError(`Failed to add task: ${(err as Error).message}`);
    }
  }

  private _parseDelay(s: string): number {
    const match = s.match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/i);
    if (!match) throw new Error(`Invalid delay format: ${s}`);
    const num = parseInt(match[1], 10);
    const unit = (match[2] || 's').toLowerCase();
    const multipliers: Record<string, number> = {
      s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
      m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
      h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000,
      d: 86400000, day: 86400000, days: 86400000,
    };
    const mult = multipliers[unit];
    if (!mult) throw new Error(`Unknown time unit: ${unit}`);
    return num * mult;
  }
}

export class TaskRemoveTool extends BaseTool<typeof TaskRemoveTool.parameters> {
  name = 'task_remove';
  label = 'Task Remove';
  description = '按 ID 移除已调度的任务';
  static parameters = TaskRemoveSchema;
  parameters = TaskRemoveTool.parameters;

  private scheduler: TaskScheduler | null = null;

  setScheduler(scheduler: TaskScheduler): void {
    this.scheduler = scheduler;
  }

  async execute(toolCallId: string, params: { id: string }) {
    try {
      if (!this.scheduler) {
        return createToolError('Task scheduler not available');
      }
      const removed = this.scheduler.removeTask(params.id);
      if (removed) {
        return createToolResult(`Task removed: ${params.id}`);
      }
      return createToolError(`Task not found: ${params.id}`);
    } catch (err) {
      return createToolError(`Failed to remove task: ${(err as Error).message}`);
    }
  }
}

export class TaskCancelTool extends BaseTool<typeof TaskCancelTool.parameters> {
  name = 'task_cancel';
  label = 'Task Cancel';
  description = '取消任务但保留在历史记录中';
  static parameters = TaskCancelSchema;
  parameters = TaskCancelTool.parameters;

  private scheduler: TaskScheduler | null = null;

  setScheduler(scheduler: TaskScheduler): void {
    this.scheduler = scheduler;
  }

  async execute(toolCallId: string, params: { id: string }) {
    try {
      if (!this.scheduler) {
        return createToolError('Task scheduler not available');
      }
      const cancelled = this.scheduler.cancelTask(params.id);
      if (cancelled) {
        return createToolResult(`Task cancelled: ${params.id}`);
      }
      return createToolError(`Task not found: ${params.id}`);
    } catch (err) {
      return createToolError(`Failed to cancel task: ${(err as Error).message}`);
    }
  }
}

export class TaskClearTool extends BaseTool<typeof TaskClearTool.parameters> {
  name = 'task_clear';
  label = 'Task Clear';
  description = '清除所有已完成/失败/已取消的任务记录';
  static parameters = TaskClearSchema;
  parameters = TaskClearTool.parameters;

  private scheduler: TaskScheduler | null = null;

  setScheduler(scheduler: TaskScheduler): void {
    this.scheduler = scheduler;
  }

  async execute(toolCallId: string) {
    try {
      if (!this.scheduler) {
        return createToolError('Task scheduler not available');
      }
      const count = this.scheduler.clearCompleted();
      return createToolResult(`Cleared ${count} completed/failed/cancelled tasks.`);
    } catch (err) {
      return createToolError(`Failed to clear tasks: ${(err as Error).message}`);
    }
  }
}

export function getSchedulerTools(scheduler?: TaskScheduler): BaseTool[] {
  const tools = [
    new TaskListTool(),
    new TaskAddTool(),
    new TaskRemoveTool(),
    new TaskCancelTool(),
    new TaskClearTool(),
  ];
  if (scheduler) {
    for (const tool of tools) {
      if ('setScheduler' in tool) {
        (tool as any).setScheduler(scheduler);
      }
    }
  }
  return tools;
}
