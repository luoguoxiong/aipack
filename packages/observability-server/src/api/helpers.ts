/**
 * Phase 4：HTTP API 公共辅助（readJson / json / cookie / route 匹配）。
 *
 * 提取自 src/admin.ts，避免 users/projects/auth/agent-definitions 各自重复。
 */
import http from 'node:http';

export const MAX_BODY = 64 * 1024;

/** 读取并解析 JSON 请求体；空 body 返回 {}；非法 JSON 抛错 */
export function readJson(req: http.IncomingMessage): Promise<unknown> {
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

/** 写 JSON 响应（可附加 Set-Cookie 等额外 header） */
export function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string | string[]> = {},
): Promise<void> {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  return new Promise((resolve) => {
    res.end(JSON.stringify(body), () => resolve());
  });
}

/** 追加 Set-Cookie（允许多条） */
export function setCookies(res: http.ServerResponse, cookies: string[]): void {
  const existing = res.getHeader('Set-Cookie');
  const all = Array.isArray(existing) ? [...existing] : existing ? [String(existing)] : [];
  all.push(...cookies);
  res.setHeader('Set-Cookie', all);
}

/** 从 query string 取必填字段 */
export function requiredQuery(url: URL, name: string): string | null {
  const v = url.searchParams.get(name);
  return v && v.length > 0 ? v : null;
}
