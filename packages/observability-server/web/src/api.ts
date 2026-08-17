/**
 * API 封装：自动附带 Bearer token（localStorage: obs_token）。
 * 401（会话过期/未登录）→ 触发全局登出回调，跳转登录页。
 */
import type {
  AgentDefinitionItem,
  AgentSpec,
  AlertEventListResponse,
  AlertRule,
  AppInfo,
  CostSummaryItem,
  ErrorClassCountItem,
  ErrorClassDrillResult,
  LoginResponse,
  Meta,
  ModelPrice,
  MultiLoginResponse,
  MultiMeResponse,
  ProjectItem,
  ProjectMember,
  Summary,
  TimeseriesPoint,
  ToolStat,
  TraceDetail,
  TraceListResponse,
  VersionListResponse,
} from './types';

const TOKEN_KEY = 'obs_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** 会话过期（401）时调用；由 App 注入，避免 api 层依赖 React 上下文 */
export let onUnauthorized: () => void = () => {};
export function setOnUnauthorized(fn: () => void): void {
  onUnauthorized = fn;
}

async function request<T>(urlPath: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.body !== undefined && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }

  const res = await fetch(urlPath, { ...init, headers, credentials: 'include' });
  // 后端在项目切换/令牌轮换时通过此头返回新的 access token，需同步到 localStorage
  const rotated = res.headers.get('X-Rotated-Token');
  if (rotated) setToken(rotated);
  if (res.status === 401 && !urlPath.startsWith('/api/auth/login')) {
    clearToken();
    onUnauthorized();
    throw new Error('登录已过期，请重新登录');
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(body?.error || `请求失败(${res.status})`);
  }
  return body as T;
}

export const api = {
  // ── 登录 / 认证 ──────────────────────────────────────────────
  /** 单用户登录（向后兼容，AUTH_MODE=single） */
  login: (username: string, password: string) =>
    request<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  /**
   * 多用户登录（AUTH_MODE=multi）。同时附带 email 与 username 字段，
   * 后端按 AUTH_MODE 取所需字段；响应形态决定模式（accessToken|user vs token|username）。
   */
  loginMulti: (email: string, password: string, projectId?: string) =>
    request<MultiLoginResponse | LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, username: email, password, projectId }),
    }),
  /** 多用户注册 */
  register: (email: string, password: string, name?: string) =>
    request<MultiLoginResponse>('/api/users/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    }),
  /** 刷新令牌（可携带 projectId 切换项目上下文） */
  refresh: (refreshToken?: string, projectId?: string) =>
    request<MultiLoginResponse>('/api/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken, projectId }),
    }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  /** /api/auth/me —— 单用户返回 { username }，多用户返回 { id, email, ... } */
  me: () => request<MultiMeResponse & { username?: string }>('/api/auth/me'),
  /** /api/users/me —— 多用户个人资料 */
  meMulti: () =>
    request<{ id: string; email: string; name?: string; createdAt?: number }>('/api/users/me'),
  /** 更新当前用户资料（多用户） */
  updateMe: (patch: { name?: string }) =>
    request<{ id: string; email: string; name?: string; createdAt?: number }>('/api/users/me', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  // ── 应用管理 ──────────────────────────────────────────────────
  listApps: (projectId?: string) => request<AppInfo[]>(`/api/apps${qs({ projectId })}`),
  createApp: (name: string, projectId?: string) =>
    request<AppInfo>('/api/apps', { method: 'POST', body: JSON.stringify({ name, projectId }) }),
  deleteApp: (appId: string) =>
    request<{ ok: true }>(`/api/apps/${encodeURIComponent(appId)}`, { method: 'DELETE' }),
  regenerateSecret: (appId: string) =>
    request<{ appId: string; appSecret: string }>(
      `/api/apps/${encodeURIComponent(appId)}/regenerate-secret`,
      { method: 'POST' },
    ),
  getSecret: (appId: string) =>
    request<{ appId: string; appSecret: string }>(
      `/api/apps/${encodeURIComponent(appId)}/secret`,
    ),

  // ── 指标 ──────────────────────────────────────────────────────
  summary: <T = Summary>(params: Record<string, string | number | undefined> = {}) =>
    request<T>(`/metrics/summary${qs(params)}`),
  timeseries: (params: Record<string, string | number | undefined> = {}) =>
    request<TimeseriesPoint[]>(`/metrics/timeseries${qs(params)}`),
  tools: (params: Record<string, string | number | undefined> = {}) =>
    request<ToolStat[]>(`/metrics/tools${qs(params)}`),
  /** 版本聚合（DB 直查）：items 按 lastSeenAt 倒序（最近版本在前） */
  versions: (params: Record<string, string | number | undefined> = {}) =>
    request<VersionListResponse>(`/metrics/versions${qs(params)}`),

  // ── Trace ─────────────────────────────────────────────────────
  traces: (params: Record<string, string | number | undefined> = {}) =>
    request<TraceListResponse>(`/traces${qs(params)}`),
  traceDetail: (traceId: string) =>
    request<TraceDetail>(`/traces/${encodeURIComponent(traceId)}`),

  // ── 元信息 ─────────────────────────────────────────────────────
  meta: () => request<Meta>('/api/meta'),

  // ── 告警 ──────────────────────────────────────────────────────
  alertRules: () => request<AlertRule[]>('/api/alerts/rules'),
  createAlertRule: (rule: Partial<AlertRule>) =>
    request<AlertRule>('/api/alerts/rules', { method: 'POST', body: JSON.stringify(rule) }),
  updateAlertRule: (id: string, patch: Partial<AlertRule>) =>
    request<AlertRule>(`/api/alerts/rules/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  deleteAlertRule: (id: string) =>
    request<{ ok: true }>(`/api/alerts/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testAlertRule: (id: string) =>
    request<{ ok: true }>(`/api/alerts/rules/${encodeURIComponent(id)}/test`, { method: 'POST' }),
  alertEvents: (params: Record<string, string | number | undefined> = {}) =>
    request<AlertEventListResponse>(`/api/alerts/events${qs(params)}`),

  // ── 项目（多用户模式） ──────────────────────────────────────────
  listProjects: () => request<ProjectItem[]>('/api/projects'),
  /** 创建项目后，后端通过 X-Rotated-Token 头返回带新项目上下文的 access token */
  createProject: (name: string) =>
    request<ProjectItem>('/api/projects', { method: 'POST', body: JSON.stringify({ name }) }),
  getProject: (pid: string) => request<ProjectItem>(`/api/projects/${encodeURIComponent(pid)}`),
  updateProject: (pid: string, patch: { name?: string }) =>
    request<ProjectItem>(`/api/projects/${encodeURIComponent(pid)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteProject: (pid: string) =>
    request<{ ok: true }>(`/api/projects/${encodeURIComponent(pid)}`, { method: 'DELETE' }),

  // ── 项目成员 ──────────────────────────────────────────────────────
  listMembers: (pid: string) =>
    request<ProjectMember[]>(`/api/projects/${encodeURIComponent(pid)}/members`),
  inviteMember: (pid: string, email: string, role: ProjectMember['role']) =>
    request<ProjectMember>(`/api/projects/${encodeURIComponent(pid)}/members`, {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    }),
  updateMember: (pid: string, userId: string, role: ProjectMember['role']) =>
    request<ProjectMember>(
      `/api/projects/${encodeURIComponent(pid)}/members/${encodeURIComponent(userId)}`,
      { method: 'PATCH', body: JSON.stringify({ role }) },
    ),
  removeMember: (pid: string, userId: string) =>
    request<{ ok: true }>(
      `/api/projects/${encodeURIComponent(pid)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    ),

  // ── Agent 定义（多用户模式） ─────────────────────────────────────
  listAgents: (pid: string) =>
    request<AgentDefinitionItem[]>(`/api/projects/${encodeURIComponent(pid)}/agents`),
  createAgent: (pid: string, name: string, spec: AgentSpec) =>
    request<AgentDefinitionItem>(`/api/projects/${encodeURIComponent(pid)}/agents`, {
      method: 'POST',
      body: JSON.stringify({ name, spec }),
    }),
  getAgent: (pid: string, id: string) =>
    request<AgentDefinitionItem>(
      `/api/projects/${encodeURIComponent(pid)}/agents/${encodeURIComponent(id)}`,
    ),
  updateAgent: (pid: string, id: string, patch: { name?: string; spec?: AgentSpec }) =>
    request<AgentDefinitionItem>(
      `/api/projects/${encodeURIComponent(pid)}/agents/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),
  publishAgent: (pid: string, id: string) =>
    request<AgentDefinitionItem>(
      `/api/projects/${encodeURIComponent(pid)}/agents/${encodeURIComponent(id)}/publish`,
      { method: 'POST' },
    ),
  rollbackAgent: (pid: string, id: string, to?: string) =>
    request<AgentDefinitionItem>(
      `/api/projects/${encodeURIComponent(pid)}/agents/${encodeURIComponent(id)}/rollback${qs({ to })}`,
      { method: 'POST' },
    ),
  listAgentVersions: (pid: string, id: string) =>
    request<AgentDefinitionItem[]>(
      `/api/projects/${encodeURIComponent(pid)}/agents/${encodeURIComponent(id)}/versions`,
    ),
  deleteAgent: (pid: string, id: string) =>
    request<{ ok: true }>(
      `/api/projects/${encodeURIComponent(pid)}/agents/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
};

function qs(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

// ── Phase 6 成本核算 ──────────────────────────────────────────────

/** 成本聚合（按 model/app 维度分组） */
export async function fetchCostSummary(filter: {
  appId?: string;
  since?: number;
  until?: number;
  groupBy?: string;
}): Promise<CostSummaryItem[]> {
  return request<CostSummaryItem[]>(`/metrics/cost${qs(filter)}`);
}

/** 列出全部模型价格配置 */
export async function fetchModelPrices(): Promise<ModelPrice[]> {
  return request<ModelPrice[]>('/metrics/model-prices');
}

/** 新增模型价格 */
export async function createModelPrice(input: Partial<ModelPrice>): Promise<ModelPrice> {
  return request<ModelPrice>('/metrics/model-prices', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** 删除模型价格（按 modelId + 生效时间定位） */
export async function deleteModelPrice(modelId: string, effectiveAt: number): Promise<void> {
  await request<{ ok: true }>(
    `/metrics/model-prices/${encodeURIComponent(modelId)}${qs({ effectiveAt })}`,
    { method: 'DELETE' },
  );
}

// ── Phase 9 错误归因下钻 ───────────────────────────────────────────

/** 错误类 TopN 列表（响应形如 { items: [...] }，解包后返回数组） */
export async function fetchErrorClasses(filter: {
  appId?: string;
  since?: number;
  until?: number;
  limit?: number;
}): Promise<ErrorClassCountItem[]> {
  const res = await request<{ items: ErrorClassCountItem[] }>(
    `/metrics/error-classes${qs(filter)}`,
  );
  return res.items;
}

/** 单错误类下钻详情：最近 trace + 模型/工具分布 */
export async function fetchErrorClassDrill(
  cls: string,
  filter: { appId?: string; since?: number; until?: number; limit?: number },
): Promise<ErrorClassDrillResult> {
  return request<ErrorClassDrillResult>(
    `/metrics/error-classes/${encodeURIComponent(cls)}${qs(filter)}`,
  );
}
