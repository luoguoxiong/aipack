/**
 * 面板登录会话管理（observability-web 用）。
 *
 * - POST /api/auth/login：用户名 + 密码（ADMIN_USER/ADMIN_PASS）→ 签发 token
 * - 后续请求头 `Authorization: Bearer <token>`，会话 TTL 默认 24h（内存存储）
 * - 密码比较用恒时比较，防时序侧信道
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

export interface AdminCredentials {
  username: string;
  password: string;
}

interface Session {
  username: string;
  expiresAt: number;
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  constructor(
    private credentials: AdminCredentials,
    private ttlMs = 24 * 3600 * 1000,
  ) {}

  /** 校验用户名/密码，成功签发 token；失败返回 null */
  login(username: string, password: string): string | null {
    if (!safeEqual(this.credentials.username, username)) return null;
    if (!safeEqual(this.credentials.password, password)) return null;
    const token = randomUUID();
    this.sessions.set(token, { username, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  logout(token: string): void {
    this.sessions.delete(token);
  }

  /** 校验 token，返回用户名；过期自动清除 */
  verify(token: string): string | null {
    const s = this.sessions.get(token);
    if (!s) return null;
    if (Date.now() > s.expiresAt) {
      this.sessions.delete(token);
      return null;
    }
    return s.username;
  }
}

/** 从请求头解析 Bearer token */
export function readBearerToken(req: http.IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return undefined;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : undefined;
}

/** 恒时比较 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
