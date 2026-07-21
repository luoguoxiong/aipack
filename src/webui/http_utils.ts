import http from 'http';
import { URL } from 'url';
import net from 'net';
import crypto from 'crypto';

export type QueryParams = Record<string, string[]>;

export function stripTrailingSlash(path: string): string {
  if (path.length > 1 && path.endsWith('/')) {
    return path.slice(0, -1);
  }
  return path || '/';
}

export function normalizeConfigPath(path: string): string {
  return stripTrailingSlash(path);
}

export function caseInsensitiveHeader(headers: http.IncomingHttpHeaders, key: string): string {
  const value = headers[key] || headers[key.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0]?.trim() || '';
  }
  return (value || '').trim();
}

const HOST_IPV6_RE = /^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;
const HOST_IPV4_RE = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/;

export function safeHostHeader(value: string): string {
  value = value.trim();
  if (!value) return '';
  if (HOST_IPV6_RE.test(value)) return value;
  if (HOST_IPV4_RE.test(value)) return value;
  return '';
}

export function hostForUrl(host: string, port: number): string {
  host = host.trim();
  if (host === '0.0.0.0' || host === '::') {
    host = '127.0.0.1';
  }
  if (host.includes(':') && !host.startsWith('[')) {
    host = `[${host}]`;
  }
  return `${host}:${port}`;
}

export function httpJsonResponse(data: Record<string, unknown>, status = 200): {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
} {
  const body = Buffer.from(JSON.stringify(data), 'utf-8');
  return {
    status,
    headers: {
      'Date': new Date().toUTCString(),
      'Connection': 'close',
      'Content-Length': String(body.length),
      'Content-Type': 'application/json; charset=utf-8',
    },
    body,
  };
}

export function httpResponse(
  body: Buffer,
  options: {
    status?: number;
    contentType?: string;
    extraHeaders?: Array<[string, string]>;
  } = {},
): {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
} {
  const status = options.status ?? 200;
  const contentType = options.contentType ?? 'text/plain; charset=utf-8';
  const headers: Record<string, string> = {
    'Date': new Date().toUTCString(),
    'Connection': 'close',
    'Content-Length': String(body.length),
    'Content-Type': contentType,
  };
  if (options.extraHeaders) {
    for (const [key, value] of options.extraHeaders) {
      headers[key] = value;
    }
  }
  return { status, headers, body };
}

export function httpError(status: number, message?: string): {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
} {
  const body = Buffer.from(message || http.STATUS_CODES[status] || 'Error', 'utf-8');
  return httpResponse(body, { status });
}

export function parseRequestPath(pathWithQuery: string): [string, QueryParams] {
  const parsed = new URL(pathWithQuery, 'http://x');
  const path = stripTrailingSlash(parsed.pathname || '/');
  const query: QueryParams = {};
  for (const [key, value] of parsed.searchParams.entries()) {
    if (!query[key]) {
      query[key] = [];
    }
    query[key].push(value);
  }
  return [path, query];
}

export function parseQuery(pathWithQuery: string): QueryParams {
  return parseRequestPath(pathWithQuery)[1];
}

export function queryFirst(query: QueryParams, key: string): string | null {
  const values = query[key];
  return values ? values[0] : null;
}

export function isLocalhost(connection: net.Socket): boolean {
  const addr = connection.remoteAddress;
  if (!addr) return false;
  let host = addr;
  if (host.startsWith('::ffff:')) {
    host = host.slice(7);
  }
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function hostWithoutPort(value: string): string {
  value = value.trim().replace(/^["']|["']$/g, '');
  if (!value) return '';
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : value;
  }
  const colonCount = (value.match(/:/g) || []).length;
  if (colonCount === 1 || colonCount === 2) {
    const lastColonIdx = value.lastIndexOf(':');
    const host = value.slice(0, lastColonIdx);
    const port = value.slice(lastColonIdx + 1);
    if (port && /^\d+$/.test(port)) {
      return host;
    }
  }
  return value;
}

export function isLoopbackHost(value: string): boolean {
  let host = hostWithoutPort(value);
  if (host.startsWith('::ffff:')) {
    host = host.slice(7);
  }
  host = host.replace(/\.$/, '').toLowerCase();
  if (host === 'localhost') return true;
  try {
    return net.isIP(host) !== 0 && (
      host === '127.0.0.1' ||
      host === '::1' ||
      host.startsWith('127.')
    );
  } catch {
    return false;
  }
}

function splitCommaHeader(value: string): string[] {
  return value.split(',').map(part => part.trim()).filter(Boolean);
}

function forwardedHeaderValues(value: string, key: string): string[] {
  const values: string[] = [];
  for (const entry of splitCommaHeader(value)) {
    for (const part of entry.split(';')) {
      const eqIdx = part.indexOf('=');
      const name = eqIdx >= 0 ? part.slice(0, eqIdx) : part;
      const sep = eqIdx >= 0 ? '=' : '';
      const raw = eqIdx >= 0 ? part.slice(eqIdx + 1) : '';
      if (sep && name.trim().toLowerCase() === key) {
        const cleaned = raw.trim().replace(/^["']|["']$/g, '');
        if (cleaned) {
          values.push(cleaned);
        }
      }
    }
  }
  return values;
}

function allForwardedValuesAreLoopback(headers: http.IncomingHttpHeaders): boolean {
  const checks: string[] = [];
  checks.push(...splitCommaHeader(caseInsensitiveHeader(headers, 'X-Forwarded-For')));
  checks.push(...splitCommaHeader(caseInsensitiveHeader(headers, 'X-Real-IP')));
  checks.push(...splitCommaHeader(caseInsensitiveHeader(headers, 'X-Forwarded-Host')));
  const forwarded = caseInsensitiveHeader(headers, 'Forwarded');
  checks.push(...forwardedHeaderValues(forwarded, 'for'));
  checks.push(...forwardedHeaderValues(forwarded, 'host'));
  return checks.every(isLoopbackHost);
}

export function isLocalBrowserRequest(connection: net.Socket, headers: http.IncomingHttpHeaders): boolean {
  if (!isLocalhost(connection)) return false;
  const host = caseInsensitiveHeader(headers, 'Host');
  if (!isLoopbackHost(host)) return false;
  return allForwardedValuesAreLoopback(headers);
}

export function bearerToken(headers: http.IncomingHttpHeaders): string | null {
  const auth = headers['authorization'] || headers['Authorization'];
  const authStr = Array.isArray(auth) ? auth[0] : auth;
  if (authStr && authStr.toLowerCase().startsWith('bearer ')) {
    return authStr.slice(7).trim() || null;
  }
  return null;
}

export function issueRouteSecretMatches(headers: http.IncomingHttpHeaders, configuredSecret: string): boolean {
  if (!configuredSecret) return true;
  const auth = headers['authorization'] || headers['Authorization'];
  const authStr = Array.isArray(auth) ? auth[0] : auth;
  if (authStr && authStr.toLowerCase().startsWith('bearer ')) {
    const supplied = authStr.slice(7).trim();
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(configuredSecret));
  }
  const headerToken = headers['x-nanobot-auth'] || headers['X-Nanobot-Auth'];
  const tokenStr = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (!tokenStr) return false;
  return crypto.timingSafeEqual(Buffer.from(tokenStr.trim()), Buffer.from(configuredSecret));
}
