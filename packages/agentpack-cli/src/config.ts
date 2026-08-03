/**
 * packages/agentpack-cli/src/config.ts
 *
 * 配置加载与合并，优先级（低 → 高）：
 *   默认值 < 配置文件（项目级 agentpack.config.js/.json < 全局 ~/.agentpack/config.json）
 *          < 环境变量（AGENTPACK_*）< CLI 参数（--config/--provider/--model 等）
 *
 * 项目级配置文件支持 .js（ESM export default 或 CJS module.exports，可写逻辑）与 .json，
 * .js 优先级高于 .json；全局配置保持 config.json。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomBytes } from 'crypto';
import { pathToFileURL } from 'url';
import type { RuntimeOptions } from 'agentpack';

/**
 * agentpack Runtime 透传选项（写入配置文件的字段）。
 * 除已有 provider/model/systemPrompt/workspace 外，其余 agentpack Runtime 支持的能力
 * 均可在此配置（需 .js 配置文件以便 import 模块/类实例）。
 */
export interface AgentpackRuntimeConfig {
  /** 透传给 Runtime 的配置对象 */
  config?: RuntimeOptions['config'];
  /** 自定义工具列表 */
  tools?: RuntimeOptions['tools'];
  /** 扩展插件列表（如 LoggingExtension） */
  extensions?: RuntimeOptions['extensions'];
  /** 上下文转换器列表 */
  transformers?: RuntimeOptions['transformers'];
  /** 转换流水线 */
  pipeline?: RuntimeOptions['pipeline'];
  /** 会话存储适配器（配置后优先于 sessions.baseDir） */
  sessionStorage?: RuntimeOptions['sessionStorage'];
}

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
  sessionKey: string; // 每次启动自动生成的会话 key
  sessions: SessionsConfig;
  /** 配置文件透传的 agentpack Runtime 选项（tools/extensions 等，可能为 undefined） */
  runtime?: Partial<RuntimeOptions>;
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
  noPersist?: boolean;
}

/**
 * agentpack 配置文件允许的字段（agentpack.config.js / agentpack.config.json / config.json）。
 * 字段均为可选；未配置时使用默认值，优先级：默认值 < 配置文件 < 环境变量 < CLI 参数。
 * 在 agentpack.config.js 顶部加一行类型注解即可获得 IDE 代码提示：
 *   `@type {import('agentpack-cli').AgentpackConfigFile}`
 */
export interface RawFileConfig extends AgentpackRuntimeConfig {
  /** 模型提供商 ID（如 deepseek / openai / anthropic），运行 "agentpack models" 查看全部 */
  provider?: string;
  /** 模型 ID（如 deepseek-chat / gpt-4o-mini），缺省按提供商取推荐模型 */
  model?: string;
  /** 系统提示词（定义 AI 助手的角色与行为） */
  systemPrompt?: string;
  /** 工作区路径（支持 ~ 开头，缺省为当前工作目录） */
  workspace?: string;
  /** 会话持久化配置 */
  sessions?: {
    /** 是否启用会话持久化（默认 true） */
    enabled?: boolean;
    /** 会话存储目录（支持 ~ 开头，缺省为 <cwd>/.agentpack/sessions） */
    baseDir?: string;
    /** 会话最长保留天数（可选） */
    maxAge?: number;
  };
}

/** 配置文件类型别名，供 agentpack.config.js 代码提示使用 */
export type AgentpackConfigFile = RawFileConfig;

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

/**
 * 生成新的会话 key：agentpack-<8 位随机 hex>。
 * 每次启动 CLI 调用一次，保证每次启动都是全新会话。
 */
export function generateSessionKey(): string {
  return `agentpack-${randomBytes(4).toString('hex')}`;
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

/** 动态加载 JS 配置文件（兼容 ESM export default 与 CJS module.exports） */
async function readJsConfigFile(file: string): Promise<RawFileConfig | null> {
  if (!fs.existsSync(file)) return null;
  try {
    const mod = await import(pathToFileURL(file).href);
    const raw = mod.default ?? mod;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as RawFileConfig;
    }
    return null;
  } catch (err) {
    // 加载失败时降级（打印警告，回退到全局配置/默认值）
    console.warn(`⚠️  配置文件加载失败，已忽略: ${file}`);
    console.warn(`   ${(err as Error).message}`);
    return null;
  }
}

/** 按扩展名分发：.js/.mjs/.cjs 动态加载，其余按 JSON 解析 */
function readConfigFile(file: string): Promise<RawFileConfig | null> {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return readJsConfigFile(file);
  }
  return Promise.resolve(readJsonFile(file));
}

function pickDefined<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out as Partial<T>;
}

export async function loadConfig(cli: CliOptions = {}): Promise<AgentpackConfig> {
  const configDir = getConfigDir();
  const projectJs = path.join(process.cwd(), 'agentpack.config.js');
  const projectJson = path.join(process.cwd(), 'agentpack.config.json');
  const globalFile = path.join(configDir, 'config.json');

  // 文件链：显式 --config 单独生效；否则项目级 .js（优先）> 项目级 .json > 全局
  const fileChain = cli.config
    ? [path.resolve(cli.config)]
    : [projectJs, projectJson, globalFile];

  const fileConfig: RawFileConfig = {};
  let effectiveConfigPath: string | undefined;
  for (const file of fileChain) {
    const raw = await readConfigFile(file);
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
  } satisfies Partial<RawFileConfig>);

  // CLI 参数
  const cliConfig = pickDefined({
    provider: cli.provider,
    model: cli.model,
    systemPrompt: cli.systemPrompt,
    workspace: cli.workspace,
  } satisfies Partial<RawFileConfig>);

  const merged: RawFileConfig = {
    ...DEFAULTS,
    ...fileConfig,
    ...envConfig,
    ...cliConfig,
  };

  let enabled = merged.sessions?.enabled ?? true;
  if (cli.noPersist) enabled = false;

  // 收集透传给 agentpack Runtime 的选项（仅取配置文件中显式提供的字段）
  const runtimeFields: Array<keyof AgentpackRuntimeConfig> = [
    'config',
    'tools',
    'extensions',
    'transformers',
    'pipeline',
    'sessionStorage',
  ];
  const runtime: Partial<RuntimeOptions> = {};
  for (const field of runtimeFields) {
    if (fileConfig[field] !== undefined) {
      runtime[field] = fileConfig[field] as never;
    }
  }

  return {
    provider: merged.provider!,
    model: merged.model!,
    systemPrompt: merged.systemPrompt ?? '',
    workspace: resolveHome(merged.workspace || process.cwd()),
    sessionKey: generateSessionKey(),
    sessions: {
      enabled,
      baseDir: resolveHome(
        merged.sessions?.baseDir || path.join(process.cwd(), '.agentpack', 'sessions'),
      ),
      // 配置语义为“天”，核心存储按毫秒比较（Date.now() - updatedAt），此处转换
      maxAge:
        merged.sessions?.maxAge !== undefined
          ? merged.sessions.maxAge * 24 * 60 * 60 * 1000
          : undefined,
    },
    runtime: Object.keys(runtime).length > 0 ? runtime : undefined,
    configPath: effectiveConfigPath,
  };
}
