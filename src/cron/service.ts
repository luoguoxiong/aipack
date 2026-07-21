import fs from 'fs/promises';
import path from 'path';
import { logger } from '../utils/logger.js';
import cronParser from 'cron-parser';
import { getProjectConfigDir } from '../config/paths.js';

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
  enabled: boolean;
  last_run?: string;
  next_run?: string;
  created_at: string;
}

const _HOUR_MS = 3_600_000;
const _DAY_MS = 24 * _HOUR_MS;

export class CronService {
  private jobs: Map<string, CronJob> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private baseDir: string;
  private onTrigger?: (job: CronJob) => Promise<void>;
  private running = false;

  constructor(baseDir?: string, onTrigger?: (job: CronJob) => Promise<void>) {
    this.baseDir = baseDir || path.join(getProjectConfigDir(), 'cron');
    this.onTrigger = onTrigger;
  }

  setTriggerHandler(handler: (job: CronJob) => Promise<void>): void {
    this.onTrigger = handler;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.loadJobs();
    this.scheduleAll();
    this.running = true;
    logger.info({ job_count: this.jobs.size }, 'Cron service started');
  }

  async stop(): Promise<void> {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.running = false;
    logger.info('Cron service stopped');
  }

  addJob(job: Partial<CronJob> & { schedule: CronSchedule; message: string; session_key: string }): CronJob {
    const newJob: CronJob = {
      ...job,
      id: job.id || `cron_${Date.now()}`,
      created_at: job.created_at || new Date().toISOString(),
      enabled: job.enabled !== false,
    };
    this.jobs.set(newJob.id, newJob);
    this.saveJobs();
    if (this.running && newJob.enabled) {
      this.scheduleJob(newJob.id);
    }
    return newJob;
  }

  removeJob(id: string): boolean {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    const removed = this.jobs.delete(id);
    if (removed) {
      this.saveJobs();
    }
    return removed;
  }

  getJob(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  listJobs(): CronJob[] {
    return Array.from(this.jobs.values());
  }

  private scheduleAll(): void {
    for (const job of this.jobs.values()) {
      if (job.enabled) {
        this.scheduleJob(job.id);
      }
    }
  }

  private scheduleJob(id: string): void {
    const job = this.jobs.get(id);
    if (!job || !job.enabled) return;

    const nextRun = this.calculateNextRun(job.schedule);
    if (!nextRun) return;

    job.next_run = nextRun.toISOString();
    const delay = nextRun.getTime() - Date.now();

    if (delay <= 0) {
      this.runJob(id);
      return;
    }

    const timer = setTimeout(() => {
      this.runJob(id);
    }, delay);
    timer;

    this.timers.set(id, timer);
  }

  private async runJob(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;

    job.last_run = new Date().toISOString();
    this.saveJobs();

    try {
      if (this.onTrigger) {
        await this.onTrigger(job);
      }
    } catch (err) {
      logger.error({ err, job_id: id }, 'Cron job trigger failed');
    }

    if (this.running && job.enabled) {
      this.scheduleJob(id);
    }
  }

  private calculateNextRun(schedule: CronSchedule): Date | null {
    const now = new Date();

    if (schedule.kind === 'every' && schedule.every_ms) {
      return new Date(now.getTime() + schedule.every_ms);
    }

    if (schedule.kind === 'cron' && schedule.expr) {
      try {
        const interval = cronParser.parseExpression(schedule.expr, {
          tz: schedule.tz,
        });
        return interval.next().toDate();
      } catch (err) {
        logger.error({ err, expr: schedule.expr }, 'Failed to parse cron expression');
        return null;
      }
    }

    return null;
  }

  private async loadJobs(): Promise<void> {
    try {
      await fs.mkdir(this.baseDir, { recursive: true });
      const filePath = path.join(this.baseDir, 'jobs.json');
      const data = await fs.readFile(filePath, 'utf-8');
      const jobs = JSON.parse(data) as CronJob[];
      for (const job of jobs) {
        this.jobs.set(job.id, job);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err }, 'Failed to load cron jobs');
      }
    }
  }

  private async saveJobs(): Promise<void> {
    try {
      await fs.mkdir(this.baseDir, { recursive: true });
      const filePath = path.join(this.baseDir, 'jobs.json');
      const jobs = Array.from(this.jobs.values());
      await fs.writeFile(filePath, JSON.stringify(jobs, null, 2));
    } catch (err) {
      logger.error({ err }, 'Failed to save cron jobs');
    }
  }
}
