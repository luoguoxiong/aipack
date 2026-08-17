/**
 * 冷归档调度器（Phase 8）。
 *
 * 定时将超过归档阈值（默认 90 天）的 ClickHouse 热表数据导出到 S3 Parquet。
 * - start()：用 setInterval 定时触发 runOnce()
 * - runOnce()：计算日期窗口，调用 exportToParquet，可选删除已归档数据
 *
 * 归档窗口语义：
 * - archiveAfterDays=90：距今 90 天前的数据需要归档
 * - archiveWindowDays=1：每次归档 1 天的数据
 * - 窗口：[now - archiveAfterDays, now - (archiveAfterDays - archiveWindowDays))
 */

import { toChDateTime, type ClickHouseClient } from '../stores/clickhouse-client';
import { exportToParquet, type ParquetExportResult } from './parquet-writer';

export interface ArchiveSchedulerOptions {
  /** ClickHouse client */
  client: ClickHouseClient;
  /** S3 配置 */
  s3: { path: string; accessKey?: string; secretKey?: string };
  /** 归档阈值天数：超过 N 天的数据归档（默认 90） */
  archiveAfterDays?: number;
  /** 归档窗口天数：每次归档多少天的数据（默认 1） */
  archiveWindowDays?: number;
  /** 执行间隔（ms），默认 24h */
  intervalMs?: number;
  /** 是否立即执行一次（测试用） */
  runImmediately?: boolean;
  /** 归档成功后是否删除已归档数据（默认 false，需显式确认） */
  deleteAfterArchive?: boolean;
}

export interface ArchiveScheduler {
  start(): void;
  stop(): void;
  /** 手动触发一次归档 */
  runOnce(): Promise<ParquetExportResult[]>;
}

export function createArchiveScheduler(opts: ArchiveSchedulerOptions): ArchiveScheduler {
  const archiveAfterDays = opts.archiveAfterDays ?? 90;
  const archiveWindowDays = opts.archiveWindowDays ?? 1;
  const intervalMs = opts.intervalMs ?? 24 * 60 * 60 * 1000;
  const deleteAfterArchive = opts.deleteAfterArchive ?? false;

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function runOnce(): Promise<ParquetExportResult[]> {
    if (running) {
      console.warn('[archive-scheduler] 归档任务正在执行，跳过本次触发');
      return [];
    }
    running = true;
    try {
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      // 窗口：[now - archiveAfterDays, now - (archiveAfterDays - archiveWindowDays))
      const fromMs = now - archiveAfterDays * dayMs;
      const toMs = now - (archiveAfterDays - archiveWindowDays) * dayMs;
      const fromDate = new Date(fromMs);
      const toDate = new Date(toMs);

      console.log(
        `[archive-scheduler] 开始归档 ${fromDate.toISOString()} ~ ${toDate.toISOString()}`,
      );

      const results = await exportToParquet(opts.client, {
        s3Path: opts.s3.path,
        accessKey: opts.s3.accessKey,
        secretKey: opts.s3.secretKey,
        fromDate,
        toDate,
      });

      const totalRows = results.reduce((s, r) => s + r.rows, 0);
      console.log(`[archive-scheduler] 归档完成，共 ${totalRows} 行`);

      // 可选：删除已归档数据（需显式配置 deleteAfterArchive）
      if (deleteAfterArchive && totalRows > 0) {
        await deleteArchivedData(opts.client, toMs);
      }

      return results;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[archive-scheduler] 归档失败: ${msg}`);
      throw err;
    } finally {
      running = false;
    }
  }

  function start(): void {
    if (timer) return;
    if (opts.runImmediately) {
      runOnce().catch(() => {
        // 错误已在 runOnce 内记录
      });
    }
    timer = setInterval(() => {
      runOnce().catch(() => {
        // 错误已在 runOnce 内记录
      });
    }, intervalMs);
    console.log(`[archive-scheduler] 已启动，间隔 ${intervalMs}ms`);
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
      console.log('[archive-scheduler] 已停止');
    }
  }

  return { start, stop, runOnce };
}

/** 删除已归档到 S3 的热表数据（ALTER TABLE DELETE，CH 异步 mutation） */
async function deleteArchivedData(
  client: ClickHouseClient,
  beforeMs: number,
): Promise<void> {
  const ts = toChDateTime(beforeMs);
  const tables = [
    { table: 'runs', col: 'started_at' },
    { table: 'spans', col: 'started_at' },
    { table: 'tool_calls', col: 'started_at' },
    { table: 'events', col: 'ts' },
    { table: 'retry_attempts', col: 'ts' },
  ];
  console.log(`[archive-scheduler] 删除已归档数据（< ${ts}）`);
  await Promise.all(
    tables.map(({ table, col }) =>
      client.exec(`ALTER TABLE ${table} DELETE WHERE ${col} < '${ts}'`),
    ),
  );
  console.log('[archive-scheduler] 已归档数据删除已提交（CH 异步 mutation）');
}
