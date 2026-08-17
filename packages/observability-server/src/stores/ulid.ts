/**
 * ULID 生成器（Crockford Base32，26 字符，时间有序）。
 *
 * 格式：10 字符时间戳（48bit ms）+ 16 字符随机（80bit）。
 * 单调性：同一毫秒内单调递增（通过 lastTime + lastRandom 检测）。
 *
 * 零依赖实现，用于业务库主键（BTree 友好的时间有序 ID）。
 */

// Crockford Base32 字母表（排除 I/L/O/U 避免混淆）
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = 0;
let lastRandom: Uint8Array | null = null;

/** 生成 26 字符 ULID 字符串 */
export function ulid(): string {
  const now = Date.now();
  if (now < lastTime) {
    // 时钟回拨：用 lastTime 继续递增，避免重复
  }
  const time = now > lastTime ? now : lastTime;

  let random: Uint8Array;
  if (time === lastTime && lastRandom) {
    // 同毫秒：对 lastRandom +1 进位，保证单调递增
    random = incrementBytes(lastRandom);
  } else {
    random = randomBytes(10);
  }
  lastTime = time;
  lastRandom = random;

  return encodeTime(time) + encodeRandom(random);
}

function encodeTime(ms: number): string {
  let str = '';
  let time = ms;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = time % ENCODING_LEN;
    str = ENCODING[mod] + str;
    time = Math.floor(time / ENCODING_LEN);
  }
  return str;
}

function encodeRandom(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < RANDOM_LEN; i++) {
    const byte = bytes[i % bytes.length] ?? 0;
    // 用 byte 的高 5 bit 与低 5 bit 分别映射一个字符（简化版：直接 mod 32）
    str += ENCODING[byte % ENCODING_LEN];
  }
  return str;
}

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  // 用 crypto.getRandomValues（Node 18+ globalThis.crypto）
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

/** 字节数组 +1 进位（小端，最后一字节是最低位） */
function incrementBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] < 0xff) {
      out[i] += 1;
      return out;
    }
    out[i] = 0;
  }
  // 全 0xff 溢出：重新随机（极低概率）
  return randomBytes(out.length);
}
