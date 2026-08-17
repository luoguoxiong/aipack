/**
 * Phase 4：多用户 JWT 风格会话管理。
 *
 * - access token：15min，payload 含 { sub: userId, email, role, pid: projectId, type: 'access', exp }
 * - refresh token：7d，payload 仅含 { sub: userId, type: 'refresh', exp }
 * - 签名算法：HMAC-SHA256（与 src/auth.ts 的 SessionManager 单用户模式同签名格式）
 * - HTTP-only cookie：由调用方（admin.ts / api/auth.ts）写入 Set-Cookie
 *
 * 与 src/auth.ts 的 SessionManager 关系：
 * - 单用户模式（AUTH_MODE=single 或未注入 userStore）：仍走 SessionManager（HMAC/内存）
 * - 多用户模式（AUTH_MODE=multi，默认）：走 JwtSessionManager
 *
 * 兼容性：
 * - verifyAny() 同时接受 access token 与旧式单用户 token（sub 字段）
 *   - 旧 token（无 type 字段）：当作单用户模式，返回 { sub, isMulti: false }
 *   - access token：返回 { sub, email, role, pid, isMulti: true }
 * - refresh token 仅 refresh 端点接受
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { UserStore } from '../stores/user-store';
import type { AclStore, ProjectRole } from '../stores/acl-store';

/** access token 默认 15min */
export const DEFAULT_ACCESS_TTL_MS = 15 * 60 * 1000;
/** refresh token 默认 7d */
export const DEFAULT_REFRESH_TTL_MS = 7 * 24 * 3600 * 1000;

/** Cookie 名 */
export const ACCESS_COOKIE = 'obs_access';
export const REFRESH_COOKIE = 'obs_refresh';

/** access token payload */
export interface AccessPayload {
  /** user id */
  sub: string;
  /** 邮箱（用于显示） */
  email?: string;
  /** 当前激活角色（owner/editor/viewer）；切换项目时由 middleware 重新查 ACL */
  role?: ProjectRole;
  /** 当前激活项目（可切换） */
  pid?: string;
  type: 'access';
  exp: number;
  /** 签发时间（ms） */
  iat: number;
}

/** refresh token payload */
export interface RefreshPayload {
  sub: string;
  type: 'refresh';
  exp: number;
  iat: number;
  /** 随机 token id，用于服务端撤销（可选；当前实现不维护黑名单，仅作识别） */
  jti: string;
}

/** verify 返回的统一结果（兼容旧单用户 token） */
export interface VerifiedUser {
  userId: string;
  email?: string;
  role?: ProjectRole;
  projectId?: string;
  /** 是否多用户模式（旧单用户 token 为 false） */
  isMulti: boolean;
}

/** Cookie 属性 */
export interface CookieOpts {
  httpOnly: true;
  secure?: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: string;
  maxAge: number;
}

const TOKEN_HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

/** HMAC-SHA256 签名 */
function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/** 签发 token：base64url(header).base64url(payload).base64url(hmac) */
function signToken(payload: Record<string, unknown>, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = sign(`${TOKEN_HEADER}.${body}`, secret);
  return `${TOKEN_HEADER}.${body}.${sig}`;
}

/** 验签 + 解析 payload；非法返回 null */
function verifyToken<T = Record<string, unknown>>(token: string, secret: string): T | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = sign(`${header}.${payload}`, secret);
  if (!safeEqualStr(expected, signature)) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

function safeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export interface JwtSessionOptions {
  accessTtlMs?: number;
  refreshTtlMs?: number;
  /** cookie secure flag（HTTPS 部署启用） */
  secure?: boolean;
  /** cookie sameSite */
  sameSite?: 'lax' | 'strict' | 'none';
  /** cookie path（默认 /） */
  cookiePath?: string;
}

/**
 * 多用户 JWT 会话管理器。
 *
 * 依赖注入 UserStore（验证邮箱密码）+ AclStore（查角色）。
 * 切换项目时由 middleware 重新查 ACL 后签发新 access token。
 */
export class JwtSessionManager {
  readonly accessTtlMs: number;
  readonly refreshTtlMs: number;
  private readonly secure: boolean;
  private readonly sameSite: 'lax' | 'strict' | 'none';
  private readonly cookiePath: string;

  constructor(
    private userStore: UserStore,
    private aclStore: AclStore,
    private secret: string,
    opts: JwtSessionOptions = {},
  ) {
    this.accessTtlMs = opts.accessTtlMs ?? DEFAULT_ACCESS_TTL_MS;
    this.refreshTtlMs = opts.refreshTtlMs ?? DEFAULT_REFRESH_TTL_MS;
    this.secure = opts.secure ?? false;
    this.sameSite = opts.sameSite ?? 'lax';
    this.cookiePath = opts.cookiePath ?? '/';
  }

  /**
   * 登录：email + password 校验成功后签发 access + refresh token。
   * 返回 null 表示凭证错误。
   *
   * @param projectId 可选：初始激活项目（不传时 role/pid 留空，由前端选择）
   */
  async login(
    email: string,
    password: string,
    projectId?: string,
  ): Promise<{ accessToken: string; refreshToken: string; user: { id: string; email: string; name?: string } } | null> {
    const user = await this.userStore.verifyCredentials(email, password);
    if (!user) return null;

    let role: ProjectRole | undefined;
    if (projectId) {
      role = await this.aclStore.getRole(user.id, projectId);
    }
    const access = this.signAccess(user.id, user.email, role, projectId);
    const refresh = this.signRefresh(user.id);
    return {
      accessToken: access,
      refreshToken: refresh,
      user: { id: user.id, email: user.email, name: user.name },
    };
  }

  /** 用 refresh token 换取新的 access + refresh（refresh 轮换） */
  async refresh(refreshToken: string, projectId?: string): Promise<{
    accessToken: string;
    refreshToken: string;
    user: { id: string; email: string; name?: string };
  } | null> {
    const payload = verifyToken<RefreshPayload>(refreshToken, this.secret);
    if (!payload || payload.type !== 'refresh' || typeof payload.sub !== 'string') return null;
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;

    const user = await this.userStore.getUserById(payload.sub);
    if (!user) return null;
    let role: ProjectRole | undefined;
    if (projectId) role = await this.aclStore.getRole(user.id, projectId);
    return {
      accessToken: this.signAccess(user.id, user.email, role, projectId),
      refreshToken: this.signRefresh(user.id),
      user: { id: user.id, email: user.email, name: user.name },
    };
  }

  /** 签发 access token（含角色/项目上下文） */
  signAccess(userId: string, email?: string, role?: ProjectRole, projectId?: string): string {
    const now = Date.now();
    return signToken(
      {
        sub: userId,
        email,
        role,
        pid: projectId,
        type: 'access',
        iat: now,
        exp: now + this.accessTtlMs,
      },
      this.secret,
    );
  }

  /** 签发 refresh token */
  signRefresh(userId: string): string {
    const now = Date.now();
    return signToken(
      {
        sub: userId,
        type: 'refresh',
        iat: now,
        exp: now + this.refreshTtlMs,
        jti: randomBytes(12).toString('hex'),
      },
      this.secret,
    );
  }

  /** 校验 access token（也接受旧单用户 token：无 type 字段视为单用户） */
  verify(token: string): VerifiedUser | null {
    const payload = verifyToken<Record<string, unknown>>(token, this.secret);
    if (!payload) return null;
    if (typeof payload.sub !== 'string') return null;
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
    if (Date.now() > payload.exp) return null;
    if (payload.type === 'access') {
      return {
        userId: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : undefined,
        role: typeof payload.role === 'string' ? (payload.role as ProjectRole) : undefined,
        projectId: typeof payload.pid === 'string' ? payload.pid : undefined,
        isMulti: true,
      };
    }
    // 旧式单用户 token（无 type 字段或 type 非 'access'/'refresh'）→ 兼容为单用户
    if (payload.type === undefined || payload.type === null) {
      return { userId: payload.sub, isMulti: false };
    }
    return null;
  }

  /** 仅校验 refresh token（refresh 端点专用） */
  verifyRefresh(token: string): { userId: string } | null {
    const payload = verifyToken<RefreshPayload>(token, this.secret);
    if (!payload || payload.type !== 'refresh' || typeof payload.sub !== 'string') return null;
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
    return { userId: payload.sub };
  }

  /** 生成 Set-Cookie 字符串 */
  buildAccessCookie(token: string): string {
    return serializeCookie(ACCESS_COOKIE, token, {
      httpOnly: true,
      secure: this.secure,
      sameSite: this.sameSite,
      path: this.cookiePath,
      maxAge: Math.floor(this.accessTtlMs / 1000),
    });
  }

  buildRefreshCookie(token: string): string {
    return serializeCookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: this.secure,
      sameSite: this.sameSite,
      path: this.cookiePath,
      maxAge: Math.floor(this.refreshTtlMs / 1000),
    });
  }

  /** 清除 cookie（logout） */
  clearCookies(): string[] {
    const expired = 'obs=; Max-Age=0; Path=' + this.cookiePath;
    return [
      `${ACCESS_COOKIE}=; Max-Age=0; Path=${this.cookiePath}${this.secure ? '; Secure' : ''}; HttpOnly; SameSite=${this.sameSite}`,
      `${REFRESH_COOKIE}=; Max-Age=0; Path=${this.cookiePath}${this.secure ? '; Secure' : ''}; HttpOnly; SameSite=${this.sameSite}`,
    ];
  }
}

/** 从 Cookie header解析指定名 */
export function readCookie(req: http.IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw || typeof raw !== 'string') return undefined;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return part.slice(idx + 1).trim();
  }
  return undefined;
}

/** 从 Authorization: Bearer xxx 解析 token */
export function readBearer(req: http.IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return undefined;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : undefined;
}

/** access token 来源：优先 Authorization Bearer，回退 cookie */
export function readAccessToken(req: http.IncomingMessage): string | undefined {
  return readBearer(req) ?? readCookie(req, ACCESS_COOKIE);
}

/** refresh token 来源：优先 body，回退 cookie */
export function readRefreshToken(req: http.IncomingMessage, body?: { refreshToken?: string }): string | undefined {
  if (body && typeof body.refreshToken === 'string' && body.refreshToken) return body.refreshToken;
  return readCookie(req, REFRESH_COOKIE);
}

// ─── Cookie 序列化（不引外部 dep） ──────────────────────────────────

function serializeCookie(name: string, value: string, opts: {
  httpOnly: true;
  secure?: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: string;
  maxAge: number;
}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path}`);
  parts.push(`Max-Age=${opts.maxAge}`);
  parts.push(`SameSite=${opts.sameSite}`);
  if (opts.secure) parts.push('Secure');
  if (opts.httpOnly) parts.push('HttpOnly');
  return parts.join('; ');
}
