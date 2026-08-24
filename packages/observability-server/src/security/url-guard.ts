/**
 * 出站 URL 安全守卫（S3 / SSRF 防护）。
 *
 * 用于告警 webhook 等用户可控 URL：
 *  - checkWebhookUrlSyntax：同步快速校验（URL 语法 + 协议白名单 + IP 字面量黑名单），
 *    供规则入库的同步校验路径（alerts/rules.ts validateRule）使用；
 *  - assertPublicHttpUrl：完整异步校验，额外做 DNS 解析并拒绝解析到内网/保留地址的
 *    目标（含云元数据 169.254.169.254）。供入库 handler（admin.ts）与发送前复核
 *    （alerts/notify.ts，防 DNS rebinding 与历史脏数据）使用。
 *
 * 残余风险说明：assertPublicHttpUrl 校验通过后再 fetch，DNS 可能被再次解析
 * （TOCTOU / rebinding 窗口）。如需彻底封死，可在此基础上叠加域名 allowlist
 * （仅允许运营配置的 webhook 域名），见 ALERTS_WEBHOOK_ALLOWLIST 规划项。
 */
import { lookup } from 'node:dns/promises';
import net from 'node:net';

export type UrlGuardResult =
  | { ok: true; url: URL }
  | { ok: false; error: string };

/** IPv4 保留/内网段（CIDR → [network, prefixBits]） */
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "本网络" / 0.0.0.0 即本机
  ['10.0.0.0', 8], // 私网 A
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // 环回
  ['169.254.0.0', 16], // 链路本地（含云元数据 169.254.169.254）
  ['172.16.0.0', 12], // 私网 B
  ['192.0.0.0', 24], // IETF 协议分配
  ['192.168.0.0', 16], // 私网 C
  ['198.18.0.0', 15], // 基准测试
];

function ipv4ToLong(ip: string): number {
  const parts = ip.split('.');
  // net.isIPv4 已保证 4 段数字
  return (
    ((Number(parts[0]) << 24) |
      (Number(parts[1]) << 16) |
      (Number(parts[2]) << 8) |
      Number(parts[3])) >>>
    0
  );
}

function isBlockedIpv4(ip: string): boolean {
  const val = ipv4ToLong(ip);
  for (const [netAddr, bits] of BLOCKED_V4) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((val & mask) === (ipv4ToLong(netAddr) & mask)) return true;
  }
  return false;
}

/** IPv6 → 16 字节展开（处理 :: 压缩与 ::ffff:x.x.x.x IPv4 映射）；非法返回 null */
function expandIpv6(addr: string): Uint8Array | null {
  let head: string[] = [];
  let tail: string[] = [];
  if (addr.includes('::')) {
    const idx = addr.indexOf('::');
    head = addr.slice(0, idx).split(':').filter(Boolean);
    tail = addr.slice(idx + 2).split(':').filter(Boolean);
    if (addr.indexOf('::', idx + 1) !== -1) return null; // 只允许一个 ::
  } else {
    head = addr.split(':');
  }
  const bytes = new Uint8Array(16);
  const putGroup = (groups: string[], offset: number): boolean => {
    for (let i = 0; i < groups.length; i++) {
      // 尾部可能是嵌入式 IPv4（::ffff:192.168.0.1）
      if (groups[i].includes('.')) {
        const v4 = groups[i];
        if (!net.isIPv4(v4)) return false;
        if (offset + i * 2 + 4 > 16) return false;
        const parts = v4.split('.').map(Number);
        bytes[offset + i * 2] = parts[0];
        bytes[offset + i * 2 + 1] = parts[1];
        bytes[offset + i * 2 + 2] = parts[2];
        bytes[offset + i * 2 + 3] = parts[3];
        return i === groups.length - 1; // IPv4 部分必须是最后一段
      }
      const g = Number(`0x${groups[i]}`);
      if (!Number.isFinite(g) || g < 0 || g > 0xffff) return false;
      if (offset + i * 2 + 1 >= 16) return false;
      bytes[offset + i * 2] = g >> 8;
      bytes[offset + i * 2 + 1] = g & 0xff;
    }
    return true;
  };
  if (!putGroup(head, 0)) return null;
  if (tail.length > 0 && !putGroup(tail, 16 - tail.length * 2)) return null;
  if (!addr.includes('::') && head.length !== 8) return null;
  return bytes;
}

function isBlockedIpv6(addr: string): boolean {
  const b = expandIpv6(addr);
  if (!b) return true; // 解析失败按阻断处理（安全默认）
  // ::/128（未指定）与 ::1（环回）
  const allZero = b.every((x) => x === 0);
  if (allZero) return true;
  if (b[15] === 1 && b.slice(0, 15).every((x) => x === 0)) return true;
  // ::ffff:0:0/96：IPv4 映射地址 → 按 IPv4 规则判断
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
    return isBlockedIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }
  // fc00::/7 唯一本地（ULA）
  if ((b[0] & 0xfe) === 0xfc) return true;
  // fe80::/10 链路本地
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;
  // ff00::/8 组播
  if (b[0] === 0xff) return true;
  return false;
}

/** 判断 IP 是否为内网/环回/链路本地/保留地址（IPv4 与 IPv6） */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedIpv4(ip);
  if (net.isIPv6(ip)) return isBlockedIpv6(ip);
  return true; // 非法 IP 字面量按阻断处理
}

/**
 * 显式豁免开关：ALERTS_WEBHOOK_ALLOW_PRIVATE=1 时放行内网/环回 webhook 目标。
 * 适用本地自托管接收端与测试场景；协议白名单（http/https）仍然生效。生产默认拦截。
 */
export function privateWebhooksAllowed(): boolean {
  return /^(1|true|yes)$/i.test(process.env.ALERTS_WEBHOOK_ALLOW_PRIVATE ?? '');
}

/** 解析 URL 字符串并做协议白名单校验；失败返回错误原因 */
function parseHttpUrl(raw: string): UrlGuardResult {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: '不是合法的 URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: '仅支持 http/https 协议' };
  }
  return { ok: true, url: u };
}

/**
 * 同步语法校验（无 DNS）：URL 合法 + http/https + IP 字面量非内网。
 * 域名目标需要 assertPublicHttpUrl 的异步 DNS 校验兜底。
 */
export function checkWebhookUrlSyntax(raw: string): UrlGuardResult {
  const parsed = parseHttpUrl(raw);
  if (!parsed.ok) return parsed;
  if (privateWebhooksAllowed()) return parsed; // 显式豁免：跳过内网判定
  const host = parsed.url.hostname.replace(/^\[|\]$/g, '');
  if ((net.isIPv4(host) || net.isIPv6(host)) && isBlockedIp(host)) {
    return { ok: false, error: 'webhook 地址不能指向内网/环回/链路本地地址' };
  }
  return parsed;
}

/**
 * 完整校验（含 DNS）：解析目标域名的全部 A/AAAA 记录，任一命中内网/保留地址即拒绝。
 * DNS 解析失败也拒绝（安全默认）。
 */
export async function assertPublicHttpUrl(raw: string): Promise<UrlGuardResult> {
  const parsed = parseHttpUrl(raw);
  if (!parsed.ok) return parsed;
  if (privateWebhooksAllowed()) return parsed; // 显式豁免：跳过内网判定
  const host = parsed.url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIPv4(host) || net.isIPv6(host)) {
    if (isBlockedIp(host)) {
      return { ok: false, error: 'webhook 地址不能指向内网/环回/链路本地地址' };
    }
    return parsed;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    return { ok: false, error: `域名解析失败: ${host}` };
  }
  if (addrs.length === 0) {
    return { ok: false, error: `域名未解析到任何地址: ${host}` };
  }
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      return {
        ok: false,
        error: `域名 ${host} 解析到内网/保留地址 ${a.address}，已拒绝`,
      };
    }
  }
  return parsed;
}
