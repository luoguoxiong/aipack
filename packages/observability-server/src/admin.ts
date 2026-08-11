/**
 * 面板管理路由（observability-web 对接）：
 *
 *   POST /api/auth/login     { username, password } → { token, username }
 *   POST /api/auth/logout    (Bearer) → { ok }
 *   GET  /api/auth/me        (Bearer) → { username }
 *
 *   GET  /api/apps           (Bearer) → AppRecord[]（含 secret，面板管理用）
 *   POST /api/apps           (Bearer) { name } → AppRecord（新创建，secret 一次性展示）
 *   GET  /api/apps/:appId/secret  (Bearer) → { appId, appSecret }
 *   POST /api/apps/:appId/regenerate-secret (Bearer) → { appId, appSecret }
 *   DELETE /api/apps/:appId  (Bearer) → { ok }
 *
 * 除 login 外全部需要 `Authorization: Bearer <token>`（SessionManager.verify）。
 */
import http from 'node:http';
import type { SessionManager } from './auth';
import type { SQLiteStore } from './store';

const MAX_BODY = 64 * 1024;

export interface AdminDeps {
  sessions: SessionManager;
  store: SQLiteStore;
}

export type AdminHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<void>;

export function createAdminHandler({ sessions, store }: AdminDeps): AdminHandler {
  return async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const path = url.pathname;
      const method = req.method || 'GET';

      // ── 登录（公开）──────────────────────────────────────────
      if (method === 'POST' && path === '/api/auth/login') {
        return handleLogin(req, res, sessions);
      }

      // ── 以下全部需要 Bearer 会话 ─────────────────────────────
      const username = resolveUser(req, sessions);
      if (!username) return json(res, 401, { error: 'unauthorized: missing or invalid token' });

      if (method === 'POST' && path === '/api/auth/logout') {
        sessions.logout(readBearer(req));
        return json(res, 200, { ok: true });
      }
      if (method === 'GET' && path === '/api/auth/me') {
        return json(res, 200, { username });
      }

      if (path === '/api/apps') {
        if (method === 'GET') return json(res, 200, store.listApps());
        if (method === 'POST') return handleCreateApp(req, res, store);
      }

      const appMatch = path.match(/^\/api\/apps\/([^/]+)(?:\/(secret|regenerate-secret))?$/);
      if (appMatch) {
        const appId = decodeURIComponent(appMatch[1]);
        const action = appMatch[2];
        if (action === 'secret' && method === 'GET') {
          const app = store.getApp(appId);
          if (!app) return json(res, 404, { error: 'app not found' });
          return json(res, 200, { appId: app.appId, appSecret: app.appSecret });
        }
        if (action === 'regenerate-secret' && method === 'POST') {
          const secret = store.regenerateSecret(appId);
          if (!secret) return json(res, 404, { error: 'app not found' });
          return json(res, 200, { appId, appSecret: secret });
        }
        if (method === 'DELETE') {
          const deleted = store.deleteApp(appId);
          return json(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: 'app not found' });
        }
      }

      return json(res, 404, { error: 'Not Found' });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : 'Internal Error' });
    }
  };
}

// ─── 端点实现 ─────────────────────────────────────────────────────

async function handleLogin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessions: SessionManager,
): Promise<void> {
  const body = (await readJson(req).catch(() => null)) as
    | { username?: string; password?: string }
    | null;
  if (!body || typeof body.username !== 'string' || typeof body.password !== 'string') {
    return json(res, 400, { error: 'username 和 password 为必填' });
  }
  const token = sessions.login(body.username, body.password);
  if (!token) return json(res, 401, { error: 'invalid username or password' });
  return json(res, 200, { token, username: body.username });
}

async function handleCreateApp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: SQLiteStore,
): Promise<void> {
  const body = (await readJson(req).catch(() => null)) as { name?: string } | null;
  const name = body?.name?.trim();
  if (!name) return json(res, 400, { error: 'name 为必填' });
  return json(res, 201, store.createApp(name));
}

// ─── 辅助 ─────────────────────────────────────────────────────────

function readBearer(req: http.IncomingMessage): string {
  const h = req.headers.authorization || '';
  return h.replace(/^Bearer\s+/i, '').trim();
}

function resolveUser(req: http.IncomingMessage, sessions: SessionManager): string | null {
  const token = readBearer(req);
  return token ? sessions.verify(token) : null;
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk;
      if (raw.length > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): Promise<void> {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  return new Promise((resolve) => {
    res.end(JSON.stringify(body), () => resolve());
  });
}
