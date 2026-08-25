/**
 * TraceStore / AlertStore 接口定义。
 *
 * 实现类：
 * - TraceStore：ClickHouseStore（src/stores/clickhouse-store.ts，列式存储，亿级检索）
 * - AlertStore：MySQLAlertStore（src/stores/alert-store.ts）
 *
 * 记录类型（RunRecord/SpanRecord/ToolCallRecord）来自 @aipack-ai/observability。
 */

import type { RunRecord, SpanRecord, ToolCallRecord, EventRecord, RetryRecord, EventBatch } from '@aipack-ai/observability';
import type { AlertMetric, AlertOperator } from './alerts/rules';
import type { VersionMetrics } from './types';

export interface RunQueryFilter {
  since?: number;
  until?: number;
  status?: string;
  model?: string;
  tool?: string;
  sessionKey?: string;
  appId?: string;
  /** 发布版本精确匹配；历史数据 version 为 NULL 时以 'unknown' 匹配 */
  version?: string;
  offset: number;
  limit: number;
}

export interface RunListItem extends RunRecord {
  /** 该 trace 的模型重试次数（spans 表聚合） */
  retries: number;
  /** 上报来源应用（app_id 戳） */
  appId?: string;
}

export interface TraceDetail {
  run: RunRecord;
  spans: SpanRecord[];
  tools: ToolCallRecord[];
  /** P2-1 自定义事件（按时间正序，与 span 时间轴混排） */
  events: EventRecord[];
  /** P2-2 per-attempt 重试明细（按时间正序） */
  retries: RetryRecord[];
}

export interface ErrorClassCountItem {
  errorClass: string;
  count: number;
}

export interface ErrorClassDrillResult {
  errorClass: string;
  /** 最近 N 条该类错误的 trace 摘要 */
  recentTraces: Array<{
    traceId: string;
    startedAt: number;
    durationMs: number;
    model?: string;
    appId?: string;
    sessionKey?: string;
  }>;
  /** 模型分布（各模型出现该错误的次数） */
  byModel: Record<string, number>;
  /** 工具分布（各工具调用引发该错误的次数；blocked/skipped 不计入） */
  byTool: Record<string, number>;
}

export interface ErrorClassFilter {
  since?: number;
  until?: number;
  appId?: string;
  limit?: number;
}

export interface TraceStore {
  insertRun(r: RunRecord): Promise<void>;
  insertSpan(s: SpanRecord): Promise<void>;
  insertToolCall(t: ToolCallRecord): Promise<void>;
  queryRuns(filter: RunQueryFilter): Promise<{ total: number; items: RunListItem[] }>;
  queryTrace(traceId: string): Promise<TraceDetail | undefined>;
  /** S1 安全修复：查 trace 归属 app（轻量点查，多用户模式查询端点做归属校验用） */
  getRunAppId(traceId: string): Promise<string | undefined>;
  /** 按版本聚合（DB 直查，非内存窗口），返回按 lastSeenAt 倒序 */
  queryVersionMetrics(filter: { since?: number; until?: number; appId?: string }): Promise<VersionMetrics[]>;
  /** Phase 9 — 错误类 TopN 计数（面板卡片） */
  queryErrorClassCounts(filter: ErrorClassFilter): Promise<ErrorClassCountItem[]>;
  /** Phase 9 — 错误归因下钻：最近 N traces + 工具/模型分布 */
  queryErrorClassDrill(filter: ErrorClassFilter & { errorClass: string }): Promise<ErrorClassDrillResult>;
  /** 批量写入，由收集端 ingest 调用；appId 由鉴权头推导并盖戳 */
  flush(batch: EventBatch, appId: string): Promise<void>;
  /** 删除 started_at 早于 before 的明细，返回删除行数 */
  prune(before: number): Promise<number>;
  /** 快照备份，返回备份文件路径（ClickHouse 由运维侧 BACKUP 命令承担） */
  backup(dir: string): Promise<string>;
  /** F10 修复：健康检查（存储不可达时抛错），供 /healthz 探测实际 traceStore */
  healthCheck(): Promise<void>;
  close(): Promise<void>;
}

/** 应用存储（apps 表）：面板动态管理 appId/appSecret — 异步接口，见 stores/app-store.ts */
export type { AppStore, AppRecord } from './stores/app-store';

/** 告警规则（alert_rules 表，面板 CRUD） */
export interface AlertRuleRow {
  id: string;
  name: string;
  /** 缺省 = 全局（所有应用合并） */
  appId?: string;
  metric: AlertMetric;
  operator: AlertOperator; // lt | lte | gt | gte
  threshold: number;
  lookbackMs: number;
  cooldownMs: number;
  webhookUrl?: string;
  /** metric=toolSuccessRate 时目标工具 */
  toolName?: string;
  /** metric=errorClassCount 时目标错误分类 */
  errorClass?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 告警事件（alert_events 表，触发/恢复历史） */
export interface AlertEventRow {
  id: number;
  ruleId: string;
  ruleName: string;
  appId?: string;
  metric: string;
  operator: string;
  threshold: number;
  value: number;
  status: 'fired' | 'recovered';
  createdAt: number;
}

/** 告警存储（alert_rules / alert_events 表） — 异步接口 */
export interface AlertStore {
  listAlertRules(): Promise<AlertRuleRow[]>;
  getAlertRule(id: string): Promise<AlertRuleRow | undefined>;
  createAlertRule(rule: AlertRuleRow): Promise<void>;
  updateAlertRule(id: string, patch: Partial<AlertRuleRow>): Promise<AlertRuleRow | undefined>;
  deleteAlertRule(id: string): Promise<boolean>;
  insertAlertEvent(ev: Omit<AlertEventRow, 'id'>): Promise<void>;
  listAlertEvents(opts: {
    offset: number;
    limit: number;
    status?: string;
  }): Promise<{ total: number; items: AlertEventRow[] }>;
}
