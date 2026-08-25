/**
 * ProjectStore 接口 + MySQL 实现。
 *
 * Phase 1：项目管理（创建/查询/成员关联）。
 * 项目 ↔ app 多对多关系通过 project_apps 表维护。
 */

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
  /** S2 安全修复：列出 app 关联的所有项目 ID（app-项目多对多归属校验） */
  listProjectIdsByApp(appId: string): Promise<string[]>;
  /** 查 app 所属项目（app 只属于一个项目时返回 project_id；多对多返回第一个） */
  getProjectByApp(appId: string): Promise<ProjectRecord | undefined>;
  close(): void;
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

  async listProjectIdsByApp(appId: string): Promise<string[]> {
    const rows = await this.pool.query(
      'SELECT project_id FROM project_apps WHERE app_id = ? ORDER BY project_id',
      [appId],
    );
    return (rows as Array<{ project_id: string }>).map((r) => r.project_id);
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
