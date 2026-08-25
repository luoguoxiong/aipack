/**
 * RedactRuleStore — 项目级 PII 脱敏规则存储（Phase 9）。
 *
 * 规则定义正则 + 动作（mask / hash / drop），按项目隔离。
 * 采集端在落盘前应用规则对 trace 内容做脱敏。
 *
 * 实现：MySQLRedactRuleStore（mysql2/promise）
 */

import type { MysqlPool } from './mysql';
import { ulid } from './ulid';

export interface RedactRuleRecord {
  id: string; // ULID
  projectId: string;
  name: string; // 规则名（如 'phone', 'email'）
  pattern: string; // 正则字符串
  action: 'mask' | 'hash' | 'drop';
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateRedactRuleInput {
  name: string;
  pattern: string;
  action: RedactRuleRecord['action'];
  enabled?: boolean;
}

export interface UpdateRedactRuleInput {
  pattern?: string;
  action?: RedactRuleRecord['action'];
  enabled?: boolean;
}

export interface RedactRuleStore {
  list(projectId: string): Promise<RedactRuleRecord[]>;
  create(projectId: string, input: CreateRedactRuleInput): Promise<RedactRuleRecord>;
  update(id: string, patch: UpdateRedactRuleInput): Promise<RedactRuleRecord | undefined>;
  delete(id: string): Promise<boolean>;
}

// ─── MySQL 实现 ───────────────────────────────────────────────────

export class MySQLRedactRuleStore implements RedactRuleStore {
  constructor(private pool: MysqlPool) {}

  async list(projectId: string): Promise<RedactRuleRecord[]> {
    const rows = await this.pool.query(
      'SELECT * FROM redact_rules WHERE project_id = ? ORDER BY created_at ASC',
      [projectId],
    );
    return (rows as Array<Record<string, unknown>>).map(rowToRedactRule);
  }

  async create(projectId: string, input: CreateRedactRuleInput): Promise<RedactRuleRecord> {
    const id = ulid();
    const now = Date.now();
    const enabled = input.enabled ?? true;
    await this.pool.execute(
      `INSERT INTO redact_rules (id, project_id, name, pattern, action, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, projectId, input.name, input.pattern, input.action, enabled ? 1 : 0, now, now],
    );
    return {
      id,
      projectId,
      name: input.name,
      pattern: input.pattern,
      action: input.action,
      enabled,
      createdAt: now,
      updatedAt: now,
    };
  }

  async update(id: string, patch: UpdateRedactRuleInput): Promise<RedactRuleRecord | undefined> {
    const existing = await this.getById(id);
    if (!existing) return undefined;
    const now = Date.now();
    const pattern = patch.pattern !== undefined ? patch.pattern : existing.pattern;
    const action = patch.action !== undefined ? patch.action : existing.action;
    const enabled = patch.enabled !== undefined ? patch.enabled : existing.enabled;
    await this.pool.execute(
      'UPDATE redact_rules SET pattern = ?, action = ?, enabled = ?, updated_at = ? WHERE id = ?',
      [pattern, action, enabled ? 1 : 0, now, id],
    );
    return this.getById(id);
  }

  async delete(id: string): Promise<boolean> {
    const { affectedRows } = await this.pool.execute('DELETE FROM redact_rules WHERE id = ?', [
      id,
    ]);
    return affectedRows > 0;
  }

  private async getById(id: string): Promise<RedactRuleRecord | undefined> {
    const rows = await this.pool.query('SELECT * FROM redact_rules WHERE id = ?', [id]);
    const row = (rows as Array<Record<string, unknown>>)[0];
    return row ? rowToRedactRule(row) : undefined;
  }
}

// ─── 辅助 ──────────────────────────────────────────────────────────

function rowToRedactRule(r: Record<string, unknown>): RedactRuleRecord {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    name: String(r.name),
    pattern: String(r.pattern),
    action: r.action as RedactRuleRecord['action'],
    enabled: Number(r.enabled) === 1 || r.enabled === true,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}
