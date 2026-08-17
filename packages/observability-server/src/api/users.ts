/**
 * Phase 4：用户管理 API。
 *
 *   POST   /api/users/register    { email, password, name? }
 *          → { user, accessToken, refreshToken }（自动签发会话）
 *   GET    /api/users/me           → { id, email, name, createdAt }
 *   PATCH  /api/users/me           { name? } → 更新当前用户资料
 *
 * 邮箱规范化为小写；密码长度 ≥8。注册即签发 token，免再调登录。
 *
 * 鉴权：register 公开；me/PATCH 需 access token。
 */
import http from 'node:http';
import type { JwtSessionManager } from '../auth/jwt';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../auth/jwt';
import type { UserStore } from '../stores/user-store';
import type { AclStore } from '../stores/acl-store';
import { authenticate, type AuthContext, writeAuthFailure } from '../middleware/auth';
import { json, readJson, setCookies } from './helpers';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 8;

export interface UsersApiDeps {
  userStore: UserStore;
  aclStore: AclStore;
  jwt: JwtSessionManager;
}

export type UsersHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

export function createUsersHandler(deps: UsersApiDeps): UsersHandler {
  const authCtx: AuthContext = {
    multi: { sessions: deps.jwt, userStore: deps.userStore, aclStore: deps.aclStore },
  };

  return async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const path = url.pathname;
      const method = req.method || 'GET';

      if (method === 'POST' && path === '/api/users/register') {
        return handleRegister(req, res, deps);
      }

      if (path === '/api/users/me') {
        const auth = await authenticate(req, authCtx, true);
        if (!auth || !auth.ok) return auth ? writeAuthFailure(res, auth) : json(res, 401, { error: 'unauthorized' });
        if (!auth.user.isMulti) return json(res, 400, { error: '此端点仅多用户模式可用' });
        const user = await deps.userStore.getUserById(auth.user.userId);
        if (!user) return json(res, 404, { error: 'user not found' });
        if (method === 'GET') {
          return json(res, 200, user);
        }
        if (method === 'PATCH') {
          return handleUpdateMe(req, res, deps, user.id);
        }
      }

      return json(res, 404, { error: 'Not Found' });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : 'Internal Error' });
    }
  };
}

async function handleRegister(req: http.IncomingMessage, res: http.ServerResponse, deps: UsersApiDeps): Promise<void> {
  const body = (await readJson(req).catch(() => null)) as
    | { email?: string; password?: string; name?: string }
    | null;
  if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') {
    return json(res, 400, { error: 'email 和 password 为必填' });
  }
  const email = body.email.trim().toLowerCase();
  const password = body.password;
  if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'email 格式不合法' });
  if (password.length < MIN_PASSWORD_LEN) {
    return json(res, 400, { error: `password 至少 ${MIN_PASSWORD_LEN} 位` });
  }

  const existing = await deps.userStore.getUserByEmail(email);
  if (existing) return json(res, 409, { error: '该邮箱已注册' });

  const user = await deps.userStore.createUser({ email, password, name: body.name?.trim() || undefined });
  // 注册即签发 token（无项目上下文，登录后再选项目）
  const result = await deps.jwt.login(email, password);
  if (!result) return json(res, 500, { error: '注册成功但签发 token 失败' });

  setCookies(res, [deps.jwt.buildAccessCookie(result.accessToken), deps.jwt.buildRefreshCookie(result.refreshToken)]);
  return json(res, 201, {
    user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt },
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
  });
}

async function handleUpdateMe(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: UsersApiDeps,
  userId: string,
): Promise<void> {
  const body = (await readJson(req).catch(() => null)) as { name?: string } | null;
  if (!body || typeof body !== 'object') return json(res, 400, { error: '请求体不能为空' });
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 100)) {
    return json(res, 400, { error: 'name 必须为 1-100 字符的字符串' });
  }
  const updated = await deps.userStore.updateUser(userId, { name: body.name });
  if (!updated) return json(res, 404, { error: 'user not found' });
  return json(res, 200, updated);
}
