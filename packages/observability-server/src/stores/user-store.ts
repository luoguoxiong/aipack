/**
 * UserStore 接口 + 双实现（SQLite / MySQL）。
 *
 * Phase 1：用户管理（注册/查询/密码校验）。
 * 密码哈希用 scrypt（node:crypto 内置，见 src/auth/password.ts）。
 * 主键用 ULID（时间有序，BTree 友好）。
 */

import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { MysqlPool } from './mysql';
import { ulid } from './ulid';
import { hashPassword, verifyPassword } from '../auth/password';

export interface UserRecord {
  id: string;
  email: string;
  name?: string;
  createdAt: number;
}

export interface UserWithCredentials extends UserRecord {
  passwordHash: string;
}

export interface CreateUserInput {
  email: string;
  password: string;
  name?: string;
}

export interface UserStore {
  createUser(input: CreateUserInput): Promise<UserRecord>;
  getUserById(id: string): Promise<UserRecord | undefined>;
  getUserByEmail(email: string): Promise<UserWithCredentials | undefined>;
  updateUser(id: string, patch: { name?: string }): Promise<UserRecord | undefined>;
  /** 验证 email + password，返回用户（不含 passwordHash）或 undefined */
  verifyCredentials(email: string, password: string): Promise<UserRecord | undefined>;
  close(): void;
}

// ─── SQLite 实现（零依赖默认） ────────────────────────────────────

const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
`;

export class SQLiteUserStore implements UserStore {
  constructor(private db: Database.Database) {
    this.db.exec(SQLITE_DDL);
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const id = ulid();
    const now = Date.now();
    const passwordHash = await hashPassword(input.password);
    this.db
      .prepare(
        'INSERT INTO users (id, email, password_hash, name, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, input.email.toLowerCase(), passwordHash, input.name ?? null, now);
    return { id, email: input.email.toLowerCase(), name: input.name, createdAt: now };
  }

  async getUserById(id: string): Promise<UserRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToUser(row) : undefined;
  }

  async getUserByEmail(email: string): Promise<UserWithCredentials | undefined> {
    const row = this.db
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(email.toLowerCase()) as Record<string, unknown> | undefined;
    return row ? rowToUserWithCreds(row) : undefined;
  }

  async updateUser(id: string, patch: { name?: string }): Promise<UserRecord | undefined> {
    if (patch.name !== undefined) {
      this.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(patch.name, id);
    }
    return this.getUserById(id);
  }

  async verifyCredentials(email: string, password: string): Promise<UserRecord | undefined> {
    const user = await this.getUserByEmail(email);
    if (!user) return undefined;
    const ok = await verifyPassword(password, user.passwordHash);
    return ok ? { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt } : undefined;
  }

  close(): void {
    // SQLiteStore 主类管理连接
  }
}

// ─── MySQL 实现（BUSINESS_STORE=mysql 时启用） ────────────────────

export class MySQLUserStore implements UserStore {
  constructor(private pool: MysqlPool) {}

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const id = ulid();
    const now = Date.now();
    const passwordHash = await hashPassword(input.password);
    await this.pool.execute(
      'INSERT INTO users (id, email, password_hash, name, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, input.email.toLowerCase(), passwordHash, input.name ?? null, now],
    );
    return { id, email: input.email.toLowerCase(), name: input.name, createdAt: now };
  }

  async getUserById(id: string): Promise<UserRecord | undefined> {
    const rows = await this.pool.query('SELECT * FROM users WHERE id = ?', [id]);
    const row = (rows as Array<Record<string, unknown>>)[0];
    return row ? rowToUser(row) : undefined;
  }

  async getUserByEmail(email: string): Promise<UserWithCredentials | undefined> {
    const rows = await this.pool.query('SELECT * FROM users WHERE email = ?', [
      email.toLowerCase(),
    ]);
    const row = (rows as Array<Record<string, unknown>>)[0];
    return row ? rowToUserWithCreds(row) : undefined;
  }

  async updateUser(id: string, patch: { name?: string }): Promise<UserRecord | undefined> {
    if (patch.name !== undefined) {
      await this.pool.execute('UPDATE users SET name = ? WHERE id = ?', [patch.name, id]);
    }
    return this.getUserById(id);
  }

  async verifyCredentials(email: string, password: string): Promise<UserRecord | undefined> {
    const user = await this.getUserByEmail(email);
    if (!user) return undefined;
    const ok = await verifyPassword(password, user.passwordHash);
    return ok ? { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt } : undefined;
  }

  async close(): Promise<void> {}
}

// ─── 辅助 ──────────────────────────────────────────────────────────

function rowToUser(r: Record<string, unknown>): UserRecord {
  return {
    id: String(r.id),
    email: String(r.email),
    name: r.name === null || r.name === undefined ? undefined : String(r.name),
    createdAt: Number(r.created_at),
  };
}

function rowToUserWithCreds(r: Record<string, unknown>): UserWithCredentials {
  return {
    ...rowToUser(r),
    passwordHash: String(r.password_hash),
  };
}
