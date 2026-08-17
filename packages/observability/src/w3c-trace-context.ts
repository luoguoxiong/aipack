/**
 * Phase 9 — W3C Trace Context 支持。
 *
 * 标准：https://www.w3.org/TR/trace-context/
 *
 * traceparent 格式：
 *   version-traceid-parentid-traceflags
 *   例：00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
 *
 *   - version:       2 hex (00)
 *   - trace-id:      32 hex（16 bytes，必须非全 0）
 *   - parent-id:     16 hex（8 bytes，必须非全 0）
 *   - trace-flags:   2 hex（bit 0 = sampled，其余保留为 0）
 */

export interface W3cTraceContext {
  /** 标准 W3C trace-id（32 hex 小写） */
  traceId: string;
  /** 标准 W3C parent-id / span-id（16 hex 小写） */
  parentId: string;
  /** 采样标记（trace-flags 最低位） */
  sampled: boolean;
  /** 原始 traceparent 字符串（用于回传） */
  raw: string;
}

export type ParseResult =
  | { ok: true; ctx: W3cTraceContext }
  | { ok: false; reason: string };

/** 解析 traceparent 头。版本 ff 或格式不合法时返回 { ok:false }，不抛错。 */
export function parseTraceparent(raw: string | null | undefined): ParseResult {
  if (!raw) return { ok: false, reason: 'missing' };
  // 允许前后空白 + 大小写不敏感
  const s = raw.trim().toLowerCase();
  const parts = s.split('-');
  if (parts.length !== 4) return { ok: false, reason: 'format: parts != 4' };
  const [versionHex, traceIdHex, parentIdHex, flagsHex] = parts;
  if (!/^[0-9a-f]{2}$/.test(versionHex)) return { ok: false, reason: 'invalid version' };
  if (versionHex === 'ff') return { ok: false, reason: 'version ff is invalid' };
  if (!/^[0-9a-f]{32}$/.test(traceIdHex)) return { ok: false, reason: 'invalid trace-id' };
  if (/^0{32}$/.test(traceIdHex)) return { ok: false, reason: 'trace-id all zeros' };
  if (!/^[0-9a-f]{16}$/.test(parentIdHex)) return { ok: false, reason: 'invalid parent-id' };
  if (/^0{16}$/.test(parentIdHex)) return { ok: false, reason: 'parent-id all zeros' };
  if (!/^[0-9a-f]{2}$/.test(flagsHex)) return { ok: false, reason: 'invalid trace-flags' };
  const flags = parseInt(flagsHex, 16);
  return {
    ok: true,
    ctx: {
      traceId: traceIdHex,
      parentId: parentIdHex,
      sampled: (flags & 0x01) === 0x01,
      raw: s,
    },
  };
}

/** 组装 traceparent 头字符串 */
export function formatTraceparent(ctx: { traceId: string; parentId: string; sampled: boolean }): string {
  const flags = ctx.sampled ? '01' : '00';
  return `00-${ctx.traceId}-${ctx.parentId}-${flags}`;
}

/**
 * 把外部 W3C trace-id 映射到 aipack traceId（双向绑定）。
 *
 * 策略：
 * - 外部 w3cTraceId 与 aipack traceId 不同（aipack traceId 为随机字符串）。
 *   在 RunRecord 上同时记 w3cTraceId（外部传入）与 aipack 自身 traceId，
 *   面板通过 w3cTraceId 建立跨系统跳转。
 */

/** 生成一个新的 W3C trace-id（32 hex，非全 0） */
export function generateW3cTraceId(): string {
  const bytes = cryptoRandomBytes(16);
  if (bytes.every((b) => b === 0)) bytes[0] = 1; // 避免全 0
  return toHex(bytes);
}

/** 生成一个新的 W3C parent-id / span-id（16 hex，非全 0） */
export function generateW3cParentId(): string {
  const bytes = cryptoRandomBytes(8);
  if (bytes.every((b) => b === 0)) bytes[0] = 1;
  return toHex(bytes);
}

// ─── 工具 ────────────────────────────────────────────────────────

/** 最小化 crypto 接口（避免引用 dom lib 的 Crypto 类型） */
interface WebCryptoLike {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

function cryptoRandomBytes(n: number): Uint8Array {
  // Node 18+ 全局有 crypto；回退到 Math.random 保证兼容测试/浏览器
  const cryptoObj = (globalThis as unknown as { crypto?: WebCryptoLike }).crypto;
  if (typeof globalThis !== 'undefined' && cryptoObj?.getRandomValues) {
    const buf = new Uint8Array(n);
    cryptoObj.getRandomValues(buf);
    return buf;
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
