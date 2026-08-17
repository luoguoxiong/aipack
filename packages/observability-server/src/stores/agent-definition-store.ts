/**
 * AgentDefinitionStore 接口 + 双实现（SQLite / MySQL）。
 *
 * Phase 5：Agent 定义生命周期（draft → publish → archive / rollback）。
 * spec 是 JSON（systemPrompt / tools / model / params），版本号在 project+name 内自增。
 *
 * 版本语义：
 * - draft：草稿，可编辑
 * - published：已发布，Agent 应用可拉取
 * - archived：已归档（被新 published 版本替代或手动归档）
 *
 * 发布流程：clone 当前 draft → version+1 → publish 新版本 → 旧 published 变 archived
 */

import type Database from 'better-sqlite3';
import type { MysqlPool } from './mysql';
import { ulid } from './ulid';

export type AgentDefinitionStatus = 'draft' | 'published' | 'archived';

/** Agent spec（系统提示/工具/模型/参数） */
export interface AgentSpec {
  systemPrompt: string;
  model: {
    provider: string;
    id: string;
    temperature?: number;
    maxTokens?: number;
  };
  tools: string[];
  params?: {
    maxTurns?: number;
    approvalMode?: 'auto' | 'always' | 'never';
    [key: string]: unknown;
  };
}

export interface AgentDefinitionRecord {
  id: string;
  projectId: string;
  name: string;
  version: number;
  status: AgentDefinitionStatus;
  spec: AgentSpec;
  createdBy: string;
  createdAt: number;
  publishedAt?: number;
}

export interface CreateAgentDefinitionInput {
  projectId: string;
  name: string;
  spec: AgentSpec;
  createdBy: string;
}

export interface UpdateAgentDefinitionInput {
  name?: string;
  spec?: AgentSpec;
}

export interface AgentDefinitionStore {
  /** 创建新 Agent 定义（初始为 draft, version=0） */
  create(input: CreateAgentDefinitionInput): Promise<AgentDefinitionRecord>;
  /** 获取指定 ID */
  getById(id: string): Promise<AgentDefinitionRecord | undefined>;
  /** 获取项目下某 name 的最新 draft */
  getDraft(projectId: string, name: string): Promise<AgentDefinitionRecord | undefined>;
  /** 获取项目下某 name 的当前 published 版本 */
  getPublished(projectId: string, name: string): Promise<AgentDefinitionRecord | undefined>;
  /** 列出项目下所有 Agent 定义（按 name 分组，取最新版本） */
  list(projectId: string): Promise<AgentDefinitionRecord[]>;
  /** 列出某 name 的所有版本（按 version 降序） */
  listVersions(projectId: string, name: string): Promise<AgentDefinitionRecord[]>;
  /** 更新 draft 版本（仅 status=draft 可改） */
  updateDraft(id: string, patch: UpdateAgentDefinitionInput): Promise<AgentDefinitionRecord | undefined>;
  /** 发布新版本：clone 当前 draft → version+1 → publish → 旧 published 变 archived */
  publish(projectId: string, name: string, publishedBy: string): Promise<AgentDefinitionRecord>;
  /** 回滚：将指定历史版本设为 published，当前 published 变 archived */
  rollback(projectId: string, name: string, toVersion: number, rolledBackBy: string): Promise<AgentDefinitionRecord>;
  delete(id: string): Promise<boolean>;
  close(): void;
}

// ─── SQLite 实现 ──────────────────────────────────────────────────

const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS agent_definitions (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  version      INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',
  spec         TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE (project_id, name, version)
);
CREATE INDEX IF NOT EXISTS idx_ad_project_status ON agent_definitions(project_id, status);
CREATE INDEX IF NOT EXISTS idx_ad_project_name ON agent_definitions(project_id, name, version);
`;

export class SQLiteAgentDefinitionStore implements AgentDefinitionStore {
  constructor(private db: Database.Database) {
    this.db.exec(SQLITE_DDL);
  }

  async create(input: CreateAgentDefinitionInput): Promise<AgentDefinitionRecord> {
    const id = ulid();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO agent_definitions (id, project_id, name, version, status, spec, created_by, created_at)
         VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
      )
      .run(id, input.projectId, input.name, 0, JSON.stringify(input.spec), input.createdBy, now);
    return {
      id,
      projectId: input.projectId,
      name: input.name,
      version: 0,
      status: 'draft',
      spec: input.spec,
      createdBy: input.createdBy,
      createdAt: now,
    };
  }

  async getById(id: string): Promise<AgentDefinitionRecord | undefined> {
    const row = this.db
      .prepare('SELECT * FROM agent_definitions WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToAgentDef(row) : undefined;
  }

  async getDraft(projectId: string, name: string): Promise<AgentDefinitionRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM agent_definitions
         WHERE project_id = ? AND name = ? AND status = 'draft'
         ORDER BY version DESC LIMIT 1`,
      )
      .get(projectId, name) as Record<string, unknown> | undefined;
    return row ? rowToAgentDef(row) : undefined;
  }

  async getPublished(projectId: string, name: string): Promise<AgentDefinitionRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM agent_definitions
         WHERE project_id = ? AND name = ? AND status = 'published'
         ORDER BY version DESC LIMIT 1`,
      )
      .get(projectId, name) as Record<string, unknown> | undefined;
    return row ? rowToAgentDef(row) : undefined;
  }

  async list(projectId: string): Promise<AgentDefinitionRecord[]> {
    // 每个 name 取最新版本
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_definitions ad
         WHERE id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY name ORDER BY version DESC) AS rn
             FROM agent_definitions WHERE project_id = ?
           ) WHERE rn = 1
         )
         ORDER BY name ASC`,
      )
      .all(projectId) as Array<Record<string, unknown>>;
    return rows.map(rowToAgentDef);
  }

  async listVersions(projectId: string, name: string): Promise<AgentDefinitionRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_definitions
         WHERE project_id = ? AND name = ?
         ORDER BY version DESC`,
      )
      .all(projectId, name) as Array<Record<string, unknown>>;
    return rows.map(rowToAgentDef);
  }

  async updateDraft(id: string, patch: UpdateAgentDefinitionInput): Promise<AgentDefinitionRecord | undefined> {
    const existing = await this.getById(id);
    if (!existing || existing.status !== 'draft') return undefined;
    if (patch.name !== undefined) existing.name = patch.name;
    if (patch.spec !== undefined) existing.spec = patch.spec;
    this.db
      .prepare('UPDATE agent_definitions SET name = ?, spec = ? WHERE id = ?')
      .run(existing.name, JSON.stringify(existing.spec), id);
    return this.getById(id);
  }

  async publish(projectId: string, name: string, publishedBy: string): Promise<AgentDefinitionRecord> {
    const draft = await this.getDraft(projectId, name);
    if (!draft) throw new Error(`未找到 Agent 定义 "${name}" 的 draft 版本`);

    const tx = this.db.transaction(() => {
      // 旧 published 变 archived
      this.db
        .prepare(
          `UPDATE agent_definitions SET status = 'archived'
           WHERE project_id = ? AND name = ? AND status = 'published'`,
        )
        .run(projectId, name);

      // 当前 draft 变 published，version+1
      const newVersion = draft.version + 1;
      this.db
        .prepare(
          `UPDATE agent_definitions SET status = 'published', version = ?, published_at = ?
           WHERE id = ?`,
        )
        .run(newVersion, Date.now(), draft.id);

      // 创建新的 draft（clone published 版本）
      const newDraftId = ulid();
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO agent_definitions (id, project_id, name, version, status, spec, created_by, created_at)
           VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
        )
        .run(newDraftId, projectId, name, newVersion, JSON.stringify(draft.spec), publishedBy, now);
    });
    tx();

    const published = await this.getPublished(projectId, name);
    if (!published) throw new Error('发布后未找到 published 版本（内部错误）');
    return published;
  }

  async rollback(projectId: string, name: string, toVersion: number, rolledBackBy: string): Promise<AgentDefinitionRecord> {
    const target = await this.getPublished(projectId, name);
    if (!target) throw new Error(`未找到 Agent 定义 "${name}"`);

    const tx = this.db.transaction(() => {
      // 当前 published 变 archived
      this.db
        .prepare(
          `UPDATE agent_definitions SET status = 'archived'
           WHERE project_id = ? AND name = ? AND status = 'published'`,
        )
        .run(projectId, name);

      // 目标版本变 published
      this.db
        .prepare(
          `UPDATE agent_definitions SET status = 'published', published_at = ?
           WHERE project_id = ? AND name = ? AND version = ?`,
        )
        .run(Date.now(), projectId, name, toVersion);
    });
    tx();

    const result = await this.getPublished(projectId, name);
    if (!result) throw new Error(`回滚后未找到 published 版本（内部错误）`);
    return result;
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM agent_definitions WHERE id = ?').run(id);
    return result.changes > 0;
  }

  close(): void {}
}

// ─── MySQL 实现 ───────────────────────────────────────────────────

export class MySQLAgentDefinitionStore implements AgentDefinitionStore {
  constructor(private pool: MysqlPool) {}

  async create(input: CreateAgentDefinitionInput): Promise<AgentDefinitionRecord> {
    const id = ulid();
    const now = Date.now();
    await this.pool.execute(
      `INSERT INTO agent_definitions (id, project_id, name, version, status, spec, created_by, created_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
      [id, input.projectId, input.name, 0, JSON.stringify(input.spec), input.createdBy, now],
    );
    return {
      id,
      projectId: input.projectId,
      name: input.name,
      version: 0,
      status: 'draft',
      spec: input.spec,
      createdBy: input.createdBy,
      createdAt: now,
    };
  }

  async getById(id: string): Promise<AgentDefinitionRecord | undefined> {
    const rows = await this.pool.query('SELECT * FROM agent_definitions WHERE id = ?', [id]);
    const row = (rows as Array<Record<string, unknown>>)[0];
    return row ? rowToAgentDef(row) : undefined;
  }

  async getDraft(projectId: string, name: string): Promise<AgentDefinitionRecord | undefined> {
    const rows = await this.pool.query(
      `SELECT * FROM agent_definitions
       WHERE project_id = ? AND name = ? AND status = 'draft'
       ORDER BY version DESC LIMIT 1`,
      [projectId, name],
    );
    const row = (rows as Array<Record<string, unknown>>)[0];
    return row ? rowToAgentDef(row) : undefined;
  }

  async getPublished(projectId: string, name: string): Promise<AgentDefinitionRecord | undefined> {
    const rows = await this.pool.query(
      `SELECT * FROM agent_definitions
       WHERE project_id = ? AND name = ? AND status = 'published'
       ORDER BY version DESC LIMIT 1`,
      [projectId, name],
    );
    const row = (rows as Array<Record<string, unknown>>)[0];
    return row ? rowToAgentDef(row) : undefined;
  }

  async list(projectId: string): Promise<AgentDefinitionRecord[]> {
    const rows = await this.pool.query(
      `SELECT ad.* FROM agent_definitions ad
       INNER JOIN (
         SELECT name, MAX(version) AS max_ver
         FROM agent_definitions WHERE project_id = ?
         GROUP BY name
       ) latest ON ad.name = latest.name AND ad.version = latest.max_ver
       WHERE ad.project_id = ?
       ORDER BY ad.name ASC`,
      [projectId, projectId],
    );
    return (rows as Array<Record<string, unknown>>).map(rowToAgentDef);
  }

  async listVersions(projectId: string, name: string): Promise<AgentDefinitionRecord[]> {
    const rows = await this.pool.query(
      `SELECT * FROM agent_definitions
       WHERE project_id = ? AND name = ?
       ORDER BY version DESC`,
      [projectId, name],
    );
    return (rows as Array<Record<string, unknown>>).map(rowToAgentDef);
  }

  async updateDraft(id: string, patch: UpdateAgentDefinitionInput): Promise<AgentDefinitionRecord | undefined> {
    const existing = await this.getById(id);
    if (!existing || existing.status !== 'draft') return undefined;
    if (patch.name !== undefined) existing.name = patch.name;
    if (patch.spec !== undefined) existing.spec = patch.spec;
    await this.pool.execute(
      'UPDATE agent_definitions SET name = ?, spec = ? WHERE id = ?',
      [existing.name, JSON.stringify(existing.spec), id],
    );
    return this.getById(id);
  }

  async publish(projectId: string, name: string, publishedBy: string): Promise<AgentDefinitionRecord> {
    const draft = await this.getDraft(projectId, name);
    if (!draft) throw new Error(`未找到 Agent 定义 "${name}" 的 draft 版本`);

    await this.pool.transaction(async (conn) => {
      await conn.execute(
        `UPDATE agent_definitions SET status = 'archived'
         WHERE project_id = ? AND name = ? AND status = 'published'`,
        [projectId, name],
      );
      const newVersion = draft.version + 1;
      await conn.execute(
        `UPDATE agent_definitions SET status = 'published', version = ?, published_at = ?
         WHERE id = ?`,
        [newVersion, Date.now(), draft.id],
      );
      const newDraftId = ulid();
      const now = Date.now();
      await conn.execute(
        `INSERT INTO agent_definitions (id, project_id, name, version, status, spec, created_by, created_at)
         VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
        [newDraftId, projectId, name, newVersion, JSON.stringify(draft.spec), publishedBy, now],
      );
    });

    const published = await this.getPublished(projectId, name);
    if (!published) throw new Error('发布后未找到 published 版本（内部错误）');
    return published;
  }

  async rollback(projectId: string, name: string, toVersion: number, rolledBackBy: string): Promise<AgentDefinitionRecord> {
    await this.pool.transaction(async (conn) => {
      await conn.execute(
        `UPDATE agent_definitions SET status = 'archived'
         WHERE project_id = ? AND name = ? AND status = 'published'`,
        [projectId, name],
      );
      await conn.execute(
        `UPDATE agent_definitions SET status = 'published', published_at = ?
         WHERE project_id = ? AND name = ? AND version = ?`,
        [Date.now(), projectId, name, toVersion],
      );
    });
    const result = await this.getPublished(projectId, name);
    if (!result) throw new Error(`回滚后未找到 published 版本（内部错误）`);
    return result;
  }

  async delete(id: string): Promise<boolean> {
    const { affectedRows } = await this.pool.execute('DELETE FROM agent_definitions WHERE id = ?', [id]);
    return affectedRows > 0;
  }

  async close(): Promise<void> {}
}

// ─── 辅助 ──────────────────────────────────────────────────────────

function rowToAgentDef(r: Record<string, unknown>): AgentDefinitionRecord {
  const specStr = String(r.spec);
  let spec: AgentSpec;
  try {
    spec = JSON.parse(specStr) as AgentSpec;
  } catch {
    spec = { systemPrompt: '', model: { provider: '', id: '' }, tools: [] };
  }
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    name: String(r.name),
    version: Number(r.version),
    status: r.status as AgentDefinitionStatus,
    spec,
    createdBy: String(r.created_by),
    createdAt: Number(r.created_at),
    publishedAt: r.published_at === null || r.published_at === undefined ? undefined : Number(r.published_at),
  };
}
