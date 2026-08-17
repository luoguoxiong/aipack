/**
 * Phase 4：项目管理 API。
 *
 *   GET    /api/projects                          列出当前用户所有项目（owner + ACL 授权）
 *   POST   /api/projects                          { name } → 创建项目（自动授权 owner）
 *   GET    /api/projects/:pid                     → 项目详情
 *   PATCH  /api/projects/:pid                     { name? } → 更新（owner）
 *   DELETE /api/projects/:pid                      → 删除项目（owner）
 *   GET    /api/projects/:pid/members              → 项目成员列表（成员可见）
 *   POST   /api/projects/:pid/members              { email, role } → 邀请成员（owner）
 *   PATCH  /api/projects/:pid/members/:userId      { role } → 调整角色（owner）
 *   DELETE /api/projects/:pid/members/:userId      → 移除成员（owner；不能移除自己）
 *   POST   /api/projects/:pid/apps                 { appId } → 关联 app 到项目（editor+）
 *   DELETE /api/projects/:pid/apps/:appId           → 解除关联（editor+）
 *
 * 角色守卫：
 * - 列表/详情/成员可见：任意成员（viewer+）
 * - 创建/邀请成员/移除成员/调整角色/删除项目：owner
 * - 关联 app：editor+
 *
 * 单用户模式（兼容）：所有操作直接放行，项目列表为空（不阻塞面板启动）。
 */
import http from 'node:http';
import type { JwtSessionManager } from '../auth/jwt';
import type { UserStore } from '../stores/user-store';
import type { ProjectStore, ProjectRecord } from '../stores/project-store';
import type { AclStore, AclRecord, ProjectRole } from '../stores/acl-store';
import { authenticate, requireRole, type AuthContext, type AuthResult, writeAuthFailure } from '../middleware/auth';
import { json, readJson } from './helpers';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROJECT_NAME_MAX = 100;

export interface ProjectsApiDeps {
  userStore: UserStore;
  projectStore: ProjectStore;
  aclStore: AclStore;
  jwt: JwtSessionManager;
}

export type ProjectsHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

export function createProjectsHandler(deps: ProjectsApiDeps): ProjectsHandler {
  const authCtx: AuthContext = {
    multi: { sessions: deps.jwt, userStore: deps.userStore, aclStore: deps.aclStore },
  };

  return async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const path = url.pathname;
      const method = req.method || 'GET';

      // ── 创建 ─────────────────────────────────────────────
      if (method === 'POST' && path === '/api/projects') {
        const auth = await authenticate(req, authCtx, true);
        if (!auth || !auth.ok) return auth ? writeAuthFailure(res, auth) : json(res, 401, { error: 'unauthorized' });
        if (!auth.user.isMulti) return json(res, 400, { error: '单用户模式不支持创建项目' });

        const body = (await readJson(req).catch(() => null)) as { name?: string } | null;
        const name = body?.name?.trim();
        if (!name || name.length > PROJECT_NAME_MAX) {
          return json(res, 400, { error: `name 为必填且长度 ≤${PROJECT_NAME_MAX}` });
        }
        const project = await deps.projectStore.createProject({ name, ownerId: auth.user.userId });
        // 自动授权 owner
        await deps.aclStore.grant({
          userId: auth.user.userId,
          projectId: project.id,
          role: 'owner',
          grantedBy: auth.user.userId,
        });
        // 重签 access token，带上新项目上下文
        const newToken = deps.jwt.signAccess(auth.user.userId, auth.user.email, 'owner', project.id);
        return json(res, 201, toProjectDto(project), {
          'Set-Cookie': deps.jwt.buildAccessCookie(newToken),
          'X-Rotated-Token': newToken,
        });
      }

      // ── 列表 ─────────────────────────────────────────────
      if (method === 'GET' && path === '/api/projects') {
        const auth = await authenticate(req, authCtx, true);
        if (!auth || !auth.ok) return auth ? writeAuthFailure(res, auth) : json(res, 401, { error: 'unauthorized' });
        if (!auth.user.isMulti) return json(res, 200, []); // 单用户模式：无项目概念
        const projects = await deps.projectStore.listProjectsByUser(auth.user.userId);
        return json(res, 200, projects.map(toProjectDto));
      }

      // ── /api/projects/:pid(/...) ─────────────────────────
      const pidMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
      if (!pidMatch) return json(res, 404, { error: 'Not Found' });
      const pid = decodeURIComponent(pidMatch[1]);
      const rest = pidMatch[2] || '';

      // 子路由
      if (rest === '' || rest === '/') {
        if (method === 'GET') return handleGetProject(req, res, deps, authCtx, pid);
        if (method === 'PATCH') return handleUpdateProject(req, res, deps, authCtx, pid);
        if (method === 'DELETE') return handleDeleteProject(req, res, deps, authCtx, pid);
      }
      if (rest === '/members') {
        if (method === 'GET') return handleListMembers(req, res, deps, authCtx, pid);
        if (method === 'POST') return handleInviteMember(req, res, deps, authCtx, pid);
      }
      const memberMatch = rest.match(/^\/members\/([^/]+)$/);
      if (memberMatch) {
        const userId = decodeURIComponent(memberMatch[1]);
        if (method === 'PATCH') return handleUpdateMember(req, res, deps, authCtx, pid, userId);
        if (method === 'DELETE') return handleRemoveMember(req, res, deps, authCtx, pid, userId);
      }
      if (rest === '/apps') {
        if (method === 'POST') return handleLinkApp(req, res, deps, authCtx, pid);
      }
      const appMatch = rest.match(/^\/apps\/([^/]+)$/);
      if (appMatch) {
        if (method === 'DELETE') return handleUnlinkApp(req, res, deps, authCtx, pid, decodeURIComponent(appMatch[1]));
      }

      return json(res, 404, { error: 'Not Found' });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : 'Internal Error' });
    }
  };
}

// ─── 子处理器 ──────────────────────────────────────────────────────

async function handleGetProject(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ProjectsApiDeps,
  authCtx: AuthContext,
  pid: string,
): Promise<void> {
  const auth = await authenticate(req, authCtx, true, pid);
  if (!auth || !auth.ok) return auth ? writeAuthFailure(res, auth) : json(res, 401, { error: 'unauthorized' });
  if (!auth.user.isMulti) return json(res, 404, { error: '单用户模式无项目' });
  const project = await deps.projectStore.getProject(pid);
  if (!project) return json(res, 404, { error: 'project not found' });
  return json(res, 200, toProjectDto(project), authHeaders(auth));
}

async function handleUpdateProject(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ProjectsApiDeps,
  authCtx: AuthContext,
  pid: string,
): Promise<void> {
  const guard = requireRole('owner');
  const auth = await guard(req, authCtx, pid);
  if (!auth.ok) return writeAuthFailure(res, auth);
  if (!auth.user.isMulti) return json(res, 400, { error: '单用户模式无项目' });

  const body = (await readJson(req).catch(() => null)) as { name?: string } | null;
  if (!body || typeof body !== 'object') return json(res, 400, { error: '请求体不能为空' });
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name || name.length > PROJECT_NAME_MAX) return json(res, 400, { error: `name 长度须在 1-${PROJECT_NAME_MAX}` });
    body.name = name;
  }
  const updated = await deps.projectStore.updateProject(pid, { name: body.name });
  if (!updated) return json(res, 404, { error: 'project not found' });
  return json(res, 200, toProjectDto(updated), authHeaders(auth));
}

async function handleDeleteProject(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ProjectsApiDeps,
  authCtx: AuthContext,
  pid: string,
): Promise<void> {
  const guard = requireRole('owner');
  const auth = await guard(req, authCtx, pid);
  if (!auth.ok) return writeAuthFailure(res, auth);
  if (!auth.user.isMulti) return json(res, 400, { error: '单用户模式无项目' });
  const deleted = await deps.projectStore.deleteProject(pid);
  return json(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: 'project not found' });
}

async function handleListMembers(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ProjectsApiDeps,
  authCtx: AuthContext,
  pid: string,
): Promise<void> {
  const auth = await authenticate(req, authCtx, true, pid);
  if (!auth || !auth.ok) return auth ? writeAuthFailure(res, auth) : json(res, 401, { error: 'unauthorized' });
  if (!auth.user.isMulti) return json(res, 200, []);
  const members = await deps.aclStore.listMembers(pid);
  // 拼用户基本信息
  const enriched = await Promise.all(
    members.map(async (m) => {
      const u = await deps.userStore.getUserById(m.userId);
      return {
        userId: m.userId,
        email: u?.email,
        name: u?.name,
        role: m.role,
        grantedAt: m.grantedAt,
        grantedBy: m.grantedBy,
      };
    }),
  );
  return json(res, 200, enriched, authHeaders(auth));
}

async function handleInviteMember(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ProjectsApiDeps,
  authCtx: AuthContext,
  pid: string,
): Promise<void> {
  const guard = requireRole('owner');
  const auth = await guard(req, authCtx, pid);
  if (!auth.ok) return writeAuthFailure(res, auth);
  if (!auth.user.isMulti) return json(res, 400, { error: '单用户模式无项目' });

  const body = (await readJson(req).catch(() => null)) as
    | { email?: string; role?: ProjectRole }
    | null;
  if (!body || typeof body.email !== 'string' || typeof body.role !== 'string') {
    return json(res, 400, { error: 'email 和 role 为必填' });
  }
  const email = body.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'email 格式不合法' });
  if (body.role !== 'editor' && body.role !== 'viewer') {
    return json(res, 400, { error: 'role 仅支持 editor / viewer（owner 不可手动授予）' });
  }
  const invitee = await deps.userStore.getUserByEmail(email);
  if (!invitee) return json(res, 404, { error: '该邮箱用户不存在' });
  if (invitee.id === auth.user.userId) return json(res, 400, { error: '不能邀请自己' });

  const acl = await deps.aclStore.grant({
    userId: invitee.id,
    projectId: pid,
    role: body.role,
    grantedBy: auth.user.userId,
  });
  return json(res, 201, {
    userId: invitee.id,
    email: invitee.email,
    name: invitee.name,
    role: acl.role,
    grantedAt: acl.grantedAt,
    grantedBy: acl.grantedBy,
  }, authHeaders(auth));
}

async function handleUpdateMember(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ProjectsApiDeps,
  authCtx: AuthContext,
  pid: string,
  userId: string,
): Promise<void> {
  const guard = requireRole('owner');
  const auth = await guard(req, authCtx, pid);
  if (!auth.ok) return writeAuthFailure(res, auth);
  if (!auth.user.isMulti) return json(res, 400, { error: '单用户模式无项目' });

  const body = (await readJson(req).catch(() => null)) as { role?: ProjectRole } | null;
  if (!body || typeof body.role !== 'string') return json(res, 400, { error: 'role 为必填' });
  if (body.role !== 'editor' && body.role !== 'viewer' && body.role !== 'owner') {
    return json(res, 400, { error: 'role 仅支持 owner / editor / viewer' });
  }
  if (userId === auth.user.userId && body.role !== 'owner') {
    return json(res, 400, { error: '不能降级自己的 owner 角色' });
  }
  const existing = await deps.aclStore.getRole(userId, pid);
  if (!existing) return json(res, 404, { error: 'member not found' });
  const acl = await deps.aclStore.grant({
    userId,
    projectId: pid,
    role: body.role,
    grantedBy: auth.user.userId,
  });
  return json(res, 200, {
    userId,
    role: acl.role,
    grantedAt: acl.grantedAt,
    grantedBy: acl.grantedBy,
  }, authHeaders(auth));
}

async function handleRemoveMember(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ProjectsApiDeps,
  authCtx: AuthContext,
  pid: string,
  userId: string,
): Promise<void> {
  const guard = requireRole('owner');
  const auth = await guard(req, authCtx, pid);
  if (!auth.ok) return writeAuthFailure(res, auth);
  if (!auth.user.isMulti) return json(res, 400, { error: '单用户模式无项目' });
  if (userId === auth.user.userId) return json(res, 400, { error: '不能移除自己' });
  const removed = await deps.aclStore.revoke(userId, pid);
  return json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'member not found' });
}

async function handleLinkApp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ProjectsApiDeps,
  authCtx: AuthContext,
  pid: string,
): Promise<void> {
  const guard = requireRole('editor');
  const auth = await guard(req, authCtx, pid);
  if (!auth.ok) return writeAuthFailure(res, auth);
  if (!auth.user.isMulti) return json(res, 400, { error: '单用户模式无项目' });

  const body = (await readJson(req).catch(() => null)) as { appId?: string } | null;
  if (!body || typeof body.appId !== 'string' || !body.appId) {
    return json(res, 400, { error: 'appId 为必填' });
  }
  await deps.projectStore.linkApp(pid, body.appId);
  return json(res, 200, { ok: true }, authHeaders(auth));
}

async function handleUnlinkApp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ProjectsApiDeps,
  authCtx: AuthContext,
  pid: string,
  appId: string,
): Promise<void> {
  const guard = requireRole('editor');
  const auth = await guard(req, authCtx, pid);
  if (!auth.ok) return writeAuthFailure(res, auth);
  if (!auth.user.isMulti) return json(res, 400, { error: '单用户模式无项目' });
  await deps.projectStore.unlinkApp(pid, appId);
  return json(res, 200, { ok: true }, authHeaders(auth));
}

// ─── 辅助 ──────────────────────────────────────────────────────────

function toProjectDto(p: ProjectRecord): {
  id: string;
  name: string;
  ownerId: string;
  createdAt: number;
} {
  return { id: p.id, name: p.name, ownerId: p.ownerId, createdAt: p.createdAt };
}

/** 若发生项目切换签发了新 token，通过 X-Rotated-Token 头返回 */
function authHeaders(auth: AuthResult): Record<string, string> {
  if (auth.rotatedAccessToken) return { 'X-Rotated-Token': auth.rotatedAccessToken };
  return {};
}
