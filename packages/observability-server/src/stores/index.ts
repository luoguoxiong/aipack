/**
 * stores 模块统一出口 + 工厂函数。
 *
 * createBusinessStores(opts) 创建 MySQL 连接池并返回一组业务 Store 实例。
 * createTraceStore(opts) 创建 ClickHouse 监控 Store。
 *
 * collector 通过这两个工厂获取所有 Store，注入到各 handler。
 */

import type {
  TraceStore,
  RunQueryFilter,
  RunListItem,
  TraceDetail,
} from '../store';
import { AppStore, AppRecord, MySQLAppStore } from './app-store';
import {
  UserStore,
  UserRecord,
  UserWithCredentials,
  CreateUserInput,
  MySQLUserStore,
} from './user-store';
import {
  ProjectStore,
  ProjectRecord,
  CreateProjectInput,
  MySQLProjectStore,
} from './project-store';
import {
  AgentDefinitionStore,
  AgentDefinitionRecord,
  AgentDefinitionStatus,
  AgentSpec,
  CreateAgentDefinitionInput,
  UpdateAgentDefinitionInput,
  MySQLAgentDefinitionStore,
} from './agent-definition-store';
import {
  AclStore,
  AclRecord,
  ProjectRole,
  GrantAclInput,
  MySQLAclStore,
} from './acl-store';
import { MysqlPool, runMigrations } from './mysql';
import { ALL_MIGRATIONS } from './migrations/v1-initial-schema';
import { ulid } from './ulid';
import {
  ModelPriceStore,
  ModelPrice,
  UpsertModelPriceInput,
  MySQLModelPriceStore,
} from './model-price-store';
import {
  RedactRuleStore,
  RedactRuleRecord,
  MySQLRedactRuleStore,
} from './redact-rule-store';
import { MySQLAlertStore } from './alert-store';
import type { AlertStore } from '../store';

export interface BusinessStores {
  appStore: AppStore;
  userStore: UserStore;
  projectStore: ProjectStore;
  agentDefinitionStore: AgentDefinitionStore;
  aclStore: AclStore;
  /** 告警存储（alert_rules / alert_events 落 MySQL） */
  alertStore: AlertStore;
  /** 关闭所有连接（关闭 MySQL 连接池） */
  close(): Promise<void>;
}

export interface CreateBusinessStoresOptions {
  /** MySQL 连接串，如 mysql://user:pass@host:3306/db */
  mysqlUrl: string;
  /** 是否启动时自动运行迁移（默认 true） */
  autoMigrate?: boolean;
}

/**
 * 创建业务 Store 集合（MySQL）：
 * 创建连接池 → 运行迁移 → 返回 Store 实例。
 */
export async function createBusinessStores(
  opts: CreateBusinessStoresOptions,
): Promise<BusinessStores> {
  if (!opts.mysqlUrl) {
    throw new Error('必须配置 MYSQL_URL（如 mysql://user:pass@host:3306/db）');
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
    alertStore: new MySQLAlertStore(pool),
    close: async () => {
      await pool.close();
    },
  };
}

// ─── 监控库（ClickHouse） ─────────────────────────────────────────

import { ClickHouseStore, ClickHouseClient } from './clickhouse-store';

export interface CreateTraceStoreOptions {
  /** ClickHouse HTTP 端点 */
  clickhouseUrl: string;
  /** ClickHouse 数据库名（默认 aipack） */
  clickhouseDatabase?: string;
  /** ClickHouse 用户名 */
  clickhouseUsername?: string;
  /** ClickHouse 密码 */
  clickhousePassword?: string;
}

/**
 * 创建监控 Store（ClickHouse）：连接 CH HTTP 端点并校验连通。
 */
export async function createTraceStore(opts: CreateTraceStoreOptions): Promise<{
  traceStore: TraceStore;
  close: () => Promise<void>;
}> {
  if (!opts.clickhouseUrl) {
    throw new Error('必须配置 CLICKHOUSE_URL（如 http://localhost:8123）');
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

// ─── 类型导出 ─────────────────────────────────────────────────────

export {
  MySQLAppStore,
  MySQLUserStore,
  MySQLProjectStore,
  MySQLAgentDefinitionStore,
  MySQLAclStore,
  MySQLModelPriceStore,
  MySQLRedactRuleStore,
  MySQLAlertStore,
  MysqlPool,
  runMigrations,
  ALL_MIGRATIONS,
  ulid,
  ClickHouseStore,
  ClickHouseClient,
};
// createTraceStore / createBusinessStores 已通过 export function 声明导出，此处不再重复
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
