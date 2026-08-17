/**
 * MySQL 连接池 + 迁移 runner（Phase 1）。
 *
 * - 连接池：mysql2/promise，Pool 可复用
 * - 迁移：编号化 SQL 文件，applied 记录在 schema_migrations 表
 * - 动态导入 mysql2：BUSINESS_STORE=sqlite 时不加载，保持零依赖
 *
 * 连接串示例：mysql://aipack:aipackpass@localhost:3306/aipack
 */

import { createRequire } from 'node:module';
import type { Pool, PoolOptions, RowDataPacket, ResultSetHeader } from 'mysql2/promise';

const require = createRequire(import.meta.url);

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** MySQL 连接池包装器 */
export class MysqlPool {
  private pool: Pool;
  private closed = false;

  constructor(uri: string, opts?: Partial<PoolOptions>) {
    // 动态 require mysql2（避免 BUSINESS_STORE=sqlite 时打包报错）
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
    this.pool = mysql.createPool({
      uri,
      connectionLimit: 10,
      waitForConnections: true,
      charset: 'utf8mb4',
      timezone: 'Z',
      ...opts,
    });
  }

  /** 执行查询（返回行数组） */
  async query<T extends RowDataPacket[] = RowDataPacket[]>(
    sql: string,
    params?: unknown[],
  ): Promise<T> {
    const [rows] = await this.pool.query<T>(sql, params ?? []);
    return rows;
  }

  /** 执行写操作（INSERT/UPDATE/DELETE），返回影响行数与 insertId */
  async execute(
    sql: string,
    params?: unknown[],
  ): Promise<{ affectedRows: number; insertId: number }> {
    const [result] = await this.pool.execute<ResultSetHeader>(sql, (params ?? []) as never[]);
    return { affectedRows: result.affectedRows, insertId: result.insertId };
  }

  /** 事务：fn 内所有操作在同一个连接上执行 */
  async transaction<T>(fn: (conn: MysqlConnection) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(new MysqlConnection(conn));
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}

/** 事务内连接包装器 */
export class MysqlConnection {
  constructor(private conn: import('mysql2/promise').PoolConnection) {}

  async query<T extends RowDataPacket[] = RowDataPacket[]>(
    sql: string,
    params?: unknown[],
  ): Promise<T> {
    const [rows] = await this.conn.query<T>(sql, params ?? []);
    return rows;
  }

  async execute(
    sql: string,
    params?: unknown[],
  ): Promise<{ affectedRows: number; insertId: number }> {
    const [result] = await this.conn.execute<ResultSetHeader>(sql, (params ?? []) as never[]);
    return { affectedRows: result.affectedRows, insertId: result.insertId };
  }
}

/**
 * 迁移 runner：按 version 顺序应用未执行的迁移。
 * - 幂等：schema_migrations 表记录已应用版本
 * - 事务安全：每个迁移在独立事务中执行
 * - 初始化：首次运行自动创建 schema_migrations 表
 */
export async function runMigrations(pool: MysqlPool, migrations: Migration[]): Promise<void> {
  // 确保迁移表存在
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INT NOT NULL,
      name       VARCHAR(200) NOT NULL,
      applied_at BIGINT NOT NULL,
      PRIMARY KEY (version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const applied = await pool.query<RowDataPacket[]>(
    'SELECT version FROM schema_migrations ORDER BY version ASC',
  );
  const appliedSet = new Set(applied.map((r) => r.version));

  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (const m of sorted) {
    if (appliedSet.has(m.version)) continue;
    await pool.transaction(async (conn) => {
      // 执行迁移 SQL（可能含多条语句，用 multi-statement）
      const statements = m.sql
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const stmt of statements) {
        await conn.execute(stmt);
      }
      await conn.execute(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        [m.version, m.name, Date.now()],
      );
    });
    console.log(`[observability-server] MySQL 迁移 v${m.version} (${m.name}) 已应用`);
  }
}

/** better-sqlite3 不接受 undefined 参数，MySQL 同样需要统一转 null */
export function toNull(v: unknown): unknown {
  return v === undefined ? null : v;
}
