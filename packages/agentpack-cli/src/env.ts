/**
 * packages/agentpack-cli/src/env.ts
 *
 * 环境加载/保存：读取 ~/.agentpack/.env 与 <cwd>/.env 并写入 process.env；
 * 写入用户级 .env（保留已有变量）。
 * 已存在的环境变量优先（shell 环境 > 文件）。
 */

import fs from 'fs';
import path from 'path';
import { getConfigDir } from './config';

function parseEnv(content: string): void {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    // 不覆盖已有的环境变量（shell 环境优先）
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

/** 加载 .env 文件（用户级 + 项目级），解析失败静默忽略 */
export function loadEnvFile(): void {
  const files = [
    path.join(getConfigDir(), '.env'),
    path.join(process.cwd(), '.env'),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    try {
      parseEnv(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
      // 解析失败不再完全静默：告警提示文件与原因，便于排障（key 缺失会导致认证失败）
      console.warn(`⚠️  加载 .env 失败（${file}）：${(err as Error).message}`);
    }
  }
}

/** 读取 .env 文件为键值对（忽略注释与无效行） */
function readEnvObject(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** 将变量合并写入用户级 .env（保留已有变量），返回文件路径 */
export function saveEnvFile(envVars: Record<string, string>): string {
  const envPath = path.join(getConfigDir(), '.env');
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  const merged = { ...readEnvObject(envPath), ...envVars };
  const lines = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf-8');
  return envPath;
}
