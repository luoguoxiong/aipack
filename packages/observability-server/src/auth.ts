/**
 * 面板登录会话管理（observability-web 用）。
 *
 * - POST /api/auth/login：用户名 + 密码（ADMIN_USER/ADMIN_PASS）→ 签发 token
 * - 后续请求头 `Authorization: Bearer <token>`，会话 TTL 默认 24h
 * - 密码比较用恒时比较，防时序侧信道
 *
 * 两种会话模式（P2-3 部署运维）：
 * - 配置 `secret`（显式 SESSION_SECRET，或由显式 ADMIN_PASS 派生）：签发无状态
 *   HMAC-SHA256 签名 token（JWT 风格 header.payload.signature，含过期时间），
 *   重启不失效、零文件状态、不占内存；logout 为 no-op（客户端丢弃即可）。
 * - 未配置：保留内存 Map + randomUUID token（TTL 内有效，重启失效）。
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

export interface AdminCredentials {
  username: string;
  password: string;
}

interface Session {
  username: string;
  expiresAt: number;
}

/** 签名 token 的固定 header（HS256 + JWT 风格） */
const TOKEN_HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

export class SessionManager {
  /** 签名模式：secret 配置后为 null（无状态，不维护会话表） */
  private sessions: Map<string, Session> | null;
  private ttlMs: number;
  private readonly secret?: string;

  constructor(
    private credentials: AdminCredentials,
    opts?: { ttlMs?: number; secret?: string },
  ) {
    this.ttlMs = opts?.ttlMs ?? 24 * 3600 * 1000;
    this.secret = opts?.secret;
    this.sessions = this.secret ? null : new Map<string, Session>();
  }

  /** 是否运行在无状态签名模式 */
  get stateless(): boolean {
    return this.sessions === null;
  }

  /** 校验用户名/密码，成功签发 token；失败返回 null */
  login(username: string, password: string): string | null {
    if (!safeEqual(this.credentials.username, username)) return null;
    if (!safeEqual(this.credentials.password, password)) return null;
    if (!this.sessions) {
      return signToken(username, Date.now() + this.ttlMs, this.secret!);
    }
    const token = randomUUID();
    this.sessions.set(token, { username, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  logout(token: string): void {
    // 签名模式无状态：客户端丢弃 token 即可；内存模式删除会话
    this.sessions?.delete(token);
  }

  /** 校验 token，返回用户名；过期/验签失败返回 null */
  verify(token: string): string | null {
    if (!this.sessions) {
      return verifyToken(token, this.secret!);
    }
    const s = this.sessions.get(token);
    if (!s) return null;
    if (Date.now() > s.expiresAt) {
      this.sessions.delete(token);
      return null;
    }
    return s.username;
  }
}

/** 签发无状态签名 token：base64url(header).base64url(payload{sub,exp}).base64url(hmac) */
function signToken(sub: string, exp: number, secret: string): string {
  const payload = Buffer.from(JSON.stringify({ sub, exp })).toString('base64url');
  const signature = hmac(`${TOKEN_HEADER}.${payload}`, secret);
  return `${TOKEN_HEADER}.${payload}.${signature}`;
}

/** 验签 + 过期检查；结构非法/签名不符/过期均返回 null */
function verifyToken(token: string, secret: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  if (!safeEqualStr(hmac(`${header}.${payload}`, secret), signature)) return null;
  let body: { sub?: unknown; exp?: unknown };
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof body;
  } catch {
    return null;
  }
  if (typeof body.sub !== 'string') return null;
  if (typeof body.exp !== 'number' || !Number.isFinite(body.exp)) return null;
  if (Date.now() > body.exp) return null;
  return body.sub;
}

/** HMAC-SHA256 签名（secret 由 SessionManager 构造时传入，签名/验签共用同一 secret） */
function hmac(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
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

/** 恒时比较（base64url 等长字符串） */
function safeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
