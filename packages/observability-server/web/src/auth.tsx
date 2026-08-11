import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, getToken, setToken, setOnUnauthorized } from './api';

interface AuthState {
  username: string | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  username: null,
  ready: false,
  login: async () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [username, setUsername] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const handleUnauthorized = useCallback(() => {
    setUsername(null);
    setReady(true);
  }, []);

  useEffect(() => {
    setOnUnauthorized(handleUnauthorized);
    // 启动时校验本地 token 是否有效
    if (getToken()) {
      api
        .me()
        .then((me) => setUsername(me.username))
        .catch(() => setUsername(null))
        .finally(() => setReady(true));
    } else {
      setReady(true);
    }
  }, [handleUnauthorized]);

  const login = useCallback(async (user: string, pass: string) => {
    const res = await api.login(user, pass);
    setToken(res.token);
    setUsername(res.username);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // 网络异常也照常本地登出
    }
    setUsername(null);
  }, []);

  const value = useMemo(
    () => ({ username, ready, login, logout }),
    [username, ready, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
