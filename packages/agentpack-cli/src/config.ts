/**
 * packages/agentpack-cli/src/config.ts
 *
 * 配置加载与合并，优先级（低 → 高）：
 *   默认值 < 配置文件（项目级 agentpack.config.json < 全局 ~/.agentpack/config.json）
 *          < 环境变量（AGENTPACK_*）< CLI 参数（--config/--provider/--model 等）
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── 类型 ──────────────────────────────────────────────────────────

export interface SessionsConfig {
  enabled: boolean;
  baseDir: string; // 已解析的绝对路径
  maxAge?: number;
}

export interface AgentpackConfig {
  provider: string;
  model: string;
  systemPrompt: string;
  workspace: string; // 已解析的绝对路径
  sessionKey: string;
  sessions: SessionsConfig;
  /** 实际生效的配置文件路径（未使用配置文件时为 undefined） */
  configPath?: string;
}

/** CLI 参数中与配置相关的选项 */
export interface CliOptions {
  config?: string;
  provider?: string;
  model?: string;
  systemPrompt?: string;
  workspace?: string;
  sessionKey?: string;
  noPersist?: boolean;
}

/** 配置文件（agentpack.config.json / config.json）的原始结构 */
interface RawFileConfig {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  workspace?: string;
  sessionKey?: string;
  sessions?: {
    enabled?: boolean;
    baseDir?: string;
    maxAge?: number;
  };
}

// ─── 默认值 ────────────────────────────────────────────────────────

const DEFAULTS: RawFileConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  systemPrompt: '你是一个简洁的 AI 助手。',
};

// ─── 路径工具 ──────────────────────────────────────────────────────

/** 全局配置目录：环境变量 AGENTPACK_CONFIG_DIR 优先，默认 ~/.agentpack */
export function getConfigDir(): string {
  return process.env.AGENTPACK_CONFIG_DIR || path.join(os.homedir(), '.agentpack');
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

/** 解析 ~ 开头的路径为绝对路径，否则返回 path.resolve 的结果 */
export function resolveHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

// ─── 加载与合并 ────────────────────────────────────────────────────

function readJsonFile(file: string): RawFileConfig | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as RawFileConfig;
  } catch {
    return null; // 配置损坏视为不存在，交给默认值兜底
  }
}

function pickDefined<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out as Partial<T>;
}

export function loadConfig(cli: CliOptions = {}): AgentpackConfig {
  const configDir = getConfigDir();
  const globalFile = path.join(configDir, 'config.json');
  const projectFile = path.join(process.cwd(), 'agentpack.config.json');

  // 文件链：显式 --config 单独生效；否则项目级覆盖全局
  const fileChain = cli.config
    ? [path.resolve(cli.config)]
    : [projectFile, globalFile];

  const fileConfig: RawFileConfig = {};
  let effectiveConfigPath: string | undefined;
  for (const file of fileChain) {
    const raw = readJsonFile(file);
    if (raw) {
      Object.assign(fileConfig, raw);
      effectiveConfigPath = file;
    }
  }

  // 环境变量
  const envConfig = pickDefined({
    provider: process.env.AGENTPACK_PROVIDER,
    model: process.env.AGENTPACK_MODEL,
    systemPrompt: process.env.AGENTPACK_SYSTEM_PROMPT,
    workspace: process.env.AGENTPACK_WORKSPACE,
    sessionKey: process.env.AGENTPACK_SESSION_KEY,
  } satisfies Partial<RawFileConfig>);

  // CLI 参数
  const cliConfig = pickDefined({
    provider: cli.provider,
    model: cli.model,
    systemPrompt: cli.systemPrompt,
    workspace: cli.workspace,
    sessionKey: cli.sessionKey,
  } satisfies Partial<RawFileConfig>);

  const merged: RawFileConfig = {
    ...DEFAULTS,
    ...fileConfig,
    ...envConfig,
    ...cliConfig,
  };

  let enabled = merged.sessions?.enabled ?? true;
  if (cli.noPersist) enabled = false;

  return {
    provider: merged.provider!,
    model: merged.model!,
    systemPrompt: merged.systemPrompt ?? '',
    workspace: resolveHome(merged.workspace || configDir),
    sessionKey: merged.sessionKey ?? 'default',
    sessions: {
      enabled,
      baseDir: resolveHome(merged.sessions?.baseDir || path.join(configDir, 'sessions')),
      maxAge: merged.sessions?.maxAge,
    },
    configPath: effectiveConfigPath,
  };
}
