/**
 * AclStore 接口 + MySQL 实现。
 *
 * Phase 4：项目成员授权（user × project × role）。
 * 角色：
 * - owner：项目所有者（创建项目时自动授权，可管理成员、删除项目）
 * - editor：可编辑 Agent 定义、关联 app，但不能管理成员
 * - viewer：只读，只能查看面板
 */

import type { MysqlPool } from './mysql';

export type ProjectRole = 'owner' | 'editor' | 'viewer';

export interface AclRecord {
  userId: string;
  projectId: string;
  role: ProjectRole;
  grantedAt: number;
  grantedBy?: string;
}

export interface GrantAclInput {
  userId: string;
  projectId: string;
  role: ProjectRole;
  grantedBy: string;
}

export interface AclStore {
  /** 授权（已存在则更新 role） */
  grant(input: GrantAclInput): Promise<AclRecord>;
  /** 撤销授权 */
  revoke(userId: string, projectId: string): Promise<boolean>;
  /** 查询某用户在某项目的角色 */
  getRole(userId: string, projectId: string): Promise<ProjectRole | undefined>;
  /** 列出项目所有成员 */
  listMembers(projectId: string): Promise<AclRecord[]>;
  /** 列出某用户加入的所有项目（返回 projectId + role） */
  listUserProjects(userId: string): Promise<AclRecord[]>;
  /** 检查用户是否有指定角色级别（owner > editor > viewer） */
  hasRole(userId: string, projectId: string, minRole: ProjectRole): Promise<boolean>;
  close(): void;
}

/** 角色级别（用于 hasRole 比较） */
const ROLE_LEVEL: Record<ProjectRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

// ─── MySQL 实现 ───────────────────────────────────────────────────

export class MySQLAclStore implements AclStore {
  constructor(private pool: MysqlPool) {}

  async grant(input: GrantAclInput): Promise<AclRecord> {
    const now = Date.now();
    await this.pool.execute(
      `INSERT INTO acl (user_id, project_id, role, granted_at, granted_by)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE role = VALUES(role), granted_at = VALUES(granted_at), granted_by = VALUES(granted_by)`,
      [input.userId, input.projectId, input.role, now, input.grantedBy],
    );
    return { ...input, grantedAt: now };
  }

  async revoke(userId: string, projectId: string): Promise<boolean> {
    const { affectedRows } = await this.pool.execute(
      'DELETE FROM acl WHERE user_id = ? AND project_id = ?',
      [userId, projectId],
    );
    return affectedRows > 0;
  }

  async getRole(userId: string, projectId: string): Promise<ProjectRole | undefined> {
    const rows = await this.pool.query(
      'SELECT role FROM acl WHERE user_id = ? AND project_id = ?',
      [userId, projectId],
    );
    const row = (rows as Array<{ role: string }>)[0];
    return row ? (row.role as ProjectRole) : undefined;
  }

  async listMembers(projectId: string): Promise<AclRecord[]> {
    const rows = await this.pool.query(
      'SELECT * FROM acl WHERE project_id = ? ORDER BY FIELD(role, "owner", "editor", "viewer"), granted_at ASC',
      [projectId],
    );
    return (rows as Array<Record<string, unknown>>).map(rowToAcl);
  }

  async listUserProjects(userId: string): Promise<AclRecord[]> {
    const rows = await this.pool.query(
      'SELECT * FROM acl WHERE user_id = ? ORDER BY granted_at DESC',
      [userId],
    );
    return (rows as Array<Record<string, unknown>>).map(rowToAcl);
  }

  async hasRole(userId: string, projectId: string, minRole: ProjectRole): Promise<boolean> {
    const role = await this.getRole(userId, projectId);
    if (!role) return false;
    return ROLE_LEVEL[role] >= ROLE_LEVEL[minRole];
  }

  async close(): Promise<void> {}
}

// ─── 辅助 ──────────────────────────────────────────────────────────

function rowToAcl(r: Record<string, unknown>): AclRecord {
  return {
    userId: String(r.user_id),
    projectId: String(r.project_id),
    role: r.role as ProjectRole,
    grantedAt: Number(r.granted_at),
    grantedBy: r.granted_by === null || r.granted_by === undefined ? undefined : String(r.granted_by),
  };
}
