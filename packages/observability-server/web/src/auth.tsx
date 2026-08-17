import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, clearToken, getToken, setToken, setOnUnauthorized } from './api';
import type { ProjectItem, UserInfo } from './types';

interface AuthState {
  username: string | null;
  ready: boolean;
  /** 服务端认证模式：单用户（Bearer）或多用户（JWT cookie + Bearer） */
  mode: 'single' | 'multi';
  /** 多用户模式下的当前用户信息（单用户模式为 null） */
  user: UserInfo | null;
  /** 多用户模式下当前选中的项目 ID */
  currentProjectId: string | null;
  /** 多用户模式下用户可访问的项目列表 */
  projects: ProjectItem[];
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** 切换项目上下文（刷新令牌以带上新 projectId） */
  switchProject: (pid: string) => Promise<void>;
  /** 重新拉取项目列表 */
  loadProjects: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  username: null,
  ready: false,
  mode: 'single',
  user: null,
  currentProjectId: null,
  projects: [],
  login: async () => {},
  logout: async () => {},
  switchProject: async () => {},
  loadProjects: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [username, setUsername] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<'single' | 'multi'>('single');
  const [user, setUser] = useState<UserInfo | null>(null);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectItem[]>([]);

  const handleUnauthorized = useCallback(() => {
    setUsername(null);
    setUser(null);
    setMode('single');
    setCurrentProjectId(null);
    setProjects([]);
    setReady(true);
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const list = await api.listProjects();
      setProjects(list);
    } catch {
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    setOnUnauthorized(handleUnauthorized);
    // 启动时校验本地 token 是否有效，并识别服务端认证模式
    if (getToken()) {
      api
        .me()
        .then((me) => {
          if (me.email) {
            // 多用户模式：响应含 email 字段
            setMode('multi');
            setUser({
              id: me.id,
              email: me.email,
              name: me.name,
              role: me.role,
              projectId: me.projectId,
            });
            setUsername(me.email);
            setCurrentProjectId(me.projectId ?? null);
            api.listProjects().then(setProjects).catch(() => setProjects([]));
          } else if (me.username) {
            // 单用户模式：响应仅含 username
            setMode('single');
            setUsername(me.username);
            setUser(null);
          }
        })
        .catch(() => {
          setUsername(null);
          setUser(null);
        })
        .finally(() => setReady(true));
    } else {
      setReady(true);
    }
  }, [handleUnauthorized]);

  const login = useCallback(async (userInput: string, pass: string) => {
    // 同时发送 email 与 username 字段，后端按 AUTH_MODE 取所需字段；
    // 通过响应形态判断模式（{ user, accessToken } 多用户 / { token, username } 单用户）
    const res = await api.loginMulti(userInput, pass);
    if ('accessToken' in res && res.user) {
      // 多用户模式
      setToken(res.accessToken);
      setMode('multi');
      setUser({ id: res.user.id, email: res.user.email, name: res.user.name });
      setUsername(res.user.email);
      try {
        const list = await api.listProjects();
        setProjects(list);
        // 未携带项目上下文时默认选中第一个
        setCurrentProjectId(list[0]?.id ?? null);
      } catch {
        setProjects([]);
        setCurrentProjectId(null);
      }
    } else if ('token' in res && res.username) {
      // 单用户模式
      setToken(res.token);
      setMode('single');
      setUsername(res.username);
      setUser(null);
      setCurrentProjectId(null);
      setProjects([]);
    } else {
      throw new Error('登录响应格式未知');
    }
  }, []);

  const switchProject = useCallback(async (pid: string) => {
    // 刷新令牌以携带新的 projectId 上下文；request() 也会捕获 X-Rotated-Token 头
    const res = await api.refresh(undefined, pid);
    setToken(res.accessToken);
    setCurrentProjectId(pid);
    setUser((prev) => (prev ? { ...prev, projectId: pid } : prev));
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // 网络异常也照常本地登出
    }
    clearToken();
    setUsername(null);
    setUser(null);
    setMode('single');
    setCurrentProjectId(null);
    setProjects([]);
  }, []);

  const value = useMemo(
    () => ({
      username,
      ready,
      mode,
      user,
      currentProjectId,
      projects,
      login,
      logout,
      switchProject,
      loadProjects,
    }),
    [username, ready, mode, user, currentProjectId, projects, login, logout, switchProject, loadProjects],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
