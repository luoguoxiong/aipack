/**
 * Phase 9 — PII 内置脱敏规则库。
 *
 * 默认启用：手机号 / 邮箱 / 身份证号 / 银行卡号 / IPv4 地址。
 * 脱敏策略：
 *  - mask：保留前后若干位，中间用 * 替换（默认策略）
 *  - hash：SHA-256 截断 16 hex（不可逆，只用于等值对比）
 *  - drop：完全删除该字段（极端敏感场景）
 *
 * 本文件仅提供「规则」与「脱敏函数」，不做字段级策略配置。
 * 字段级策略（项目级）由服务端 redact_rules 表管理，SDK 侧通过 API 拉取或默认启用内置。
 */

import { createHash } from 'node:crypto';

export type RedactAction = 'mask' | 'hash' | 'drop';

export interface RedactRule {
  /** 规则名，用于面板配置匹配 */
  name: string;
  /** 匹配正则（global，允许多次命中） */
  pattern: RegExp;
  /** 默认脱敏动作 */
  defaultAction: RedactAction;
  /** 掩码函数（仅 action=mask 时调用），默认保留前后 N 位 */
  maskFn?: (match: string) => string;
}

/** 中国大陆手机号：11 位，1 开头，第二位 3-9 */
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
/** 邮箱：简单且够用的正则（user@domain.tld） */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** 18 位身份证号（17 位数字 + 校验位 X/x/数字），不做校验位数学校验 */
const ID_CARD_RE = /(?<!\d)\d{17}[\dXx](?!\d)/g;
/** 16-19 位银行卡号（Luhn 校验此处略过，仅按形态） */
const BANK_CARD_RE = /(?<!\d)\d{16,19}(?!\d)/g;
/** IPv4 地址（宽松匹配；不做 0-255 范围校验） */
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

export const BUILTIN_RULES: RedactRule[] = [
  {
    name: 'phone',
    pattern: PHONE_RE,
    defaultAction: 'mask',
    maskFn: (m) => m.slice(0, 3) + '****' + m.slice(-4), // 139****1234
  },
  {
    name: 'email',
    pattern: EMAIL_RE,
    defaultAction: 'mask',
    maskFn: (m) => {
      const at = m.indexOf('@');
      if (at <= 1) return '*'.repeat(at) + m.slice(at);
      const user = m.slice(0, at);
      return user[0] + '*'.repeat(Math.max(at - 2, 1)) + user[at - 1] + m.slice(at);
    },
  },
  {
    name: 'idCard',
    pattern: ID_CARD_RE,
    defaultAction: 'mask',
    maskFn: (m) => m.slice(0, 6) + '********' + m.slice(-4), // 6 + 8* + 4 = 18
  },
  {
    name: 'bankCard',
    pattern: BANK_CARD_RE,
    defaultAction: 'mask',
    maskFn: (m) => m.slice(0, 4) + ' **** **** ' + m.slice(-4), // 6222 **** **** 1234
  },
  {
    name: 'ipv4',
    pattern: IPV4_RE,
    defaultAction: 'mask',
    maskFn: (m) => m.replace(/\.\d+\.\d+$/, '.*.*'), // 192.168.*.*
  },
];

/** 对单个字符串做所有内置规则的脱敏（默认 mask 动作） */
export function redactString(raw: string, actionOverrides?: Record<string, RedactAction>): string {
  if (!raw) return raw;
  let out = raw;
  for (const rule of BUILTIN_RULES) {
    const action = actionOverrides?.[rule.name] ?? rule.defaultAction;
    if (action === 'drop') {
      out = out.replace(rule.pattern, '');
    } else if (action === 'hash') {
      out = out.replace(rule.pattern, (m) => sha256Trunc(m));
    } else {
      // mask
      const fn = rule.maskFn ?? defaultMask;
      out = out.replace(rule.pattern, fn);
    }
    // reset regex lastIndex（global regex 会维护状态）
    rule.pattern.lastIndex = 0;
  }
  return out;
}

/** 对任意 JSON 值（对象/数组/字符串）做深度脱敏 */
export function redactValue<T = unknown>(value: T, actionOverrides?: Record<string, RedactAction>): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value, actionOverrides) as unknown as T;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, actionOverrides)) as unknown as T;
  }
  // plain object
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactValue(v, actionOverrides);
  }
  return out as unknown as T;
}

function defaultMask(m: string): string {
  if (m.length <= 2) return '*'.repeat(m.length);
  const keepHead = Math.max(1, Math.floor(m.length * 0.25));
  const keepTail = Math.max(1, Math.floor(m.length * 0.25));
  return m.slice(0, keepHead) + '*'.repeat(m.length - keepHead - keepTail) + m.slice(-keepTail);
}

function sha256Trunc(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}
