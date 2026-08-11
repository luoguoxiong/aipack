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
import { randomUUID } from 'node:crypto';
import type { SessionManager } from './auth';
import type { SQLiteStore, AlertRuleRow } from './store';
import { validateRule } from './alerts/rules';
import type { Notifier } from './alerts/notify';

const MAX_BODY = 64 * 1024;

export interface AdminDeps {
  sessions: SessionManager;
  store: SQLiteStore;
  /** 告警通知器（用于"测试通知"端点；alerts 未启用时为空） */
  notifier?: Notifier;
  /** 面板元信息：Trace 详情"查看日志"跳转模板（LOG_STREAM_URL_TEMPLATE） */
  logStreamUrlTemplate?: string;
}

export type AdminHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<void>;

export function createAdminHandler({ sessions, store, notifier, logStreamUrlTemplate }: AdminDeps): AdminHandler {
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
      if (method === 'GET' && path === '/api/meta') {
        return json(res, 200, { logStreamUrlTemplate });
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

      // ── 告警规则 / 事件 ─────────────────────────────────────
      if (path === '/api/alerts/rules') {
        if (method === 'GET') return json(res, 200, store.listAlertRules());
        if (method === 'POST') return handleCreateAlertRule(req, res, store);
      }
      if (path === '/api/alerts/events') {
        if (method === 'GET') return handleListAlertEvents(url, res, store);
      }
      const alertTestMatch = path.match(/^\/api\/alerts\/rules\/([^/]+)\/test$/);
      if (alertTestMatch && method === 'POST') {
        const rule = store.getAlertRule(decodeURIComponent(alertTestMatch[1]));
        if (!rule) return json(res, 404, { error: 'rule not found' });
        return handleTestAlertRule(res, notifier, rule);
      }
      const alertRuleMatch = path.match(/^\/api\/alerts\/rules\/([^/]+)$/);
      if (alertRuleMatch) {
        const id = decodeURIComponent(alertRuleMatch[1]);
        if (method === 'PUT') return handleUpdateAlertRule(req, res, store, id);
        if (method === 'DELETE') {
          const deleted = store.deleteAlertRule(id);
          return json(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: 'rule not found' });
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

// ─── 告警端点实现 ─────────────────────────────────────────────────

async function handleCreateAlertRule(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: SQLiteStore,
): Promise<void> {
  const body = (await readJson(req).catch(() => null)) as Record<string, unknown> | null;
  const result = validateRule(body as never);
  if (!result.ok) return json(res, 400, { error: result.error });
  const now = Date.now();
  const rule: AlertRuleRow = {
    ...result.rule,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
  store.createAlertRule(rule);
  return json(res, 201, rule);
}

async function handleUpdateAlertRule(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: SQLiteStore,
  id: string,
): Promise<void> {
  const existing = store.getAlertRule(id);
  if (!existing) return json(res, 404, { error: 'rule not found' });
  const patch = (await readJson(req).catch(() => null)) as Record<string, unknown> | null;
  if (!patch || typeof patch !== 'object') return json(res, 400, { error: '请求体不能为空' });

  // 合并后整体校验（保证必填字段齐全且类型正确）
  const merged = { ...existing, ...patch };
  const result = validateRule(merged as never);
  if (!result.ok) return json(res, 400, { error: result.error });

  const updated = store.updateAlertRule(id, { ...result.rule, id });
  return json(res, 200, updated);
}

async function handleListAlertEvents(
  url: URL,
  res: http.ServerResponse,
  store: SQLiteStore,
): Promise<void> {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
  const status = url.searchParams.get('status') || undefined;
  return json(res, 200, store.listAlertEvents({ limit, offset, status }));
}

async function handleTestAlertRule(
  res: http.ServerResponse,
  notifier: Notifier | undefined,
  rule: AlertRuleRow,
): Promise<void> {
  if (!notifier) {
    return json(res, 400, { error: '告警未启用（未配置 ALERTS_ENABLED/缺省）' });
  }
  const ok = await notifier.send({
    status: 'fired',
    rule,
    value: rule.threshold,
    at: Date.now(),
  });
  return json(res, ok ? 200 : 502, ok ? { ok: true } : { error: 'webhook 发送失败（见服务端日志）' });
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
