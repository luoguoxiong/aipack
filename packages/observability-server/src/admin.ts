/**
 * 面板管理路由（observability-web 对接）：
 *
 * 单用户模式（AUTH_MODE=single，向后兼容）：
 *   POST /api/auth/login     { username, password } → { token, username }
 *   POST /api/auth/logout    (Bearer) → { ok }
 *   GET  /api/auth/me        (Bearer) → { username }
 *
 * 多用户模式（AUTH_MODE=multi，默认）：
 *   /api/auth/* 由 src/api/auth.ts 接管；admin.ts 不再处理 /api/auth/login
 *
 * 两模式共用：
 *   GET  /api/apps           (Bearer) → AppRecord[]（多用户按 projectId 过滤）
 *   POST /api/apps           (Bearer) { name, projectId? } → AppRecord（多用户需 editor+，自动 linkApp）
 *   GET  /api/apps/:appId/secret  (Bearer) → { appId, appSecret }
 *   POST /api/apps/:appId/regenerate-secret (Bearer) → { appId, appSecret }
 *   DELETE /api/apps/:appId  (Bearer) → { ok }
 *   GET/POST/PUT/DELETE /api/alerts/*   (Bearer) → 告警规则/事件
 *   GET  /api/meta           (Bearer) → { logStreamUrlTemplate }
 *
 * 单用户模式：sessions 必填（SessionManager）。
 * 多用户模式：authCtx 必填（含 JwtSessionManager + userStore + aclStore）+ projectStore。
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { SessionManager } from './auth';
import type { AppStore } from './stores/app-store';
import type { ProjectStore } from './stores/project-store';
import type { AlertStore, AlertRuleRow } from './store';
import { validateRule } from './alerts/rules';
import type { Notifier } from './alerts/notify';
import { authenticate, requireRole, type AuthContext, type AuthResult, writeAuthFailure } from './middleware/auth';
import { json, readJson } from './api/helpers';

export interface AdminDeps {
  /** 单用户模式会话（多用户模式为 undefined） */
  sessions?: SessionManager;
  /** 应用存储（异步接口；多用户模式从 businessStores 注入，单用户模式为 SQLiteStore） */
  appStore: AppStore;
  /** 告警存储（同步接口；始终为 SQLiteStore-backed） */
  alertStore: AlertStore;
  /** 多用户模式鉴权上下文（含 JWT 会话 + userStore + aclStore） */
  authCtx?: AuthContext;
  /** 项目存储（多用户模式按项目过滤 app 时用） */
  projectStore?: ProjectStore;
  /** 告警通知器（用于"测试通知"端点；alerts 未启用时为空） */
  notifier?: Notifier;
  /** 面板元信息：Trace 详情"查看日志"跳转模板（LOG_STREAM_URL_TEMPLATE） */
  logStreamUrlTemplate?: string;
}

export type AdminHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<void>;

export function createAdminHandler(deps: AdminDeps): AdminHandler {
  return async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const path = url.pathname;
      const method = req.method || 'GET';

      // ── 单用户模式登录（多用户由 api/auth.ts 接管）──────────
      if (deps.sessions && method === 'POST' && path === '/api/auth/login') {
        return handleSingleLogin(req, res, deps.sessions);
      }

      // ── 以下全部需要鉴权 ────────────────────────────────────
      const isMulti = !!deps.authCtx?.multi;
      let auth: AuthResult | null | { ok: false; status: number; error: string };
      if (isMulti) {
        auth = await authenticate(req, deps.authCtx!, true, url.searchParams.get('projectId') || undefined);
      } else {
        // 单用户模式
        const sessions = deps.sessions;
        if (!sessions) return json(res, 503, { error: 'admin 未启用' });
        const token = readBearer(req);
        const username = token ? sessions.verify(token) : null;
        if (!username) return json(res, 401, { error: 'unauthorized: missing or invalid token' });
        auth = { ok: true, user: { userId: username, isMulti: false, role: 'owner' } };
      }
      if (!auth || !auth.ok) return auth ? writeAuthFailure(res, auth) : json(res, 401, { error: 'unauthorized' });
      const authed = auth;

      // 单用户模式 logout/me（多用户由 api/auth.ts 接管）
      if (!isMulti) {
        if (method === 'POST' && path === '/api/auth/logout') {
          deps.sessions!.logout(readBearer(req));
          return json(res, 200, { ok: true });
        }
        if (method === 'GET' && path === '/api/auth/me') {
          return json(res, 200, { username: authed.user.userId });
        }
      }
      if (method === 'GET' && path === '/api/meta') {
        return json(res, 200, { logStreamUrlTemplate: deps.logStreamUrlTemplate });
      }

      // ── 应用管理 ───────────────────────────────────────────
      if (path === '/api/apps') {
        if (method === 'GET') return handleListApps(url, res, deps, authed);
        if (method === 'POST') return handleCreateApp(req, res, url, deps, authed);
      }

      const appMatch = path.match(/^\/api\/apps\/([^/]+)(?:\/(secret|regenerate-secret))?$/);
      if (appMatch) {
        const appId = decodeURIComponent(appMatch[1]);
        const action = appMatch[2];
        if (action === 'secret' && method === 'GET') return handleGetAppSecret(res, deps, authed, appId);
        if (action === 'regenerate-secret' && method === 'POST') {
          return handleRegenerateSecret(res, deps, authed, appId);
        }
        if (method === 'DELETE') return handleDeleteApp(res, deps, authed, appId);
      }

      // ── 告警规则 / 事件 ─────────────────────────────────────
      if (path === '/api/alerts/rules') {
        if (method === 'GET') return json(res, 200, deps.alertStore.listAlertRules());
        if (method === 'POST') return handleCreateAlertRule(req, res, deps.alertStore);
      }
      if (path === '/api/alerts/events') {
        if (method === 'GET') return handleListAlertEvents(url, res, deps.alertStore);
      }
      const alertTestMatch = path.match(/^\/api\/alerts\/rules\/([^/]+)\/test$/);
      if (alertTestMatch && method === 'POST') {
        const rule = deps.alertStore.getAlertRule(decodeURIComponent(alertTestMatch[1]));
        if (!rule) return json(res, 404, { error: 'rule not found' });
        return handleTestAlertRule(res, deps.notifier, rule);
      }
      const alertRuleMatch = path.match(/^\/api\/alerts\/rules\/([^/]+)$/);
      if (alertRuleMatch) {
        const id = decodeURIComponent(alertRuleMatch[1]);
        if (method === 'PUT') return handleUpdateAlertRule(req, res, deps.alertStore, id);
        if (method === 'DELETE') {
          const deleted = deps.alertStore.deleteAlertRule(id);
          return json(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: 'rule not found' });
        }
      }

      return json(res, 404, { error: 'Not Found' });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : 'Internal Error' });
    }
  };
}

// ─── 单用户登录（向后兼容） ─────────────────────────────────────────

async function handleSingleLogin(
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

// ─── 应用管理 ───────────────────────────────────────────────────────

async function handleListApps(
  url: URL,
  res: http.ServerResponse,
  deps: AdminDeps,
  auth: AuthResult,
): Promise<void> {
  const allApps = await deps.appStore.listApps();
  // 多用户模式：按项目过滤
  if (auth.user.isMulti && deps.projectStore) {
    const pid = url.searchParams.get('projectId') || auth.user.projectId;
    if (!pid) return json(res, 200, []); // 未选项目时返回空
    const projectAppIds = new Set(await deps.projectStore.listApps(pid));
    return json(res, 200, allApps.filter((a) => projectAppIds.has(a.appId)));
  }
  // 单用户模式：返回全部
  return json(res, 200, allApps);
}

async function handleCreateApp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: AdminDeps,
  auth: AuthResult,
): Promise<void> {
  const body = (await readJson(req).catch(() => null)) as { name?: string; projectId?: string } | null;
  const name = body?.name?.trim();
  if (!name) return json(res, 400, { error: 'name 为必填' });

  // 多用户模式：需要 editor+ 权限 + 自动 linkApp
  if (auth.user.isMulti) {
    const pid = body?.projectId || url.searchParams.get('projectId') || auth.user.projectId;
    if (!pid) return json(res, 400, { error: '多用户模式下创建应用需要 projectId' });
    const guard = requireRole('editor');
    const checked = await guard(req, deps.authCtx!, pid);
    if (!checked.ok) return writeAuthFailure(res, checked);
    const app = await deps.appStore.createApp(name);
    await deps.projectStore!.linkApp(pid, app.appId);
    return json(res, 201, app);
  }

  // 单用户模式：直接创建
  return json(res, 201, await deps.appStore.createApp(name));
}

async function handleGetAppSecret(
  res: http.ServerResponse,
  deps: AdminDeps,
  auth: AuthResult,
  appId: string,
): Promise<void> {
  const projectCheck = await checkAppProjectAccess(deps, auth, appId, 'viewer');
  if (!projectCheck.ok) return writeAuthFailure(res, projectCheck);
  const app = await deps.appStore.getApp(appId);
  if (!app) return json(res, 404, { error: 'app not found' });
  return json(res, 200, { appId: app.appId, appSecret: app.appSecret });
}

async function handleRegenerateSecret(
  res: http.ServerResponse,
  deps: AdminDeps,
  auth: AuthResult,
  appId: string,
): Promise<void> {
  const projectCheck = await checkAppProjectAccess(deps, auth, appId, 'editor');
  if (!projectCheck.ok) return writeAuthFailure(res, projectCheck);
  const secret = await deps.appStore.regenerateSecret(appId);
  if (!secret) return json(res, 404, { error: 'app not found' });
  return json(res, 200, { appId, appSecret: secret });
}

async function handleDeleteApp(
  res: http.ServerResponse,
  deps: AdminDeps,
  auth: AuthResult,
  appId: string,
): Promise<void> {
  const projectCheck = await checkAppProjectAccess(deps, auth, appId, 'owner');
  if (!projectCheck.ok) return writeAuthFailure(res, projectCheck);
  const deleted = await deps.appStore.deleteApp(appId);
  return json(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: 'app not found' });
}

/**
 * 多用户模式：校验用户对某 app 的项目权限。
 * 单用户模式：直接放行。
 */
async function checkAppProjectAccess(
  deps: AdminDeps,
  auth: AuthResult,
  appId: string,
  minRole: 'viewer' | 'editor' | 'owner',
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!auth.user.isMulti) return { ok: true };
  if (!deps.projectStore) return { ok: false, status: 503, error: 'projectStore 未注入' };
  const project = await deps.projectStore.getProjectByApp(appId);
  if (!project) {
    // app 未关联任何项目：仅允许 viewer 查看（已是 owner 隐式）
    // 实际上面板创建 app 必带 projectId，此处 app 历史数据兜底
    if (minRole === 'viewer') return { ok: true };
    return { ok: false, status: 403, error: 'app 未关联项目，无法校验权限' };
  }
  const role = await deps.authCtx!.multi!.aclStore.getRole(auth.user.userId, project.id);
  if (!role) return { ok: false, status: 403, error: '无该项目权限' };
  const LEVEL = { viewer: 1, editor: 2, owner: 3 };
  if (LEVEL[role] < LEVEL[minRole]) {
    return { ok: false, status: 403, error: `需要 ${minRole} 及以上权限` };
  }
  return { ok: true };
}

// ─── 告警端点实现 ─────────────────────────────────────────────────

async function handleCreateAlertRule(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  alertStore: AlertStore,
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
  alertStore.createAlertRule(rule);
  return json(res, 201, rule);
}

async function handleUpdateAlertRule(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  alertStore: AlertStore,
  id: string,
): Promise<void> {
  const existing = alertStore.getAlertRule(id);
  if (!existing) return json(res, 404, { error: 'rule not found' });
  const patch = (await readJson(req).catch(() => null)) as Record<string, unknown> | null;
  if (!patch || typeof patch !== 'object') return json(res, 400, { error: '请求体不能为空' });

  // 合并后整体校验（保证必填字段齐全且类型正确）
  const merged = { ...existing, ...patch };
  const result = validateRule(merged as never);
  if (!result.ok) return json(res, 400, { error: result.error });

  const updated = alertStore.updateAlertRule(id, { ...result.rule, id });
  return json(res, 200, updated);
}

async function handleListAlertEvents(
  url: URL,
  res: http.ServerResponse,
  alertStore: AlertStore,
): Promise<void> {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
  const status = url.searchParams.get('status') || undefined;
  return json(res, 200, alertStore.listAlertEvents({ limit, offset, status }));
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
