/**
 * ProjectStore 接口 + 双实现（SQLite / MySQL）。
 *
 * Phase 1：项目管理（创建/查询/成员关联）。
 * 项目 ↔ app 多对多关系通过 project_apps 表维护。
 */

import type Database from 'better-sqlite3';
import type { MysqlPool } from './mysql';
import { ulid } from './ulid';

export interface ProjectRecord {
  id: string;
  name: string;
  ownerId: string;
  createdAt: number;
}

export interface CreateProjectInput {
  name: string;
  ownerId: string;
}

export interface ProjectStore {
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;
  getProject(id: string): Promise<ProjectRecord | undefined>;
  /** 列出某用户的所有项目（含 owner + 被 ACL 授权的） */
  listProjectsByUser(userId: string): Promise<ProjectRecord[]>;
  updateProject(id: string, patch: { name?: string }): Promise<ProjectRecord | undefined>;
  deleteProject(id: string): Promise<boolean>;
  /** 关联 app 到项目 */
  linkApp(projectId: string, appId: string): Promise<void>;
  /** 解除关联 */
  unlinkApp(projectId: string, appId: string): Promise<void>;
  /** 列出项目下的所有 app_id */
  listApps(projectId: string): Promise<string[]>;
  /** 查 app 所属项目（app 只属于一个项目时返回 project_id；多对多返回第一个） */
  getProjectByApp(appId: string): Promise<ProjectRecord | undefined>;
  close(): void;
}

// ─── SQLite 实现 ──────────────────────────────────────────────────

const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);

CREATE TABLE IF NOT EXISTS project_apps (
  project_id TEXT NOT NULL,
  app_id     TEXT NOT NULL,
  PRIMARY KEY (project_id, app_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_project_apps_app ON project_apps(app_id);
`;

export class SQLiteProjectStore implements ProjectStore {
  constructor(private db: Database.Database) {
    this.db.exec(SQLITE_DDL);
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    const id = ulid();
    const now = Date.now();
    this.db
      .prepare('INSERT INTO projects (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)')
      .run(id, input.name, input.ownerId, now);
    return { id, name: input.name, ownerId: input.ownerId, createdAt: now };
  }

  async getProject(id: string): Promise<ProjectRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToProject(row) : undefined;
  }

  async listProjectsByUser(userId: string): Promise<ProjectRecord[]> {
    // owner 的项目 + ACL 授权的项目
    const rows = this.db
      .prepare(
        `SELECT p.* FROM projects p
         WHERE p.owner_id = ?
         UNION
         SELECT p.* FROM projects p
         JOIN acl a ON a.project_id = p.id
         WHERE a.user_id = ?
         ORDER BY created_at DESC`,
      )
      .all(userId, userId) as Array<Record<string, unknown>>;
    return rows.map(rowToProject);
  }

  async updateProject(id: string, patch: { name?: string }): Promise<ProjectRecord | undefined> {
    if (patch.name !== undefined) {
      this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(patch.name, id);
    }
    return this.getProject(id);
  }

  async deleteProject(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return result.changes > 0;
  }

  async linkApp(projectId: string, appId: string): Promise<void> {
    this.db
      .prepare('INSERT OR IGNORE INTO project_apps (project_id, app_id) VALUES (?, ?)')
      .run(projectId, appId);
  }

  async unlinkApp(projectId: string, appId: string): Promise<void> {
    this.db
      .prepare('DELETE FROM project_apps WHERE project_id = ? AND app_id = ?')
      .run(projectId, appId);
  }

  async listApps(projectId: string): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT app_id FROM project_apps WHERE project_id = ?')
      .all(projectId) as Array<{ app_id: string }>;
    return rows.map((r) => r.app_id);
  }

  async getProjectByApp(appId: string): Promise<ProjectRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT p.* FROM projects p
         JOIN project_apps pa ON pa.project_id = p.id
         WHERE pa.app_id = ? LIMIT 1`,
      )
      .get(appId) as Record<string, unknown> | undefined;
    return row ? rowToProject(row) : undefined;
  }

  close(): void {}
}

// ─── MySQL 实现 ───────────────────────────────────────────────────

export class MySQLProjectStore implements ProjectStore {
  constructor(private pool: MysqlPool) {}

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    const id = ulid();
    const now = Date.now();
    await this.pool.execute(
      'INSERT INTO projects (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)',
      [id, input.name, input.ownerId, now],
    );
    return { id, name: input.name, ownerId: input.ownerId, createdAt: now };
  }

  async getProject(id: string): Promise<ProjectRecord | undefined> {
    const rows = await this.pool.query('SELECT * FROM projects WHERE id = ?', [id]);
    const row = (rows as Array<Record<string, unknown>>)[0];
    return row ? rowToProject(row) : undefined;
  }

  async listProjectsByUser(userId: string): Promise<ProjectRecord[]> {
    const rows = await this.pool.query(
      `SELECT p.* FROM projects p
       WHERE p.owner_id = ?
       UNION
       SELECT p.* FROM projects p
       JOIN acl a ON a.project_id = p.id
       WHERE a.user_id = ?
       ORDER BY created_at DESC`,
      [userId, userId],
    );
    return (rows as Array<Record<string, unknown>>).map(rowToProject);
  }

  async updateProject(id: string, patch: { name?: string }): Promise<ProjectRecord | undefined> {
    if (patch.name !== undefined) {
      await this.pool.execute('UPDATE projects SET name = ? WHERE id = ?', [patch.name, id]);
    }
    return this.getProject(id);
  }

  async deleteProject(id: string): Promise<boolean> {
    const { affectedRows } = await this.pool.execute('DELETE FROM projects WHERE id = ?', [id]);
    return affectedRows > 0;
  }

  async linkApp(projectId: string, appId: string): Promise<void> {
    await this.pool.execute(
      'INSERT IGNORE INTO project_apps (project_id, app_id) VALUES (?, ?)',
      [projectId, appId],
    );
  }

  async unlinkApp(projectId: string, appId: string): Promise<void> {
    await this.pool.execute(
      'DELETE FROM project_apps WHERE project_id = ? AND app_id = ?',
      [projectId, appId],
    );
  }

  async listApps(projectId: string): Promise<string[]> {
    const rows = await this.pool.query(
      'SELECT app_id FROM project_apps WHERE project_id = ?',
      [projectId],
    );
    return (rows as Array<{ app_id: string }>).map((r) => r.app_id);
  }

  async getProjectByApp(appId: string): Promise<ProjectRecord | undefined> {
    const rows = await this.pool.query(
      `SELECT p.* FROM projects p
       JOIN project_apps pa ON pa.project_id = p.id
       WHERE pa.app_id = ? LIMIT 1`,
      [appId],
    );
    const row = (rows as Array<Record<string, unknown>>)[0];
    return row ? rowToProject(row) : undefined;
  }

  async close(): Promise<void> {}
}

// ─── 辅助 ──────────────────────────────────────────────────────────

function rowToProject(r: Record<string, unknown>): ProjectRecord {
  return {
    id: String(r.id),
    name: String(r.name),
    ownerId: String(r.owner_id),
    createdAt: Number(r.created_at),
  };
}
