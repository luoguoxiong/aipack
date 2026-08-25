/**
 * AlertStore 接口 + MySQL 实现。
 *
 * 接口与 src/store.ts 中的 AlertStore 保持一致（异步）。
 * MySQLAlertStore 走 mysql2 连接池，DDL 见 migrations/v3-alert-tables.ts。
 *
 * collector 通过 opts.alertStore / businessStores.alertStore 注入。
 */

import type { AlertRuleRow, AlertEventRow, AlertStore } from '../store';
import type { MysqlPool } from './mysql';

export type { AlertStore, AlertRuleRow, AlertEventRow };

// ─── MySQL 实现 ───────────────────────────────────────────────────

export class MySQLAlertStore implements AlertStore {
  constructor(private pool: MysqlPool) {}

  async listAlertRules(): Promise<AlertRuleRow[]> {
    const rows = await this.pool.query('SELECT * FROM alert_rules ORDER BY created_at ASC');
    return (rows as Array<Record<string, unknown>>).map(rowToAlertRule);
  }

  async getAlertRule(id: string): Promise<AlertRuleRow | undefined> {
    const rows = await this.pool.query('SELECT * FROM alert_rules WHERE id = ?', [id]);
    const row = (rows as Array<Record<string, unknown>>)[0];
    return row ? rowToAlertRule(row) : undefined;
  }

  async createAlertRule(rule: AlertRuleRow): Promise<void> {
    await this.pool.execute(
      `INSERT INTO alert_rules
         (id, name, app_id, metric, operator, threshold, lookback_ms, cooldown_ms,
          webhook_url, tool_name, error_class, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rule.id, rule.name, nullOr(rule.appId), rule.metric, rule.operator, rule.threshold,
        rule.lookbackMs, rule.cooldownMs, nullOr(rule.webhookUrl), nullOr(rule.toolName),
        nullOr(rule.errorClass), rule.enabled ? 1 : 0, rule.createdAt, rule.updatedAt,
      ],
    );
  }

  async updateAlertRule(id: string, patch: Partial<AlertRuleRow>): Promise<AlertRuleRow | undefined> {
    const existing = await this.getAlertRule(id);
    if (!existing) return undefined;
    const merged: AlertRuleRow = { ...existing, ...patch, id, updatedAt: Date.now() };
    await this.pool.execute(
      `UPDATE alert_rules SET
         name = ?, app_id = ?, metric = ?, operator = ?, threshold = ?,
         lookback_ms = ?, cooldown_ms = ?, webhook_url = ?, tool_name = ?,
         error_class = ?, enabled = ?, updated_at = ?
       WHERE id = ?`,
      [
        merged.name, nullOr(merged.appId), merged.metric, merged.operator, merged.threshold,
        merged.lookbackMs, merged.cooldownMs, nullOr(merged.webhookUrl), nullOr(merged.toolName),
        nullOr(merged.errorClass), merged.enabled ? 1 : 0, merged.updatedAt, id,
      ],
    );
    return this.getAlertRule(id);
  }

  async deleteAlertRule(id: string): Promise<boolean> {
    const { affectedRows } = await this.pool.execute('DELETE FROM alert_rules WHERE id = ?', [id]);
    return affectedRows > 0;
  }

  async insertAlertEvent(ev: Omit<AlertEventRow, 'id'>): Promise<void> {
    await this.pool.execute(
      `INSERT INTO alert_events
         (rule_id, rule_name, app_id, metric, operator, threshold, value, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ev.ruleId, ev.ruleName, nullOr(ev.appId), ev.metric, ev.operator, ev.threshold,
        ev.value, ev.status, ev.createdAt,
      ],
    );
  }

  async listAlertEvents(opts: {
    offset: number;
    limit: number;
    status?: string;
  }): Promise<{ total: number; items: AlertEventRow[] }> {
    const where = opts.status ? 'WHERE status = ?' : '';
    const params = opts.status ? [opts.status] : [];
    const countRows = await this.pool.query(`SELECT COUNT(*) AS c FROM alert_events ${where}`, params);
    const total = Number((countRows as Array<{ c: number | string }>)[0]?.c ?? 0);
    const rows = await this.pool.query(
      `SELECT * FROM alert_events ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, opts.limit, opts.offset],
    );
    return { total, items: (rows as Array<Record<string, unknown>>).map(rowToAlertEvent) };
  }

  async close(): Promise<void> {
    // MysqlPool 由调用方管理生命周期
  }
}

// ─── 辅助 ──────────────────────────────────────────────────────────

function nullOr(v: string | undefined): string | null {
  // 对齐 src/store.ts 的 n()：仅 undefined → null，空串保持原样（语义一致）
  return v === undefined ? null : v;
}

function optStr(v: unknown): string | undefined {
  return v === null || v === undefined ? undefined : String(v);
}

function rowToAlertRule(r: Record<string, unknown>): AlertRuleRow {
  return {
    id: String(r.id),
    name: String(r.name),
    appId: optStr(r.app_id),
    metric: String(r.metric) as AlertRuleRow['metric'],
    operator: String(r.operator) as AlertRuleRow['operator'],
    threshold: Number(r.threshold),
    lookbackMs: Number(r.lookback_ms),
    cooldownMs: Number(r.cooldown_ms),
    webhookUrl: optStr(r.webhook_url),
    toolName: optStr(r.tool_name),
    errorClass: optStr(r.error_class),
    enabled: Number(r.enabled) === 1,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function rowToAlertEvent(r: Record<string, unknown>): AlertEventRow {
  return {
    id: Number(r.id),
    ruleId: String(r.rule_id),
    ruleName: String(r.rule_name),
    appId: optStr(r.app_id),
    metric: String(r.metric),
    operator: String(r.operator),
    threshold: Number(r.threshold),
    value: Number(r.value),
    status: String(r.status) as AlertEventRow['status'],
    createdAt: Number(r.created_at),
  };
}
