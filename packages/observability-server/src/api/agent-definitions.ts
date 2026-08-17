/**
 * Phase 5：Agent 定义生命周期 API。
 *
 *   POST   /api/projects/:pid/agents               { name, spec } → 创建 draft
 *   GET    /api/projects/:pid/agents                → 列表（按 name 取最新版本）
 *   GET    /api/projects/:pid/agents/:id            → 单条详情
 *   PATCH  /api/projects/:pid/agents/:id            { name?, spec? } → 更新 draft
 *   POST   /api/projects/:pid/agents/:id/publish    → 发布新版本
 *   POST   /api/projects/:pid/agents/:id/rollback?to=vN  → 回滚到指定版本
 *   GET    /api/projects/:pid/agents/:id/versions    → 版本列表（按 version 倒序）
 *
 * 角色守卫：
 * - 列表/详情/版本：viewer+
 * - 创建/更新 draft/publish/rollback：editor+
 * - 删除：owner
 *
 * 发布新版本后触发 `agent.published` webhook（Phase 5：通知订阅的 Agent 应用热重载）。
 */
import http from 'node:http';
import type { JwtSessionManager } from '../auth/jwt';
import type { UserStore } from '../stores/user-store';
import type { AclStore } from '../stores/acl-store';
import type { AgentDefinitionStore, AgentDefinitionRecord, UpdateAgentDefinitionInput } from '../stores/agent-definition-store';
import { authenticate, requireRole, type AuthContext, type AuthResult, writeAuthFailure } from '../middleware/auth';
import { validateAgentName, validateAgentSpec } from '../agent-definition/schema';
import { json, readJson } from './helpers';

export interface AgentDefinitionsApiDeps {
  userStore: UserStore;
  agentDefinitionStore: AgentDefinitionStore;
  aclStore: AclStore;
  jwt: JwtSessionManager;
  /** Webhook 触发器（Phase 5：发布事件通知订阅 Agent 应用） */
  webhook?: AgentWebhook;
}

/** 发布事件 webhook 接口（可注入真实 HTTP notifier 或 mock） */
export interface AgentWebhook {
  /** 发布新版本时触发，通知订阅 Agent 应用热重载 */
  onPublished(event: AgentPublishedEvent): Promise<void>;
}

export interface AgentPublishedEvent {
  projectId: string;
  agentId: string;
  name: string;
  version: number;
  spec: unknown;
  publishedBy: string;
  publishedAt: number;
}

export type AgentDefinitionsHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

export function createAgentDefinitionsHandler(deps: AgentDefinitionsApiDeps): AgentDefinitionsHandler {
  const authCtx: AuthContext = {
    multi: { sessions: deps.jwt, userStore: deps.userStore, aclStore: deps.aclStore },
  };

  return async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const path = url.pathname;
      const method = req.method || 'GET';

      // /api/projects/:pid/agents(/...)?
      const m = path.match(/^\/api\/projects\/([^/]+)\/agents(.*)$/);
      if (!m) return json(res, 404, { error: 'Not Found' });
      const pid = decodeURIComponent(m[1]);
      const rest = m[2] || '';

      // ── 列表 / 创建 ─────────────────────────────────────────
      if (rest === '' || rest === '/') {
        if (method === 'GET') return handleList(req, res, deps, authCtx, pid);
        if (method === 'POST') return handleCreate(req, res, deps, authCtx, pid);
      }

      // ── /:id(/...)?
      const idMatch = rest.match(/^\/([^/]+)(\/.*)?$/);
      if (!idMatch) return json(res, 404, { error: 'Not Found' });
      const id = decodeURIComponent(idMatch[1]);
      const sub = idMatch[2] || '';

      if (sub === '' || sub === '/') {
        if (method === 'GET') return handleGet(req, res, deps, authCtx, pid, id);
        if (method === 'PATCH') return handleUpdate(req, res, deps, authCtx, pid, id);
        if (method === 'DELETE') return handleDelete(req, res, deps, authCtx, pid, id);
      }
      if (sub === '/publish' && method === 'POST') {
        return handlePublish(req, res, deps, authCtx, pid, id);
      }
      if (sub === '/rollback' && method === 'POST') {
        return handleRollback(req, res, url, deps, authCtx, pid, id);
      }
      if (sub === '/versions' && method === 'GET') {
        return handleVersions(req, res, deps, authCtx, pid, id);
      }

      return json(res, 404, { error: 'Not Found' });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : 'Internal Error' });
    }
  };
}

// ─── 端点实现 ──────────────────────────────────────────────────────

async function handleList(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AgentDefinitionsApiDeps,
  authCtx: AuthContext,
  pid: string,
): Promise<void> {
  const auth = await authenticate(req, authCtx, true, pid);
  if (!auth || !auth.ok) return auth ? writeAuthFailure(res, auth) : json(res, 401, { error: 'unauthorized' });
  if (!auth.user.isMulti) return json(res, 400, { error: '单用户模式不支持 Agent 定义' });
  const items = await deps.agentDefinitionStore.list(pid);
  return json(res, 200, items.map(toDto), authHeaders(auth));
}

async function handleCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AgentDefinitionsApiDeps,
  authCtx: AuthContext,
  pid: string,
): Promise<void> {
  const guard = requireRole('editor');
  const auth = await guard(req, authCtx, pid);
  if (!auth.ok) return writeAuthFailure(res, auth);
  if (!auth.user.isMulti) return json(res, 400, { error: '单用户模式不支持 Agent 定义' });

  const body = (await readJson(req).catch(() => null)) as { name?: string; spec?: unknown } | null;
  const nameCheck = validateAgentName(body?.name);
  if (!nameCheck.ok) return json(res, 400, { error: nameCheck.error });
  const specCheck = validateAgentSpec(body?.spec);
  if (!specCheck.ok) return json(res, 400, { error: `${specCheck.error}${specCheck.path ? `（${specCheck.path}）` : ''}` });

  // 校验同项目下 name 不重复（draft 或 published 任一存在即视为重名）
  const existing = await deps.agentDefinitionStore.list(pid);
  if (existing.some((d) => d.name === nameCheck.name)) {
    return json(res, 409, { error: `Agent 定义 "${nameCheck.name}" 已存在` });
  }

  const created = await deps.agentDefinitionStore.create({
    projectId: pid,
    name: nameCheck.name!,
    spec: specCheck.spec!,
    createdBy: auth.user.userId,
  });
  return json(res, 201, toDto(created));
}

async function handleGet(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AgentDefinitionsApiDeps,
  authCtx: AuthContext,
  pid: string,
  id: string,
): Promise<void> {
  const auth = await authenticate(req, authCtx, true, pid);
  if (!auth || !auth.ok) return auth ? writeAuthFailure(res, auth) : json(res, 401, { error: 'unauthorized' });
  if (!auth.user.isMulti) return json(res, 400, { error: '单用户模式不支持 Agent 定义' });
  const def = await deps.agentDefinitionStore.getById(id);
  if (!def || def.projectId !== pid) return json(res, 404, { error: 'agent definition not found' });
  return json(res, 200, toDto(def), authHeaders(auth));
}

async function handleUpdate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AgentDefinitionsApiDeps,
  authCtx: AuthContext,
  pid: string,
  id: string,
): Promise<void> {
  const guard = requireRole('editor');
  const auth = await guard(req, authCtx, pid);
  if (!auth.ok) return writeAuthFailure(res, auth);
  if (!auth.user.isMulti) return json(res, 400, { error: '单用户模式不支持 Agent 定义' });

  const existing = await deps.agentDefinitionStore.getById(id);
  if (!existing || existing.projectId !== pid) return json(res, 404, { error: 'agent definition not found' });
  if (existing.status !== 'draft') {
    return json(res, 409, { error: '仅 draft 状态可编辑；请基于已发布版本创建新 draft' });
  }

  const body = (await readJson(req).catch(() => null)) as { name?: string; spec?: unknown } | null;
  const patch: UpdateAgentDefinitionInput = {};
  if (body?.name !== undefined) {
    const nameCheck = validateAgentName(body.name);
    if (!nameCheck.ok) return json(res, 400, { error: nameCheck.error });
    patch.name = nameCheck.name;
  }
  if (body?.spec !== undefined) {
    const specCheck = validateAgentSpec(body.spec);
    if (!specCheck.ok) return json(res, 400, { error: `${specCheck.error}${specCheck.path ? `（${specCheck.path}）` : ''}` });
    patch.spec = specCheck.spec;
  }

  const updated = await deps.agentDefinitionStore.updateDraft(id, patch);
  if (!updated) return json(res, 404, { error: 'agent definition not found' });
  return json(res, 200, toDto(updated));
}

async function handlePublish(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AgentDefinitionsApiDeps,
  authCtx: AuthContext,
  pid: string,
  id: string,
): Promise<void> {
  const guard = requireRole('editor');
  const auth = await guard(req, authCtx, pid);
  if (!auth.ok) return writeAuthFailure(res, auth);
  if (!auth.user.isMulti) return json(res, 400, { error: '单用户模式不支持 Agent 定义' });

  const existing = await deps.agentDefinitionStore.getById(id);
  if (!existing || existing.projectId !== pid) return json(res, 404, { error: 'agent definition not found' });
  if (existing.status !== 'draft') {
    return json(res, 409, { error: '仅 draft 状态可发布' });
  }

  try {
    const published = await deps.agentDefinitionStore.publish(pid, existing.name, auth.user.userId);
    // Webhook：通知订阅 Agent 应用热重载（失败不影响发布结果）
    if (deps.webhook) {
      deps.webhook
        .onPublished({
          projectId: pid,
          agentId: published.id,
          name: published.name,
          version: published.version,
          spec: published.spec,
          publishedBy: auth.user.userId,
          publishedAt: published.publishedAt ?? Date.now(),
        })
        .catch((err) => {
          console.error('[observability-server] agent.published webhook 失败:', err);
        });
    }
    return json(res, 200, toDto(published));
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : 'Internal Error' });
  }
}

async function handleRollback(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: AgentDefinitionsApiDeps,
  authCtx: AuthContext,
  pid: string,
  id: string,
): Promise<void> {
  const guard = requireRole('editor');
  const auth = await guard(req, authCtx, pid);
  if (!auth.ok) return writeAuthFailure(res, auth);
  if (!auth.user.isMulti) return json(res, 400, { error: '单用户模式不支持 Agent 定义' });

  const toRaw = url.searchParams.get('to');
  const toVersion = Number(toRaw);
  if (!toRaw || !Number.isFinite(toVersion) || toVersion <= 0) {
    return json(res, 400, { error: 'query 参数 to=vN 为必填（正整数版本号）' });
  }

  const existing = await deps.agentDefinitionStore.getById(id);
  if (!existing || existing.projectId !== pid) return json(res, 404, { error: 'agent definition not found' });

  try {
    const rolledBack = await deps.agentDefinitionStore.rollback(
      pid,
      existing.name,
      Math.floor(toVersion),
      auth.user.userId,
    );
    // 回滚也触发 webhook（视为重新发布该版本）
    if (deps.webhook) {
      deps.webhook
        .onPublished({
          projectId: pid,
          agentId: rolledBack.id,
          name: rolledBack.name,
          version: rolledBack.version,
          spec: rolledBack.spec,
          publishedBy: auth.user.userId,
          publishedAt: rolledBack.publishedAt ?? Date.now(),
        })
        .catch((err) => {
          console.error('[observability-server] agent.published (rollback) webhook 失败:', err);
        });
    }
    return json(res, 200, toDto(rolledBack));
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : 'Internal Error' });
  }
}

async function handleVersions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AgentDefinitionsApiDeps,
  authCtx: AuthContext,
  pid: string,
  id: string,
): Promise<void> {
  const auth = await authenticate(req, authCtx, true, pid);
  if (!auth || !auth.ok) return auth ? writeAuthFailure(res, auth) : json(res, 401, { error: 'unauthorized' });
  if (!auth.user.isMulti) return json(res, 400, { error: '单用户模式不支持 Agent 定义' });
  const existing = await deps.agentDefinitionStore.getById(id);
  if (!existing || existing.projectId !== pid) return json(res, 404, { error: 'agent definition not found' });
  const versions = await deps.agentDefinitionStore.listVersions(pid, existing.name);
  return json(res, 200, versions.map(toDto), authHeaders(auth));
}

async function handleDelete(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AgentDefinitionsApiDeps,
  authCtx: AuthContext,
  pid: string,
  id: string,
): Promise<void> {
  const guard = requireRole('owner');
  const auth = await guard(req, authCtx, pid);
  if (!auth.ok) return writeAuthFailure(res, auth);
  if (!auth.user.isMulti) return json(res, 400, { error: '单用户模式不支持 Agent 定义' });
  const existing = await deps.agentDefinitionStore.getById(id);
  if (!existing || existing.projectId !== pid) return json(res, 404, { error: 'agent definition not found' });
  const deleted = await deps.agentDefinitionStore.delete(id);
  return json(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: 'not found' });
}

// ─── 辅助 ──────────────────────────────────────────────────────────

function toDto(d: AgentDefinitionRecord): {
  id: string;
  projectId: string;
  name: string;
  version: number;
  status: string;
  spec: unknown;
  createdBy: string;
  createdAt: number;
  publishedAt?: number;
} {
  return {
    id: d.id,
    projectId: d.projectId,
    name: d.name,
    version: d.version,
    status: d.status,
    spec: d.spec,
    createdBy: d.createdBy,
    createdAt: d.createdAt,
    publishedAt: d.publishedAt,
  };
}

function authHeaders(auth: AuthResult): Record<string, string> {
  if (auth.rotatedAccessToken) return { 'X-Rotated-Token': auth.rotatedAccessToken };
  return {};
}
