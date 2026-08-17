/**
 * Parquet 写入器 — 将 ClickHouse 热表数据导出到 S3 Parquet 文件（Phase 8 冷归档）。
 *
 * 实现：
 * - 优先用 `INSERT INTO FUNCTION s3(url, format) SELECT ... FROM table WHERE ...`
 * - CH 版本不支持 S3 引擎函数时退化为 `SELECT ... INTO OUTFILE 's3://...' FORMAT Parquet`
 * - 每张表导出到独立 Parquet 文件，文件名含表名与日期范围
 *
 * S3 凭证可通过 opts 传入或由 ClickHouse 服务端配置注入。
 */

import { toChDateTime, type ClickHouseClient } from '../stores/clickhouse-client';

export interface ParquetExportOptions {
  /** S3 路径，如 s3://aipack-archive/trace-2025-01/ */
  s3Path: string;
  /** S3 access key（也可通过 CH 配置注入） */
  accessKey?: string;
  /** S3 secret key */
  secretKey?: string;
  /** 导出的起始日期（含） */
  fromDate: Date;
  /** 导出的截止日期（不含） */
  toDate: Date;
  /** 导出哪些表 */
  tables?: string[]; // 默认 ['runs','spans','tool_calls','events','retry_attempts']
}

export interface ParquetExportResult {
  table: string;
  rows: number;
  s3Url: string;
}

/** 默认导出表列表 */
const DEFAULT_TABLES = ['runs', 'spans', 'tool_calls', 'events', 'retry_attempts'];

/** 各表的时间列名（用于 WHERE 过滤） */
const TABLE_TIME_COLUMN: Record<string, string> = {
  runs: 'started_at',
  spans: 'started_at',
  tool_calls: 'started_at',
  events: 'ts',
  retry_attempts: 'ts',
};

/**
 * 将 ClickHouse 数据导出到 S3 Parquet 文件。
 *
 * 对每张表执行 S3 导出，返回各表导出结果（行数 + S3 URL）。
 * 若 S3 引擎函数不可用，自动退化为 INTO OUTFILE 方式。
 */
export async function exportToParquet(
  client: ClickHouseClient,
  opts: ParquetExportOptions,
): Promise<ParquetExportResult[]> {
  const tables = opts.tables ?? DEFAULT_TABLES;
  const fromTs = toChDateTime(opts.fromDate.getTime());
  const toTs = toChDateTime(opts.toDate.getTime());

  const results: ParquetExportResult[] = [];

  for (const table of tables) {
    const timeCol = TABLE_TIME_COLUMN[table] ?? 'started_at';
    const fileLabel = buildFileLabel(table, opts.fromDate, opts.toDate);
    const s3Url = buildS3Url(opts.s3Path, fileLabel);

    // 先查询行数（便于结果汇报与校验）
    const countRows = await client.query<{ c: number }>(
      `SELECT count() AS c FROM ${table} WHERE ${timeCol} >= '${fromTs}' AND ${timeCol} < '${toTs}'`,
    );
    const rows = Number(countRows[0]?.c ?? 0);
    if (rows === 0) {
      console.log(`[archive] ${table}: 无数据可导出，跳过`);
      results.push({ table, rows: 0, s3Url });
      continue;
    }

    // 优先尝试 s3 表函数导出
    const hasCreds = Boolean(opts.accessKey && opts.secretKey);
    const s3FuncUrl = toHttpsS3Url(opts.s3Path, fileLabel);
    const credsPart = hasCreds
      ? `'${escapeSingleQuote(opts.accessKey!)}', '${escapeSingleQuote(opts.secretKey!)}', `
      : '';
    const s3FuncSql =
      `INSERT INTO FUNCTION s3('${escapeSingleQuote(s3FuncUrl)}', ${credsPart}'Parquet') ` +
      `SELECT * FROM ${table} WHERE ${timeCol} >= '${fromTs}' AND ${timeCol} < '${toTs}'`;

    try {
      await client.exec(s3FuncSql);
      console.log(`[archive] ${table}: 导出 ${rows} 行到 ${s3Url}`);
      results.push({ table, rows, s3Url });
    } catch (s3FuncErr) {
      const s3FuncMsg = s3FuncErr instanceof Error ? s3FuncErr.message : String(s3FuncErr);
      console.warn(
        `[archive] ${table}: s3 表函数导出失败（${s3FuncMsg}），尝试 INTO OUTFILE 退化方案`,
      );

      // 退化为 INTO OUTFILE 方式
      const outfileSql =
        `SELECT * FROM ${table} WHERE ${timeCol} >= '${fromTs}' AND ${timeCol} < '${toTs}' ` +
        `INTO OUTFILE '${escapeSingleQuote(s3Url)}' FORMAT Parquet`;
      try {
        await client.exec(outfileSql);
        console.log(`[archive] ${table}: 导出 ${rows} 行到 ${s3Url}（OUTFILE 方式）`);
        results.push({ table, rows, s3Url });
      } catch (outfileErr) {
        const outfileMsg = outfileErr instanceof Error ? outfileErr.message : String(outfileErr);
        throw new Error(
          `[archive] ${table}: S3 导出失败。\n` +
            `  s3 函数错误: ${s3FuncMsg}\n` +
            `  OUTFILE 错误: ${outfileMsg}`,
        );
      }
    }
  }

  return results;
}

/** 构建文件标签：{table}-{fromYYYYMMDD}-{toYYYYMMDD} */
function buildFileLabel(table: string, from: Date, to: Date): string {
  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(
      d.getUTCDate(),
    ).padStart(2, '0')}`;
  return `${table}-${fmt(from)}-${fmt(to)}`;
}

/** 构建 s3:// URL（用于 INTO OUTFILE 与结果汇报） */
function buildS3Url(s3Path: string, fileLabel: string): string {
  const base = s3Path.endsWith('/') ? s3Path : `${s3Path}/`;
  return `${base}${fileLabel}.parquet`;
}

/** 将 s3:// URL 转为 https:// URL（用于 s3 表函数） */
function toHttpsS3Url(s3Path: string, fileLabel: string): string {
  const base = s3Path.endsWith('/') ? s3Path : `${s3Path}/`;
  const s3Url = `${base}${fileLabel}.parquet`;
  // s3://bucket/key → https://s3.amazonaws.com/bucket/key
  if (s3Url.startsWith('s3://')) {
    return `https://s3.amazonaws.com/${s3Url.slice('s3://'.length)}`;
  }
  return s3Url;
}

/** 转义 SQL 字符串中的单引号与反斜杠 */
function escapeSingleQuote(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
