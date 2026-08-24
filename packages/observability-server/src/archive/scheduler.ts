/**
 * 冷归档调度器（Phase 8）。
 *
 * 定时将超过归档阈值（默认 90 天）的 ClickHouse 热表数据导出到 S3 Parquet。
 * - start()：用 setInterval 定时触发 runOnce()
 * - runOnce()：计算日期窗口，调用 exportToParquet，可选删除已归档数据
 *
 * 归档窗口语义（D4 修复：水位化）：
 * - archiveAfterDays=90：距今 90 天前的数据需要归档
 * - archiveWindowDays=1：每次归档 1 天的数据
 * - 窗口从持久化水位开始（初始 now - archiveAfterDays），成功后推进水位
 * - 失败不推进 → 次日重试同一窗口（此前按运行时 now 滑动，失败窗口永久漏档）
 *
 * 删除语义（D4 修复：范围对齐）：
 * - 仅删除本次成功导出窗口内的数据（按分区 DROP PARTITION，瞬间完成）
 * - 此前 `< toMs 全部删除` 会把从未导出的更早数据一并物理删除
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ClickHouseClient } from '../stores/clickhouse-client';
import { exportToParquet, type ParquetExportResult } from './parquet-writer';

const DAY_MS = 24 * 60 * 60 * 1000;

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
  /** 水位文件路径（默认 .aipack/archive-watermark.json） */
  watermarkPath?: string;
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
  const watermarkPath =
    opts.watermarkPath ?? process.env.ARCHIVE_WATERMARK_PATH ?? '.aipack/archive-watermark.json';
  const dayMs = 24 * 60 * 60 * 1000;

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  /** 读取已归档进度水位（ms）；无水位时返回初始值 now - archiveAfterDays */
  function readWatermark(): number {
    try {
      const raw = JSON.parse(readFileSync(watermarkPath, 'utf8')) as { watermarkMs?: number };
      if (typeof raw.watermarkMs === 'number' && Number.isFinite(raw.watermarkMs)) {
        return raw.watermarkMs;
      }
    } catch {
      // 无水位文件：首次运行
    }
    return Date.now() - archiveAfterDays * dayMs;
  }

  function writeWatermark(ms: number): void {
    try {
      mkdirSync(dirname(watermarkPath), { recursive: true });
      writeFileSync(watermarkPath, JSON.stringify({ watermarkMs: ms, updatedAt: Date.now() }), 'utf8');
    } catch (err) {
      console.error('[archive-scheduler] 水位持久化失败（下次将重复归档该窗口）:', err);
    }
  }

  async function runOnce(): Promise<ParquetExportResult[]> {
    if (running) {
      console.warn('[archive-scheduler] 归档任务正在执行，跳过本次触发');
      return [];
    }
    running = true;
    try {
      const now = Date.now();
      // D4：窗口从持久化水位推进，失败次日重试同一窗口
      // fromMs = 水位；toMs = min(水位 + window, now - archiveAfterDays)
      const earliest = readWatermark();
      const latest = now - archiveAfterDays * dayMs;
      if (earliest >= latest) {
        // 已追平归档阈值（正常稳态：水位始终 ≈ now - archiveAfterDays）
        return [];
      }
      const fromMs = earliest;
      const toMs = Math.min(earliest + archiveWindowDays * dayMs, latest);
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

      // D4：导出成功才推进水位（失败保持原水位，次日重试同窗口）
      writeWatermark(toMs);

      // 可选：删除已归档数据（范围与本次成功导出窗口精确对齐）
      if (deleteAfterArchive) {
        await deleteArchivedPartitions(opts.client, fromMs, toMs, totalRows);
      }

      return results;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[archive-scheduler] 归档失败（水位未推进，下次重试同窗口）: ${msg}`);
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

/**
 * 删除已归档到 S3 的热表数据（D4 修复）。
 *
 * - 按 DROP PARTITION 删除（瞬间完成，无 mutation 异步等待），分区粒度 = 天
 *   （init.sql 各表 PARTITION BY toYYYYMMDD(<时间列>)）
 * - 仅删除 [fromMs, toMs) 覆盖的日期分区，与本次成功导出窗口精确对齐；
 *   此前 `< toMs 全删` 会把水位之前从未导出的数据一并物理删除
 * - 导出行数为 0 时跳过（该窗口无数据，仅推进水位；空分区 DROP 无意义）
 */
async function deleteArchivedPartitions(
  client: ClickHouseClient,
  fromMs: number,
  toMs: number,
  totalRows: number,
): Promise<void> {
  if (totalRows <= 0) return;
  const tables = [
    { table: 'runs', col: 'started_at' },
    { table: 'spans', col: 'started_at' },
    { table: 'tool_calls', col: 'started_at' },
    { table: 'events', col: 'ts' },
    { table: 'retry_attempts', col: 'ts' },
  ];
  // 窗口 [fromMs, toMs) 覆盖的日期分区（UTC 天）
  const partitions: string[] = [];
  const startDay = Math.floor(fromMs / DAY_MS);
  const endDay = Math.ceil(toMs / DAY_MS);
  for (let d = startDay; d < endDay; d++) {
    const day = new Date(d * DAY_MS);
    const y = day.getUTCFullYear();
    const m = String(day.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(day.getUTCDate()).padStart(2, '0');
    partitions.push(`${y}${m}${dd}`);
  }
  if (partitions.length === 0) return;
  console.log(
    `[archive-scheduler] 删除已归档分区 [${partitions[0]}..${partitions[partitions.length - 1]}]（共 ${partitions.length} 天）`,
  );
  await Promise.all(
    tables.map(({ table }) =>
      Promise.all(
        partitions.map((p) =>
          client.exec(`ALTER TABLE ${table} DROP PARTITION '${p}'`).catch((err) => {
            // 空分区 DROP 报错可忽略（部分表该日无数据）
            const msg = err instanceof Error ? err.message : String(err);
            if (!/No such partition|partiton|partition doesn't exist/i.test(msg)) throw err;
          }),
        ),
      ),
    ),
  );
  console.log('[archive-scheduler] 已归档分区删除完成');
}
