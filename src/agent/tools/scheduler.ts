import { BaseTool, ToolContext, ToolResult, createToolResult, createToolError } from './base.js';
import { z } from 'zod';
import cronParser from 'cron-parser';
import { logger } from '../../utils/logger.js';
import { generateId } from '../../utils/helpers.js';

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

export class TaskScheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private handler: TaskHandler | null = null;
  private timer: NodeJS.Timeout | null = null;
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
    } else if (task.type === 'once') {
      // One-time task stays completed
    }
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
      id: generateId('task'),
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

const TaskListSchema = z.object({
  status: z.enum(['pending', 'scheduled', 'running', 'completed', 'failed', 'cancelled']).optional().describe(
    'Filter by task status',
  ),
  type: z.enum(['cron', 'once', 'interval']).optional().describe(
    'Filter by task type',
  ),
  limit: z.number().int().min(1).max(100).optional().describe(
    'Maximum number of tasks to return (default 50)',
  ),
  offset: z.number().int().min(0).optional().describe(
    'Skip the first N tasks',
  ),
});

const TaskAddSchema = z.object({
  type: z.enum(['cron', 'once', 'interval']).describe(
    'Type of scheduled task: cron (recurring cron expression), once (one-time delay), interval (recurring interval)',
  ),
  schedule: z.string().describe(
    'Schedule: cron expression for cron type, ISO timestamp or "+N seconds" for once type, "every N minutes" for interval type',
  ),
  message: z.string().describe(
    'Message content to send when the task triggers',
  ),
  name: z.string().optional().describe(
    'Optional name for the task',
  ),
  description: z.string().optional().describe(
    'Optional description for the task',
  ),
});

const TaskRemoveSchema = z.object({
  id: z.string().describe('ID of the task to remove'),
});

const TaskCancelSchema = z.object({
  id: z.string().describe('ID of the task to cancel'),
});

const TaskClearSchema = z.object({});

export class TaskListTool extends BaseTool {
  name = 'task_list';
  description = 'List scheduled tasks with optional filtering by status or type.';
  input_schema = TaskListSchema;
  tags = ['scheduler', 'task'];

  private scheduler: TaskScheduler | null = null;

  setScheduler(scheduler: TaskScheduler): void {
    this.scheduler = scheduler;
  }

  async execute(args: unknown, _context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
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
        const statusIcon = {
          pending: '⏳',
          scheduled: '📅',
          running: '▶️',
          completed: '✅',
          failed: '❌',
          cancelled: '🚫',
        }[task.status] || '❓';
        const next = task.next_run_at ? `next: ${task.next_run_at}` : '';
        const name = task.name ? ` [${task.name}]` : '';
        return `${statusIcon} [${task.id}] ${task.type}${name} - ${task.status} ${next}`.trim();
      });

      return createToolResult(
        `Scheduled tasks (${this.scheduler.size()} total, showing ${tasks.length}):\n${lines.join('\n')}`,
      );
    } catch (err) {
      return createToolError(`Failed to list tasks: ${(err as Error).message}`);
    }
  }
}

export class TaskAddTool extends BaseTool {
  name = 'task_add';
  description = (
    'Add a new scheduled task. Supports cron expressions, one-time delays, and recurring intervals. ' +
    'When the task triggers, the message will be sent to the current chat.'
  );
  input_schema = TaskAddSchema;
  tags = ['scheduler', 'task'];

  private scheduler: TaskScheduler | null = null;

  setScheduler(scheduler: TaskScheduler): void {
    this.scheduler = scheduler;
  }

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
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
        type: params.type,
        schedule,
        payload: params.message,
        name: params.name,
        description: params.description,
        metadata: {
          channel: context.channel,
          chat_id: context.chat_id,
          sender_id: context.sender_id,
          session_key: context.session_key,
        },
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

export class TaskRemoveTool extends BaseTool {
  name = 'task_remove';
  description = 'Remove a scheduled task by ID.';
  input_schema = TaskRemoveSchema;
  tags = ['scheduler', 'task'];

  private scheduler: TaskScheduler | null = null;

  setScheduler(scheduler: TaskScheduler): void {
    this.scheduler = scheduler;
  }

  async execute(args: unknown, _context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
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

export class TaskCancelTool extends BaseTool {
  name = 'task_cancel';
  description = 'Cancel a scheduled task without removing it from history.';
  input_schema = TaskCancelSchema;
  tags = ['scheduler', 'task'];

  private scheduler: TaskScheduler | null = null;

  setScheduler(scheduler: TaskScheduler): void {
    this.scheduler = scheduler;
  }

  async execute(args: unknown, _context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
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

export class TaskClearTool extends BaseTool {
  name = 'task_clear';
  description = 'Clear all completed, failed, and cancelled tasks from the history.';
  input_schema = TaskClearSchema;
  tags = ['scheduler', 'task'];

  private scheduler: TaskScheduler | null = null;

  setScheduler(scheduler: TaskScheduler): void {
    this.scheduler = scheduler;
  }

  async execute(_args: unknown, _context: ToolContext): Promise<ToolResult> {
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
