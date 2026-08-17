/**
 * ClickHouse HTTP 客户端（零依赖，用 Node 18+ 内置 fetch）。
 *
 * 协议：
 * - 写入：POST `/?query=INSERT+INTO+<table>+FORMAT+JSONEachRow`，body 是换行分隔的 JSON
 * - 查询：POST `/?query=<SQL>+FORMAT+JSONEachRow`，返回换行分隔的 JSON
 * - 鉴权：HTTP Basic（user:password）
 *
 * 批量写入策略：
 * - ClickHouse 单次 INSERT 即批量（与 SQLite 逐行不同）
 * - SDK 已批量上报，collector 直接把 batch 转为 JSONEachRow 一次 INSERT
 * - 无需内存再攒批（避免宕机丢数据）
 *
 * 连接配置：
 * - url：如 http://localhost:8123
 * - database：如 aipack
 * - username / password
 * - 默认超时 30s（大查询可调）
 */

export interface ClickHouseClientOptions {
  /** HTTP 端点，如 http://localhost:8123 */
  url: string;
  /** 数据库名，默认 aipack */
  database?: string;
  /** 用户名 */
  username?: string;
  /** 密码 */
  password?: string;
  /** 请求超时 ms（默认 30000） */
  timeoutMs?: number;
}

/** JSONEachRow 单行（任意对象） */
export type JsonEachRow = Record<string, unknown>;

export class ClickHouseClient {
  private url: string;
  private database: string;
  private authHeader?: string;
  private timeoutMs: number;

  constructor(opts: ClickHouseClientOptions) {
    this.url = opts.url.replace(/\/$/, '');
    this.database = opts.database ?? 'aipack';
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    if (opts.username) {
      const token = Buffer.from(`${opts.username}:${opts.password ?? ''}`).toString('base64');
      this.authHeader = `Basic ${token}`;
    }
  }

  /**
   * 批量插入行到指定表（FORMAT JSONEachRow）。
   * rows 为空时 no-op。
   */
  async insert(table: string, rows: JsonEachRow[]): Promise<void> {
    if (rows.length === 0) return;
    const sql = `INSERT INTO ${this.database}.${table} FORMAT JSONEachRow`;
    const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    await this.request(sql, body);
  }

  /**
   * 执行查询，返回 JSONEachRow 解析后的对象数组。
   */
  async query<T = JsonEachRow>(sql: string): Promise<T[]> {
    const fullSql = `${sql} FORMAT JSONEachRow`;
    const body = await this.request(fullSql, undefined);
    if (!body.trim()) return [];
    const lines = body.trim().split('\n');
    return lines.map((l) => JSON.parse(l) as T);
  }

  /**
   * 执行无返回 SQL（DDL / ALTER / TRUNCATE）。
   */
  async exec(sql: string): Promise<void> {
    await this.request(sql, undefined);
  }

  /** 健康检查：ping */
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/ping`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** 关闭（HTTP 无状态，no-op） */
  async close(): Promise<void> {
    // HTTP 客户端无连接池，无需关闭
  }

  /** 底层 HTTP 请求 */
  private async request(query: string, body?: string): Promise<string> {
    const url = new URL(this.url);
    url.searchParams.set('query', query);
    if (this.database) url.searchParams.set('database', this.database);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(this.authHeader ? { Authorization: this.authHeader } : {}),
      },
      body: body ?? '',
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ClickHouse ${res.status}: ${text.slice(0, 500)}`);
    }
    return res.text();
  }
}

/** CH DateTime64(3) 期望的格式：'2024-01-01 12:34:56.789' */
export function toChDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

/** CH Enum 值：status 字符串映射到枚举索引（与 init.sql 一致） */
export const RUN_STATUS_INDEX: Record<string, number> = {
  success: 1,
  error: 2,
  validation: 3,
};

export const SPAN_STATUS_INDEX: Record<string, number> = {
  ok: 1,
  error: 2,
};

export const TOOL_STATUS_INDEX: Record<string, number> = {
  ok: 1,
  error: 2,
  blocked: 3,
  skipped: 4,
};
