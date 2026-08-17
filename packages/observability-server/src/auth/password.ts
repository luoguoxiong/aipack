/**
 * 密码哈希 — scrypt（Node 内置 crypto.scrypt，零原生依赖）。
 *
 * 格式：`scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`
 * - N：CPU/内存成本参数（默认 2^15 = 32768）
 * - r：块大小（默认 8）
 * - p：并行度（默认 1）
 * - salt：16 字节随机盐
 * - hash：32 字节哈希
 *
 * 验证：恒时比较，防时序侧信道。
 *
 * 选择 scrypt 而非 argon2id：Node 内置、零原生依赖、跨平台无编译。
 * 安全性足够（OWASP 推荐）；未来可通过接口切换到 argon2id。
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

const DEFAULT_N = 1 << 15; // 32768
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const ALGO = 'scrypt';

/** 异步 scrypt 包装为 Promise */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  N: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, { N, r, p, maxmem: 128 * 1024 * 1024 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * 哈希密码，返回格式化字符串。
 * 结果形如：`scrypt$32768$8$1$a1b2c3...$d4e5f6...`
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = await scryptAsync(password, salt, KEY_LEN, DEFAULT_N, DEFAULT_R, DEFAULT_P);
  return `${ALGO}$${DEFAULT_N}$${DEFAULT_R}$${DEFAULT_P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * 验证密码是否匹配哈希。
 * 恒时比较；格式不合法返回 false（不抛错，避免信息泄露）。
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== ALGO) return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'hex');
  const expectedHash = Buffer.from(parts[5], 'hex');
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  if (salt.length !== SALT_LEN || expectedHash.length !== KEY_LEN) return false;
  const actualHash = await scryptAsync(password, salt, KEY_LEN, N, r, p);
  if (actualHash.length !== expectedHash.length) return false;
  return timingSafeEqual(actualHash, expectedHash);
}

/** 是否 scrypt 哈希格式（用于迁移检测：旧库可能是其他格式） */
export function isScryptHash(encoded: string): boolean {
  return encoded.startsWith(`${ALGO}$`);
}
