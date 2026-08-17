/**
 * ModelPriceStore 接口 + 双实现（SQLite / MySQL）。
 *
 * Phase 6：模型价格管理，支撑 worker 端 CostCalculator 按 model span 计算成本（分）。
 *
 * 表结构：
 * - MySQL：DDL 见 src/stores/migrations/v1-initial-schema.ts（model_prices 表，由迁移自动建表）
 * - SQLite：构造时 CREATE IF NOT EXISTS（与 collector 同库，零依赖）
 *
 * 主键：(model_id, effective_at) — 同 modelId 不同 effectiveAt 表示历史价格档，
 *       getLatestPrice 按 effective_at <= at 取最新生效价。
 *
 * upsert 语义：同 (modelId, effectiveAt) 覆盖（SQLite INSERT OR REPLACE / MySQL ON DUPLICATE KEY UPDATE）。
 */

import type Database from 'better-sqlite3';
import type { MysqlPool } from './mysql';

/** 模型价格（$/1M tokens，按 effectiveAt 生效） */
export interface ModelPrice {
  modelId: string;
  /** 输入 token 单价（$/1M tokens） */
  inputPer1m: number;
  /** 输出 token 单价（$/1M tokens） */
  outputPer1m: number;
  /** 缓存读取 token 单价（$/1M tokens，默认 0） */
  cacheReadPer1m: number;
  /** 缓存写入 token 单价（$/1M tokens，默认 0） */
  cacheWritePer1m: number;
  /** 币种（默认 'USD'） */
  currency: string;
  /** 生效时间（epoch ms） */
  effectiveAt: number;
}

/** upsert 输入：cacheRead/Write/currency 可缺省，默认 0 / 'USD' */
export interface UpsertModelPriceInput {
  modelId: string;
  inputPer1m: number;
  outputPer1m: number;
  cacheReadPer1m?: number;
  cacheWritePer1m?: number;
  currency?: string;
  effectiveAt: number;
}

/** 模型价格存储接口 — 异步，兼容 SQLite/MySQL */
export interface ModelPriceStore {
  /** 取某 modelId 在 at（默认 now）时刻的最新生效价 */
  getLatestPrice(modelId: string, at?: number): Promise<ModelPrice | undefined>;
  /** 列出所有价格（按 modelId、effectiveAt 升序） */
  list(): Promise<ModelPrice[]>;
  /** 插入或覆盖（同 modelId+effectiveAt 覆盖） */
  upsert(input: UpsertModelPriceInput): Promise<ModelPrice>;
  /** 删除指定 (modelId, effectiveAt) 行 */
  delete(modelId: string, effectiveAt: number): Promise<boolean>;
  close(): Promise<void>;
}

// ─── SQLite 实现（零依赖默认） ──────────────────────────────────

const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS model_prices (
  model_id           TEXT    NOT NULL,
  input_per_1m       REAL    NOT NULL,
  output_per_1m      REAL    NOT NULL,
  cache_read_per_1m  REAL    NOT NULL DEFAULT 0,
  cache_write_per_1m REAL    NOT NULL DEFAULT 0,
  currency           TEXT    NOT NULL DEFAULT 'USD',
  effective_at       INTEGER NOT NULL,
  PRIMARY KEY (model_id, effective_at)
);
CREATE INDEX IF NOT EXISTS idx_mp_model ON model_prices(model_id, effective_at);
`;

export class SQLiteModelPriceStore implements ModelPriceStore {
  constructor(private db: Database.Database) {
    this.db.exec(SQLITE_DDL);
  }

  async getLatestPrice(modelId: string, at: number = Date.now()): Promise<ModelPrice | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM model_prices
         WHERE model_id = ? AND effective_at <= ?
         ORDER BY effective_at DESC LIMIT 1`,
      )
      .get(modelId, at) as Record<string, unknown> | undefined;
    return row ? rowToModelPrice(row) : undefined;
  }

  async list(): Promise<ModelPrice[]> {
    const rows = this.db
      .prepare('SELECT * FROM model_prices ORDER BY model_id ASC, effective_at ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToModelPrice);
  }

  async upsert(input: UpsertModelPriceInput): Promise<ModelPrice> {
    const record = normalizeInput(input);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO model_prices
         (model_id, input_per_1m, output_per_1m, cache_read_per_1m, cache_write_per_1m, currency, effective_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.modelId,
        record.inputPer1m,
        record.outputPer1m,
        record.cacheReadPer1m,
        record.cacheWritePer1m,
        record.currency,
        record.effectiveAt,
      );
    return record;
  }

  async delete(modelId: string, effectiveAt: number): Promise<boolean> {
    const result = this.db
      .prepare('DELETE FROM model_prices WHERE model_id = ? AND effective_at = ?')
      .run(modelId, effectiveAt);
    return result.changes > 0;
  }

  async close(): Promise<void> {}
}

// ─── MySQL 实现 ──────────────────────────────────────────────────

export class MySQLModelPriceStore implements ModelPriceStore {
  constructor(private pool: MysqlPool) {}

  async getLatestPrice(modelId: string, at: number = Date.now()): Promise<ModelPrice | undefined> {
    const rows = await this.pool.query(
      `SELECT * FROM model_prices
       WHERE model_id = ? AND effective_at <= ?
       ORDER BY effective_at DESC LIMIT 1`,
      [modelId, at],
    );
    const row = (rows as Array<Record<string, unknown>>)[0];
    return row ? rowToModelPrice(row) : undefined;
  }

  async list(): Promise<ModelPrice[]> {
    const rows = await this.pool.query(
      `SELECT * FROM model_prices ORDER BY model_id ASC, effective_at ASC`,
    );
    return (rows as Array<Record<string, unknown>>).map(rowToModelPrice);
  }

  async upsert(input: UpsertModelPriceInput): Promise<ModelPrice> {
    const record = normalizeInput(input);
    await this.pool.execute(
      `INSERT INTO model_prices
       (model_id, input_per_1m, output_per_1m, cache_read_per_1m, cache_write_per_1m, currency, effective_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         input_per_1m = VALUES(input_per_1m),
         output_per_1m = VALUES(output_per_1m),
         cache_read_per_1m = VALUES(cache_read_per_1m),
         cache_write_per_1m = VALUES(cache_write_per_1m),
         currency = VALUES(currency)`,
      [
        record.modelId,
        record.inputPer1m,
        record.outputPer1m,
        record.cacheReadPer1m,
        record.cacheWritePer1m,
        record.currency,
        record.effectiveAt,
      ],
    );
    return record;
  }

  async delete(modelId: string, effectiveAt: number): Promise<boolean> {
    const { affectedRows } = await this.pool.execute(
      'DELETE FROM model_prices WHERE model_id = ? AND effective_at = ?',
      [modelId, effectiveAt],
    );
    return affectedRows > 0;
  }

  async close(): Promise<void> {}
}

// ─── 辅助 ──────────────────────────────────────────────────────────

/** 将 upsert 输入归一化为完整 ModelPrice（补默认值） */
function normalizeInput(input: UpsertModelPriceInput): ModelPrice {
  return {
    modelId: input.modelId,
    inputPer1m: input.inputPer1m,
    outputPer1m: input.outputPer1m,
    cacheReadPer1m: input.cacheReadPer1m ?? 0,
    cacheWritePer1m: input.cacheWritePer1m ?? 0,
    currency: input.currency ?? 'USD',
    effectiveAt: input.effectiveAt,
  };
}

/** DB 行 → ModelPrice（兼容 SQLite REAL / MySQL DECIMAL，统一转 Number） */
function rowToModelPrice(r: Record<string, unknown>): ModelPrice {
  return {
    modelId: String(r.model_id),
    inputPer1m: Number(r.input_per_1m),
    outputPer1m: Number(r.output_per_1m),
    cacheReadPer1m: Number(r.cache_read_per_1m ?? 0),
    cacheWritePer1m: Number(r.cache_write_per_1m ?? 0),
    currency: String(r.currency ?? 'USD'),
    effectiveAt: Number(r.effective_at),
  };
}
