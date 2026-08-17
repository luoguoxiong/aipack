/**
 * stores 模块统一出口 + 工厂函数。
 *
 * createBusinessStores(opts) 根据配置返回一组 Store 实例：
 * - businessStore='sqlite'（默认）：全部走 SQLite（零依赖）
 * - businessStore='mysql'：全部走 MySQL 连接池
 *
 * collector 通过此工厂获取所有业务 Store，注入到各 handler。
 */

import type Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import type {
  TraceStore,
  RunQueryFilter,
  RunListItem,
  TraceDetail,
} from '../store';
import {
  AppStore,
  AppRecord,
  SQLiteAppStore,
  MySQLAppStore,
} from './app-store';
import {
  UserStore,
  UserRecord,
  UserWithCredentials,
  CreateUserInput,
  SQLiteUserStore,
  MySQLUserStore,
} from './user-store';
import {
  ProjectStore,
  ProjectRecord,
  CreateProjectInput,
  SQLiteProjectStore,
  MySQLProjectStore,
} from './project-store';
import {
  AgentDefinitionStore,
  AgentDefinitionRecord,
  AgentDefinitionStatus,
  AgentSpec,
  CreateAgentDefinitionInput,
  UpdateAgentDefinitionInput,
  SQLiteAgentDefinitionStore,
  MySQLAgentDefinitionStore,
} from './agent-definition-store';
import {
  AclStore,
  AclRecord,
  ProjectRole,
  GrantAclInput,
  SQLiteAclStore,
  MySQLAclStore,
} from './acl-store';
import { MysqlPool, runMigrations } from './mysql';
import { ALL_MIGRATIONS } from './migrations/v1-initial-schema';
import { ulid } from './ulid';
import {
  ModelPriceStore,
  ModelPrice,
  UpsertModelPriceInput,
  SQLiteModelPriceStore,
  MySQLModelPriceStore,
} from './model-price-store';
import {
  RedactRuleStore,
  RedactRuleRecord,
  SQLiteRedactRuleStore,
  MySQLRedactRuleStore,
} from './redact-rule-store';

// ESM（本包 type: module）下无全局 require，用 createRequire 兼容原 require('better-sqlite3') 的懒加载写法
const require = createRequire(import.meta.url);

export interface BusinessStores {
  appStore: AppStore;
  userStore: UserStore;
  projectStore: ProjectStore;
  agentDefinitionStore: AgentDefinitionStore;
  aclStore: AclStore;
  /** 关闭所有连接（MySQL 模式下关闭连接池；SQLite 模式 no-op） */
  close(): Promise<void>;
}

export interface CreateBusinessStoresOptions {
  /** 'sqlite'（默认，零依赖）或 'mysql' */
  businessStore?: 'sqlite' | 'mysql';
  /** SQLite 模式：SQLite 文件路径（与 DB_PATH 一致；WAL 模式下多连接安全） */
  sqliteDbPath?: string;
  /** SQLite 模式：已打开的 Database 实例（优先于 sqliteDbPath，由调用方管理生命周期） */
  sqliteDb?: Database.Database;
  /** MySQL 模式：连接串，如 mysql://user:pass@host:3306/db */
  mysqlUrl?: string;
  /** MySQL 模式：是否启动时自动运行迁移（默认 true） */
  autoMigrate?: boolean;
}

/**
 * 创建业务 Store 集合。
 *
 * SQLite 模式：打开 dbPath（或复用传入的 Database），各 Store 自建表（CREATE IF NOT EXISTS）。
 *   与 collector 的 SQLiteStore 是两个独立连接，操作不同表，WAL 模式下并发安全。
 * MySQL 模式：创建连接池 → 运行迁移 → 返回 Store 实例。
 */
export async function createBusinessStores(
  opts: CreateBusinessStoresOptions,
): Promise<BusinessStores> {
  const backend = opts.businessStore ?? 'sqlite';

  if (backend === 'mysql') {
    if (!opts.mysqlUrl) {
      throw new Error('BUSINESS_STORE=mysql 时必须配置 MYSQL_URL');
    }
    const pool = new MysqlPool(opts.mysqlUrl);
    if (opts.autoMigrate !== false) {
      await runMigrations(pool, ALL_MIGRATIONS);
    }
    return {
      appStore: new MySQLAppStore(pool),
      userStore: new MySQLUserStore(pool),
      projectStore: new MySQLProjectStore(pool),
      agentDefinitionStore: new MySQLAgentDefinitionStore(pool),
      aclStore: new MySQLAclStore(pool),
      close: async () => {
        await pool.close();
      },
    };
  }

  // SQLite 模式（默认）
  let db = opts.sqliteDb;
  let ownsDb = false;
  if (!db) {
    if (!opts.sqliteDbPath) {
      throw new Error('BUSINESS_STORE=sqlite 时必须传入 sqliteDbPath 或 sqliteDb');
    }
    // 动态 require better-sqlite3（避免 MySQL 模式下加载原生模块）
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const newDb: Database.Database = new Database(opts.sqliteDbPath);
    newDb.pragma('journal_mode = WAL');
    db = newDb;
    ownsDb = true;
  }
  const sqliteDb: Database.Database = db!;
  return {
    appStore: new SQLiteAppStore(sqliteDb),
    userStore: new SQLiteUserStore(sqliteDb),
    projectStore: new SQLiteProjectStore(sqliteDb),
    agentDefinitionStore: new SQLiteAgentDefinitionStore(sqliteDb),
    aclStore: new SQLiteAclStore(sqliteDb),
    close: async () => {
      if (ownsDb) sqliteDb.close();
    },
  };
}

// ─── 监控库（Phase 2：ClickHouse / Dual） ──────────────────────────

import { SQLiteStore } from '../store';
import { ClickHouseStore, ClickHouseClient } from './clickhouse-store';
import { DualTraceStore } from './dual-trace-store';

export interface CreateTraceStoreOptions {
  /** 后端类型：'sqlite'（默认）/ 'clickhouse' / 'dual' */
  traceStore?: 'sqlite' | 'clickhouse' | 'dual';
  /** SQLite 模式：SQLite 文件路径（与 DB_PATH 一致） */
  sqliteDbPath?: string;
  /** ClickHouse HTTP 端点 */
  clickhouseUrl?: string;
  /** ClickHouse 数据库名（默认 aipack） */
  clickhouseDatabase?: string;
  /** ClickHouse 用户名 */
  clickhouseUsername?: string;
  /** ClickHouse 密码 */
  clickhousePassword?: string;
}

/**
 * 创建监控 Store。
 *
 * - sqlite（默认）：打开 dbPath，零依赖
 * - clickhouse：连接 CH HTTP 端点
 * - dual：SQLite + CH 双写，读取优先 CH（迁移期用）
 *
 * 注意：dual 模式下 SQLiteStore 与 collector 的 SQLiteStore 是两个独立连接，
 * 操作相同表，WAL 模式下并发安全；dual 验证完成后改 traceStore='clickhouse' 切单写。
 */
export async function createTraceStore(opts: CreateTraceStoreOptions): Promise<{
  traceStore: TraceStore;
  close: () => Promise<void>;
}> {
  const backend = opts.traceStore ?? 'sqlite';

  if (backend === 'clickhouse') {
    if (!opts.clickhouseUrl) {
      throw new Error('TRACE_STORE=clickhouse 时必须配置 CLICKHOUSE_URL');
    }
    const ch = new ClickHouseStore({
      url: opts.clickhouseUrl,
      database: opts.clickhouseDatabase ?? 'aipack',
      username: opts.clickhouseUsername,
      password: opts.clickhousePassword,
    });
    await ch.ensureSchema();
    return { traceStore: ch, close: async () => { await ch.close(); } };
  }

  if (backend === 'dual') {
    if (!opts.clickhouseUrl) {
      throw new Error('TRACE_STORE=dual 时必须配置 CLICKHOUSE_URL');
    }
    if (!opts.sqliteDbPath) {
      throw new Error('TRACE_STORE=dual 时必须配置 DB_PATH');
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const sqliteDb: Database.Database = new Database(opts.sqliteDbPath);
    sqliteDb.pragma('journal_mode = WAL');
    const sqliteStore = new SQLiteStore(opts.sqliteDbPath);
    const ch = new ClickHouseStore({
      url: opts.clickhouseUrl,
      database: opts.clickhouseDatabase ?? 'aipack',
      username: opts.clickhouseUsername,
      password: opts.clickhousePassword,
    });
    await ch.ensureSchema();
    const dual = new DualTraceStore({ primary: ch, secondary: sqliteStore });
    return {
      traceStore: dual,
      close: async () => {
        await dual.close();
      },
    };
  }

  // SQLite 模式（默认）：由 collector 内部创建 SQLiteStore，此处返回 undefined
  // collector 检测 traceStore === undefined 时回落内部 SQLiteStore
  return { traceStore: undefined as unknown as TraceStore, close: async () => {} };
}

// ─── 类型导出 ─────────────────────────────────────────────────────

export {
  SQLiteAppStore,
  MySQLAppStore,
  SQLiteUserStore,
  MySQLUserStore,
  SQLiteProjectStore,
  MySQLProjectStore,
  SQLiteAgentDefinitionStore,
  MySQLAgentDefinitionStore,
  SQLiteAclStore,
  MySQLAclStore,
  SQLiteModelPriceStore,
  MySQLModelPriceStore,
  SQLiteRedactRuleStore,
  MySQLRedactRuleStore,
  MysqlPool,
  runMigrations,
  ALL_MIGRATIONS,
  ulid,
  ClickHouseStore,
  ClickHouseClient,
  DualTraceStore,
};
// createTraceStore 已通过 export function 声明导出，此处不再重复
export type {
  AppStore,
  AppRecord,
  UserStore,
  UserRecord,
  UserWithCredentials,
  CreateUserInput,
  ProjectStore,
  ProjectRecord,
  CreateProjectInput,
  AgentDefinitionStore,
  AgentDefinitionRecord,
  AgentDefinitionStatus,
  AgentSpec,
  CreateAgentDefinitionInput,
  UpdateAgentDefinitionInput,
  AclStore,
  AclRecord,
  ProjectRole,
  GrantAclInput,
  ModelPriceStore,
  ModelPrice,
  UpsertModelPriceInput,
  RedactRuleStore,
  RedactRuleRecord,
  TraceStore,
  RunQueryFilter,
  RunListItem,
  TraceDetail,
};
