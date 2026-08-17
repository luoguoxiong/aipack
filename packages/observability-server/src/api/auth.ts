/**
 * Phase 4：多用户会话 API。
 *
 *   POST   /api/auth/login         { email, password, projectId? }
 *           → { user, accessToken, refreshToken }（多用户模式，HTTP-only cookie 同时下发）
 *   POST   /api/auth/refresh        { refreshToken? }  (或 cookie) → 轮换新 token
 *   POST   /api/auth/logout        → 清除 cookie
 *   GET    /api/auth/me            → { id, email, name, createdAt }（多用户）
 *
 * 与 src/admin.ts 的单用户 login/logout/me 共存：
 * - 多用户模式（AUTH_MODE=multi）：本 handler 接管 /api/auth/* 全部路由
 * - 单用户模式（AUTH_MODE=single 或未注入 userStore）：仍走 admin.ts 的 SessionManager
 *
 * collector.ts 根据模式选择挂载本 handler 还是 admin.ts 的 /api/auth/login。
 */
import http from 'node:http';
import type { JwtSessionManager } from '../auth/jwt';
import { readCookie, readRefreshToken } from '../auth/jwt';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../auth/jwt';
import type { UserStore } from '../stores/user-store';
import type { AclStore } from '../stores/acl-store';
import { authenticate, type AuthContext, writeAuthFailure } from '../middleware/auth';
import { json, readJson, setCookies } from './helpers';

export interface AuthApiDeps {
  userStore: UserStore;
  aclStore: AclStore;
  jwt: JwtSessionManager;
}

export type AuthHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

export function createAuthHandler(deps: AuthApiDeps): AuthHandler {
  const authCtx: AuthContext = {
    multi: { sessions: deps.jwt, userStore: deps.userStore, aclStore: deps.aclStore },
  };

  return async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const path = url.pathname;
      const method = req.method || 'GET';

      if (method === 'POST' && path === '/api/auth/login') {
        return handleLogin(req, res, deps, url.searchParams.get('projectId') || undefined);
      }
      if (method === 'POST' && path === '/api/auth/refresh') {
        return handleRefresh(req, res, deps, url.searchParams.get('projectId') || undefined);
      }
      if (method === 'POST' && path === '/api/auth/logout') {
        setCookies(res, deps.jwt.clearCookies());
        return json(res, 200, { ok: true });
      }
      if (method === 'GET' && path === '/api/auth/me') {
        const auth = await authenticate(req, authCtx, true);
        if (!auth || !auth.ok) return auth ? writeAuthFailure(res, auth) : json(res, 401, { error: 'unauthorized' });
        if (!auth.user.isMulti) {
          // 兼容单用户模式（admin.ts 已处理；此分支理论上不会进入）
          return json(res, 200, { id: auth.user.userId, email: auth.user.userId });
        }
        const user = await deps.userStore.getUserById(auth.user.userId);
        if (!user) return json(res, 404, { error: 'user not found' });
        return json(res, 200, {
          id: user.id,
          email: user.email,
          name: user.name,
          createdAt: user.createdAt,
          role: auth.user.role,
          projectId: auth.user.projectId,
        }, auth.rotatedAccessToken ? { 'X-Rotated-Token': auth.rotatedAccessToken } : {});
      }

      return json(res, 404, { error: 'Not Found' });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : 'Internal Error' });
    }
  };
}

async function handleLogin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AuthApiDeps,
  projectId?: string,
): Promise<void> {
  const body = (await readJson(req).catch(() => null)) as
    | { email?: string; password?: string; projectId?: string }
    | null;
  if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') {
    return json(res, 400, { error: 'email 和 password 为必填' });
  }
  const pid = body.projectId || projectId;
  const result = await deps.jwt.login(body.email, body.password, pid);
  if (!result) return json(res, 401, { error: 'invalid email or password' });

  setCookies(res, [deps.jwt.buildAccessCookie(result.accessToken), deps.jwt.buildRefreshCookie(result.refreshToken)]);
  return json(res, 200, {
    user: { id: result.user.id, email: result.user.email, name: result.user.name },
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
  });
}

async function handleRefresh(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AuthApiDeps,
  projectId?: string,
): Promise<void> {
  // 优先 body，回退 cookie
  let body: { refreshToken?: string; projectId?: string } | null = null;
  try {
    body = (await readJson(req)) as { refreshToken?: string; projectId?: string } | null;
  } catch {
    body = null;
  }
  const refreshToken = readRefreshToken(req, body ?? undefined);
  if (!refreshToken) return json(res, 400, { error: 'refresh token 为必填（body 或 cookie）' });
  const pid = body?.projectId || projectId;
  const result = await deps.jwt.refresh(refreshToken, pid);
  if (!result) return json(res, 401, { error: 'invalid or expired refresh token' });

  setCookies(res, [deps.jwt.buildAccessCookie(result.accessToken), deps.jwt.buildRefreshCookie(result.refreshToken)]);
  return json(res, 200, {
    user: { id: result.user.id, email: result.user.email, name: result.user.name },
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
  });
}
