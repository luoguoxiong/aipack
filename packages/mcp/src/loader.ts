/**
 * loader.ts - .mcp.json 配置加载器（Node only）
 *
 * 兼容社区事实标准格式（Claude Code / Cursor）：
 *   { "mcpServers": { "name": { "command","args","env" } | { "type":"http","url","headers" } } }
 *
 * 加载顺序：项目级 `<cwd>/.mcp.json` 优先于用户级 `<userDir>/mcp.json`
 * （默认 userDir = ~/.aipack）。同名 server 项目级覆盖用户级。
 *
 * 归一化：stdio 条目（含 command）补 type:'stdio'；http/sse 条目取 type+url。
 * env 值中的 ${VAR} 不在此展开（保留原样，交由 registry 在连接时展开 + 校验缺失）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { McpServerConfig, McpDiagnostic, McpTransportConfig } from './types';

export interface LoadMcpConfigOptions {
  cwd?: string;
  /** 用户级配置目录（默认 ~/.aipack） */
  userDir?: string;
}

export interface LoadMcpConfigResult {
  servers: McpServerConfig[];
  diagnostics: McpDiagnostic[];
}

interface RawServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  type?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  toolPrefix?: string;
  toolFilter?: string[] | ((rawName: string) => boolean);
  timeoutMs?: number;
  permissions?: string[];
}

interface RawMcpConfig {
  mcpServers?: Record<string, RawServerEntry>;
}

/**
 * 加载并合并 .mcp.json（项目级优先于用户级）。
 * 单个文件不存在 / 解析失败仅记 warning，不阻断。
 */
export async function loadMcpConfig(options: LoadMcpConfigOptions = {}): Promise<LoadMcpConfigResult> {
  const cwd = options.cwd ?? process.cwd();
  const userDir = options.userDir ?? path.join(os.homedir(), '.aipack');

  const projectPath = path.join(cwd, '.mcp.json');
  const userPath = path.join(userDir, 'mcp.json');

  const [projectRaw, userRaw] = await Promise.all([
    readJsonSafe(projectPath),
    readJsonSafe(userPath),
  ]);

  const diagnostics: McpDiagnostic[] = [];
  // 合并：用户级先入，项目级覆盖同名
  const merged = new Map<string, RawServerEntry>();
  if (userRaw.value) for (const [k, v] of Object.entries(userRaw.value.mcpServers ?? {})) merged.set(k, v);
  if (projectRaw.value) for (const [k, v] of Object.entries(projectRaw.value.mcpServers ?? {})) merged.set(k, v);

  const servers: McpServerConfig[] = [];
  for (const [name, entry] of merged) {
    const norm = normalizeEntry(name, entry);
    if (norm.config) {
      servers.push(norm.config);
    } else if (norm.diagnostic) {
      diagnostics.push(norm.diagnostic);
    }
  }

  return { servers, diagnostics };
}

// ─── 内部 ─────────────────────────────────────────────────────

async function readJsonSafe(filePath: string): Promise<{ value?: RawMcpConfig }> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return { value: JSON.parse(raw) as RawMcpConfig };
  } catch {
    return {}; // 文件不存在或解析失败 → 调用方按未提供处理
  }
}

function normalizeEntry(
  name: string,
  entry: RawServerEntry,
): { config?: McpServerConfig; diagnostic?: McpDiagnostic } {
  if (!entry || typeof entry !== 'object') {
    return { diagnostic: { type: 'error', server: name, message: 'entry is not an object' } };
  }

  // 传输层归一化
  let transport: McpTransportConfig | undefined;
  if (entry.command) {
    transport = {
      type: 'stdio',
      command: entry.command,
      args: entry.args,
      env: entry.env,
      cwd: entry.cwd,
    };
  } else if (entry.type === 'http' && entry.url) {
    transport = { type: 'http', url: entry.url, headers: entry.headers };
  } else if (entry.type === 'sse' && entry.url) {
    transport = { type: 'sse', url: entry.url, headers: entry.headers };
  } else {
    return {
      diagnostic: {
        type: 'error',
        server: name,
        message: 'entry missing required fields (stdio: command; http/sse: type+url)',
      },
    };
  }

  const config: McpServerConfig = {
    name,
    transport,
    ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
    ...(entry.toolPrefix !== undefined ? { toolPrefix: entry.toolPrefix } : {}),
    ...(entry.toolFilter !== undefined ? { toolFilter: entry.toolFilter } : {}),
    ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
    ...(entry.permissions !== undefined ? { permissions: entry.permissions } : {}),
  };
  return { config };
}
