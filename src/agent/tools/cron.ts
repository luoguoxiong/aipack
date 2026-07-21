import { BaseTool, ToolContext, ToolResult, createToolResult, createToolError } from './base.js';
import { cronStore } from './cron_store.js';
import { z } from 'zod';

const CronListSchema = z.object({});

const CronAddSchema = z.object({
  schedule: z.string().describe('Cron schedule expression (e.g., "0 9 * * *") or interval like "every 2h"'),
  message: z.string().describe('Message to send when the cron job triggers'),
  description: z.string().optional().describe('Optional description for the cron job'),
});

const CronRemoveSchema = z.object({
  id: z.string().describe('ID of the cron job to remove'),
});

export interface CronSchedule {
  kind: 'cron' | 'every';
  expr?: string;
  every_ms?: number;
  tz?: string;
}

export interface CronJob {
  id: string;
  schedule: CronSchedule;
  message: string;
  description?: string;
  session_key: string;
  created_at: string;
  enabled: boolean;
}

export class CronListTool extends BaseTool {
  name = 'cron_list';
  description = 'List all scheduled cron jobs.';
  input_schema = CronListSchema;
  tags = ['cron'];

  async execute(_args: unknown, _context: ToolContext): Promise<ToolResult> {
    const jobs = cronStore.list();
    if (jobs.length === 0) {
      return createToolResult('No scheduled cron jobs.');
    }
    const lines = jobs.map(job => {
      const scheduleStr = job.schedule.kind === 'cron' ? job.schedule.expr || '' :
                          job.schedule.kind === 'every' ? `every ${(job.schedule.every_ms || 0) / 1000}s` : '';
      return `[${job.id}] ${scheduleStr} - ${job.description || job.message.slice(0, 50)}${job.enabled ? '' : ' (disabled)'}`;
    });
    return createToolResult(`Scheduled cron jobs (${jobs.length}):\n${lines.join('\n')}`);
  }
}

function parseSchedule(scheduleStr: string): CronSchedule {
  const everyMatch = scheduleStr.match(/every\s+(\d+)\s*(s|m|h|d)/i);
  if (everyMatch) {
    const value = parseInt(everyMatch[1]);
    const unit = everyMatch[2].toLowerCase();
    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60000,
      h: 3600000,
      d: 86400000,
    };
    return {
      kind: 'every',
      every_ms: value * multipliers[unit],
    };
  }
  return {
    kind: 'cron',
    expr: scheduleStr,
  };
}

export class CronAddTool extends BaseTool {
  name = 'cron_add';
  description = 'Add a new scheduled cron job that will send a message on a schedule.';
  input_schema = CronAddSchema;
  tags = ['cron'];

  async execute(args: unknown, _context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
      const schedule = parseSchedule(params.schedule);
      const job: CronJob = {
        id: `cron_${Date.now()}`,
        schedule,
        message: params.message,
        description: params.description,
        session_key: '',
        created_at: new Date().toISOString(),
        enabled: true,
      };
      await cronStore.add(job);
      const scheduleStr = schedule.kind === 'cron' ? schedule.expr : `every ${(schedule.every_ms || 0) / 1000}s`;
      return createToolResult(`Cron job added:\n  ID: ${job.id}\n  Schedule: ${scheduleStr}\n  Message: ${params.message.slice(0, 100)}`);
    } catch (err) {
      return createToolError(`Failed to add cron job: ${(err as Error).message}`);
    }
  }
}

export class CronRemoveTool extends BaseTool {
  name = 'cron_remove';
  description = 'Remove a scheduled cron job by ID.';
  input_schema = CronRemoveSchema;
  tags = ['cron'];

  async execute(args: unknown, _context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
      const removed = await cronStore.remove(params.id);
      if (removed) {
        return createToolResult(`Cron job removed: ${params.id}`);
      }
      return createToolError(`Cron job not found: ${params.id}`);
    } catch (err) {
      return createToolError(`Failed to remove cron job: ${(err as Error).message}`);
    }
  }
}

export function getCronTools(): BaseTool[] {
  return [new CronListTool(), new CronAddTool(), new CronRemoveTool()];
}

