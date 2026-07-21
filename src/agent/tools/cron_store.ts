import { CronJob } from './cron.js';
import fs from 'fs/promises';
import path from 'path';
import { getProjectConfigDir } from '../../config/paths.js';
import { logger } from '../../utils/logger.js';

class CronStoreImpl {
  private jobs = new Map<string, CronJob>();
  private filePath: string;
  private loaded = false;

  constructor() {
    this.filePath = path.join(getProjectConfigDir(), 'cron', 'jobs.json');
    this.load();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const data = await fs.readFile(this.filePath, 'utf-8');
      const storedJobs = JSON.parse(data) as CronJob[];
      for (const job of storedJobs) {
        this.jobs.set(job.id, job);
      }
      this.loaded = true;
      logger.info({ count: this.jobs.size }, 'Cron store loaded from disk');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err }, 'Failed to load cron store from disk');
      }
      this.loaded = true;
    }
  }

  private async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const jobs = Array.from(this.jobs.values());
      await fs.writeFile(this.filePath, JSON.stringify(jobs, null, 2));
    } catch (err) {
      logger.error({ err }, 'Failed to save cron store to disk');
    }
  }

  list(): CronJob[] {
    return Array.from(this.jobs.values());
  }

  get(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  async add(job: CronJob): Promise<void> {
    this.jobs.set(job.id, job);
    await this.save();
  }

  async remove(id: string): Promise<boolean> {
    const removed = this.jobs.delete(id);
    if (removed) {
      await this.save();
    }
    return removed;
  }
}

export const cronStore = new CronStoreImpl();
