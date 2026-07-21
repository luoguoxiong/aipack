import net from 'net';
import dns from 'dns';
import { URL } from 'url';
import { logger } from '../utils/logger.js';

const _BLOCKED_NETWORKS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
];

const _URL_RE = /https?:\/\/[^\s"'`;|<>]+/gi;
let _allowedNetworks: string[] = [];

function _isIPPrivate(ip: string): boolean {
  for (const cidr of _allowedNetworks) {
    if (_ipInNetwork(ip, cidr)) {
      return false;
    }
  }
  for (const cidr of _BLOCKED_NETWORKS) {
    if (_ipInNetwork(ip, cidr)) {
      return true;
    }
  }
  return false;
}

function _ipInNetwork(ipStr: string, cidr: string): boolean {
  try {
    const [networkStr, prefixStr] = cidr.split('/');
    const prefix = parseInt(prefixStr, 10);

    const ipIsV6 = ipStr.includes(':');
    const netIsV6 = networkStr.includes(':');

    if (ipIsV6 !== netIsV6) {
      if (ipIsV6 && _isIPv4MappedIPv6(ipStr)) {
        const ipv4 = _ipv4MappedToIPv4(ipStr);
        return _ipInNetwork(ipv4, cidr);
      }
      return false;
    }

    if (!ipIsV6) {
      const ipInt = _ipv4ToInt(ipStr);
      const netInt = _ipv4ToInt(networkStr);
      const mask = ~((1 << (32 - prefix)) - 1) >>> 0;
      return (ipInt & mask) === (netInt & mask);
    }

    return false;
  } catch {
    return false;
  }
}

function _isIPv4MappedIPv6(ip: string): boolean {
  return ip.startsWith('::ffff:') && !isNaN(parseInt(ip.slice(7).split('.')[0], 10));
}

function _ipv4MappedToIPv4(ip: string): string {
  return ip.slice(7);
}

function _ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function _isLoopbackAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    return ip.startsWith('127.');
  }
  if (net.isIPv6(ip)) {
    return ip === '::1' || ip === '::ffff:127.0.0.1' || _isIPv4MappedIPv6(ip) && ip.slice(7).startsWith('127.');
  }
  return false;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().replace(/\.+$/, '').toLowerCase();
  if (normalized === 'localhost') {
    return true;
  }
  let addr = normalized;
  if (addr.startsWith('[') && addr.endsWith(']')) {
    addr = addr.slice(1, -1);
  }
  return _isLoopbackAddress(addr);
}

export function configureSsrfWhitelist(cidrs: string[]): void {
  _allowedNetworks = cidrs.filter(cidr => {
    try {
      const [, prefixStr] = cidr.split('/');
      const prefix = parseInt(prefixStr, 10);
      return !isNaN(prefix) && prefix >= 0 && prefix <= 128;
    } catch {
      return false;
    }
  });
}

function _normalizeAddr(addr: string): string {
  if (_isIPv4MappedIPv6(addr)) {
    return _ipv4MappedToIPv4(addr);
  }
  return addr;
}

function _isPrivate(addr: string): boolean {
  const normalized = _normalizeAddr(addr);
  if (_allowedNetworks.length > 0 && _allowedNetworks.some(net => _ipInNetwork(normalized, net))) {
    return false;
  }
  return _isIPPrivate(normalized);
}

export async function resolveUrlTarget(
  url: string,
  opts: { allow_loopback?: boolean } = {},
): Promise<{ ok: boolean; error: string; resolved_ips: string[] }> {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: `Only http/https allowed, got '${parsed.protocol || 'none'}'`, resolved_ips: [] };
    }
    if (!parsed.hostname) {
      return { ok: false, error: 'Missing domain', resolved_ips: [] };
    }

    const hostname = parsed.hostname;
    let addresses: string[];

    try {
      const result = await dns.promises.lookup(hostname, { all: true });
      addresses = result.map(r => r.address);
    } catch {
      return { ok: false, error: `Cannot resolve hostname: ${hostname}`, resolved_ips: [] };
    }

    const uniqueAddrs = [...new Set(addresses.map(_normalizeAddr))];

    if (opts.allow_loopback && _isAllowedLoopbackTarget(hostname, uniqueAddrs)) {
      return { ok: true, error: '', resolved_ips: uniqueAddrs };
    }

    for (const addr of uniqueAddrs) {
      if (_isPrivate(addr)) {
        return {
          ok: false,
          error: `Blocked: ${hostname} resolves to private/internal address ${addr}`,
          resolved_ips: [],
        };
      }
    }

    return { ok: true, error: '', resolved_ips: uniqueAddrs };
  } catch (err) {
    return { ok: false, error: String(err), resolved_ips: [] };
  }
}

export async function validateUrlTarget(
  url: string,
  opts: { allow_loopback?: boolean } = {},
): Promise<{ ok: boolean; error: string }> {
  const result = await resolveUrlTarget(url, opts);
  return { ok: result.ok, error: result.error };
}

export function containsInternalUrl(
  command: string,
  opts: { allow_loopback?: boolean } = {},
): boolean {
  const matches = command.match(_URL_RE);
  if (!matches) {
    return false;
  }
  for (const url of matches) {
    if (_urlIsInternalSync(url, opts)) {
      return true;
    }
  }
  return false;
}

function _urlIsInternalSync(url: string, opts: { allow_loopback?: boolean } = {}): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    if (!hostname) {
      return false;
    }
    if (net.isIP(hostname)) {
      if (opts.allow_loopback && _isLoopbackAddress(hostname)) {
        return false;
      }
      return _isPrivate(hostname);
    }
    return false;
  } catch {
    return false;
  }
}

function _isAllowedLoopbackTarget(hostname: string, addrs: string[]): boolean {
  if (addrs.length === 0 || !addrs.every(addr => _isLoopbackAddress(_normalizeAddr(addr)))) {
    return false;
  }
  const normalized = hostname.replace(/\.+$/, '').toLowerCase();
  if (normalized === 'localhost') {
    return true;
  }
  if (net.isIP(normalized)) {
    return _isLoopbackAddress(normalized);
  }
  return false;
}

export class UnsafeURLRequestError extends Error {
  request?: unknown;

  constructor(message: string, request?: unknown) {
    super(message);
    this.name = 'UnsafeURLRequestError';
    this.request = request;
  }
}
