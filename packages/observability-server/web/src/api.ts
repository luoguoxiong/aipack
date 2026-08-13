/**
 * API 封装：自动附带 Bearer token（localStorage: obs_token）。
 * 401（会话过期/未登录）→ 触发全局登出回调，跳转登录页。
 */
import type {
  AlertEventListResponse,
  AlertRule,
  AppInfo,
  LoginResponse,
  Meta,
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

  const res = await fetch(urlPath, { ...init, headers });
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
  // ── 登录 ──────────────────────────────────────────────────────
  login: (username: string, password: string) =>
    request<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  me: () => request<{ username: string }>('/api/auth/me'),

  // ── 应用管理 ──────────────────────────────────────────────────
  listApps: () => request<AppInfo[]>('/api/apps'),
  createApp: (name: string) =>
    request<AppInfo>('/api/apps', { method: 'POST', body: JSON.stringify({ name }) }),
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
};

function qs(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}
