/**
 * AppStore 接口 + MySQL 实现。
 *
 * 接口从 src/store.ts 的 AppStore 抽离，保持方法签名一致。
 * MySQLAppStore 走 mysql2 连接池，DDL 见 src/stores/migrations/。
 *
 * collector 通过 opts.businessStores 注入。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { MysqlPool } from './mysql';

/** 面板应用（appId + appSecret，动态创建） */
export interface AppRecord {
  appId: string;
  appSecret: string;
  name: string;
  createdAt: number;
  /** 最近一次成功上报时间（epoch ms）；未上报过为 undefined */
  lastSeenAt?: number;
}

/** 应用存储接口（appId + appSecret 管理）— 异步，MySQL 实现 */
export interface AppStore {
  createApp(name: string): Promise<AppRecord>;
  listApps(): Promise<AppRecord[]>;
  deleteApp(appId: string): Promise<boolean>;
  getApp(appId: string): Promise<AppRecord | undefined>;
  /** 校验上报鉴权（appId + appSecret） */
  verifyApp(appId: string, appSecret: string): Promise<boolean>;
  /** 重置应用密钥，返回新 secret */
  regenerateSecret(appId: string): Promise<string | undefined>;
  /** 上报成功后刷新 last_seen_at */
  touchApp(appId: string, ts: number): Promise<void>;
  /** 启动时种入静态白名单（OBS_APPS），已存在则跳过 */
  seedApps(apps: Record<string, string>): Promise<void>;
  close(): Promise<void>;
}

// ─── MySQL 实现 ───────────────────────────────────────────────────

export class MySQLAppStore implements AppStore {
  constructor(private pool: MysqlPool) {}

  async createApp(name: string): Promise<AppRecord> {
    const now = Date.now();
    const record: AppRecord = {
      appId: `app_${randomHex(8)}`,
      appSecret: `sk_${randomHex(24)}`,
      name,
      createdAt: now,
    };
    await this.pool.execute(
      'INSERT INTO apps (app_id, app_secret, name, created_at) VALUES (?, ?, ?, ?)',
      [record.appId, record.appSecret, record.name, record.createdAt],
    );
    return record;
  }

  async listApps(): Promise<AppRecord[]> {
    const rows = await this.pool.query(
      'SELECT * FROM apps ORDER BY created_at DESC',
    );
    return (rows as Array<Record<string, unknown>>).map(rowToApp);
  }

  async deleteApp(appId: string): Promise<boolean> {
    const { affectedRows } = await this.pool.execute('DELETE FROM apps WHERE app_id = ?', [appId]);
    return affectedRows > 0;
  }

  async getApp(appId: string): Promise<AppRecord | undefined> {
    const rows = await this.pool.query('SELECT * FROM apps WHERE app_id = ?', [appId]);
    const row = (rows as Array<Record<string, unknown>>)[0];
    return row ? rowToApp(row) : undefined;
  }

  async verifyApp(appId: string, appSecret: string): Promise<boolean> {
    const app = await this.getApp(appId);
    return !!app && safeEqual(app.appSecret, appSecret);
  }

  async regenerateSecret(appId: string): Promise<string | undefined> {
    const secret = `sk_${randomHex(24)}`;
    const { affectedRows } = await this.pool.execute(
      'UPDATE apps SET app_secret = ? WHERE app_id = ?',
      [secret, appId],
    );
    return affectedRows > 0 ? secret : undefined;
  }

  async touchApp(appId: string, ts: number): Promise<void> {
    await this.pool.execute('UPDATE apps SET last_seen_at = ? WHERE app_id = ?', [ts, appId]);
  }

  async seedApps(apps: Record<string, string>): Promise<void> {
    const now = Date.now();
    for (const [appId, appSecret] of Object.entries(apps)) {
      if (appId && appSecret) {
        await this.pool.execute(
          'INSERT IGNORE INTO apps (app_id, app_secret, name, created_at) VALUES (?, ?, ?, ?)',
          [appId, appSecret, appId, now],
        );
      }
    }
  }

  async close(): Promise<void> {
    // MysqlPool 由调用方管理生命周期
  }
}

// ─── 辅助 ──────────────────────────────────────────────────────────

function rowToApp(r: Record<string, unknown>): AppRecord {
  return {
    appId: String(r.app_id),
    appSecret: String(r.app_secret),
    name: String(r.name),
    createdAt: Number(r.created_at),
    lastSeenAt: r.last_seen_at === null || r.last_seen_at === undefined ? undefined : Number(r.last_seen_at),
  };
}

/** 密码/密钥恒时比较，防时序侧信道 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

