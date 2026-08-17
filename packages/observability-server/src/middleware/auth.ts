/**
 * Phase 4：HTTP 鉴权中间件。
 *
 * - authenticate(req)：解析 Bearer/Cookie → 返回 VerifiedUser；多用户模式下
 *   若 token 的 pid 与 query projectId 不一致，按 ACL 重新签发 access token
 *   （项目切换）；单用户模式直接放行（兼容 ADMIN_USER/ADMIN_PASS）。
 * - requireRole(minRole)：守卫，对多用户模式校验 ACL，单用户模式直接放行（owner 等价）。
 *
 * 设计：本文件不挂载独立路由，而是被各 api/* handler 直接调用。
 * 各 handler 拿到 req.user 后自己做角色判断；或调用 requireRole 工厂返回守卫。
 */
import http from 'node:http';
import type { SessionManager } from '../auth';
import type { JwtSessionManager, VerifiedUser } from '../auth/jwt';
import { readAccessToken } from '../auth/jwt';
import type { AclStore, ProjectRole } from '../stores/acl-store';
import type { UserStore } from '../stores/user-store';

/** 单/多用户模式统一的鉴权上下文 */
export interface AuthContext {
  /** 单用户模式（兼容旧部署） */
  single?: {
    sessions: SessionManager;
  };
  /** 多用户模式（默认） */
  multi?: {
    sessions: JwtSessionManager;
    userStore: UserStore;
    aclStore: AclStore;
  };
}

/** 鉴权结果（成功） */
export interface AuthResult {
  ok: true;
  user: VerifiedUser;
  /** 多用户模式下，若发生项目切换，新签发的 access token（前端需更新） */
  rotatedAccessToken?: string;
}

/** 鉴权结果（失败） */
export interface AuthFailure {
  ok: false;
  status: number;
  error: string;
}

/**
 * 解析 token，返回 user 上下文。
 *
 * @param requireAuth 强制需要登录（未带 token 返回 401）；false 时未带 token 返回 null（公开端点可选）
 * @param projectId 当前请求期望的项目上下文（query.pid 或 path 中的 :pid）
 *   多用户模式下：若 user 在该项目有 ACL，按当前角色签发新 access token；
 *   若不在，返回 403（项目无权限）。
 */
export async function authenticate(
  req: http.IncomingMessage,
  ctx: AuthContext,
  requireAuth: boolean,
  projectId?: string,
): Promise<AuthResult | AuthFailure | null> {
  const token = readAccessToken(req);
  if (!token) {
    if (requireAuth) return { ok: false, status: 401, error: 'unauthorized: missing or invalid token' };
    return null;
  }

  // 多用户模式优先
  if (ctx.multi) {
    const verified = ctx.multi.sessions.verify(token);
    if (!verified) {
      return { ok: false, status: 401, error: 'unauthorized: invalid or expired token' };
    }
    if (!verified.isMulti) {
      // 兼容旧单用户 token 落到多用户模式（不应发生）：当作已登录无项目
      return { ok: true, user: verified };
    }
    // 项目上下文：若 token 的 pid 与当前请求期望 pid 不一致，重签 access token
    if (projectId && verified.projectId !== projectId) {
      const role = await ctx.multi.aclStore.getRole(verified.userId, projectId);
      if (!role) {
        return { ok: false, status: 403, error: 'forbidden: 无该项目权限' };
      }
      const user = await ctx.multi.userStore.getUserById(verified.userId);
      const newToken = ctx.multi.sessions.signAccess(
        verified.userId,
        user?.email,
        role,
        projectId,
      );
      return {
        ok: true,
        user: { userId: verified.userId, email: user?.email, role, projectId, isMulti: true },
        rotatedAccessToken: newToken,
      };
    }
    return { ok: true, user: verified };
  }

  // 单用户模式
  if (ctx.single) {
    const username = ctx.single.sessions.verify(token);
    if (!username) {
      return { ok: false, status: 401, error: 'unauthorized: invalid or expired token' };
    }
    // 单用户视为 owner，无项目限制（向后兼容：所有 app 全可见）
    return { ok: true, user: { userId: username, isMulti: false, role: 'owner' } };
  }

  return { ok: false, status: 503, error: 'auth 未启用' };
}

/**
 * 角色守卫工厂：返回 (req, projectId) => AuthResult | AuthFailure。
 * - 多用户模式：查 ACL，要求 role 级别 >= minRole
 * - 单用户模式：直接放行（视为 owner）
 *
 * 角色级别：owner > editor > viewer
 */
const ROLE_LEVEL: Record<ProjectRole, number> = { viewer: 1, editor: 2, owner: 3 };

export function requireRole(minRole: ProjectRole): (req: http.IncomingMessage, ctx: AuthContext, projectId?: string) => Promise<AuthResult | AuthFailure> {
  return async (req, ctx, projectId) => {
    const auth = await authenticate(req, ctx, true, projectId);
    if (!auth || !auth.ok) return auth ?? { ok: false, status: 401, error: 'unauthorized' };

    // 单用户模式放行
    if (!auth.user.isMulti) return auth;

    // 多用户模式：若已通过 authenticate 拿到 role，校验级别
    if (auth.user.role && ROLE_LEVEL[auth.user.role] >= ROLE_LEVEL[minRole]) {
      return auth;
    }
    // 多用户模式且 pid 与 projectId 一致但 role 不足
    return {
      ok: false,
      status: 403,
      error: `forbidden: 需要 ${minRole} 及以上权限`,
    };
  };
}

/** 便捷：失败时写入 401/403 响应 */
export function writeAuthFailure(res: http.ServerResponse, fail: AuthFailure): void {
  res.writeHead(fail.status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: fail.error }));
}
