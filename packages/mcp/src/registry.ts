/**
 * registry.ts - 多 MCP Server 生命周期管理（Node only）
 *
 * 职责：
 *  - 并行连接所有 enabled server（单个失败不阻断整体）
 *  - 工具命名空间 / 冲突预检（不依赖 registerTool 静默覆盖）
 *  - 把包装工具注册进 Runtime（通过 ExtensionContext.runtime）
 *  - callTool 分发到对应 server 的 McpClient（含惰性重连）
 *  - refresh 增量更新（M1 无法 unregister，残留工具调用失败自愈）
 *  - dispose 关闭所有连接
 */

import type { Runtime } from '@aipack-ai/agent';
import { McpClient, createTransportFromConfig } from './client/mcp-client';
import type { McpClientLike, CallToolOptions } from './client/mcp-client';
import { wrapMcpTool, buildToolName } from './adapter';
import type { McpToolInfo, McpToolCallResult } from './client/protocol';
import type {
  McpServerConfig,
  McpDiagnostic,
  McpPluginOptions,
  McpServerStatus,
  McpClientInfo,
} from './types';

interface ServerState {
  config: McpServerConfig;
  client: McpClientLike;
  tools: McpToolInfo[];
  /** 本 server 已注册进 runtime 的工具全名集合（供 refresh/reconnect 完整移除） */
  registeredNames: Set<string>;
  error?: string;
}

/** 客户端工厂：生产 = 默认（spawn 子进程）；测试可注入内存替身 */
export type McpClientFactory = (
  cfg: McpServerConfig,
  resolvedEnv?: Record<string, string>,
) => McpClientLike;

// ─── 环境变量展开 ─────────────────────────────────────────────

const ENV_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

interface EnvResolveResult {
  ok: boolean;
  value?: Record<string, string>;
  missing?: string[];
}

function resolveEnvValue(input: string, missing: Set<string>): string {
  return input.replace(ENV_PATTERN, (_m, name: string) => {
    const v = process.env[name];
    if (v === undefined) missing.add(name);
    return v ?? '';
  });
}

/** 展开 ${VAR}；任一变量未定义则 ok=false（不静默传空串，避免下游认证失败难排查） */
function resolveEnv(env?: Record<string, string>): EnvResolveResult {
  if (!env) return { ok: true, value: undefined };
  const missing = new Set<string>();
  const value: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    value[k] = resolveEnvValue(v, missing);
  }
  if (missing.size > 0) return { ok: false, missing: [...missing] };
  return { ok: true, value };
}

// ─── McpRegistry ──────────────────────────────────────────────

export class McpRegistry {
  private configs: McpServerConfig[];
  private clientInfo: McpClientInfo;
  private requestTimeoutMs?: number;
  private clientFactory: McpClientFactory;
  private states = new Map<string, ServerState>();
  private diagnostics: McpDiagnostic[] = [];
  private connected = false;
  private connecting: Promise<McpDiagnostic[]> | null = null;
  private runtime?: Runtime;
  private registered = new Set<string>(); // 已注册工具全名（冲突预检 + 幂等）

  constructor(options: McpPluginOptions = {}, clientFactory?: McpClientFactory) {
    this.configs = options.servers ?? [];
    this.clientInfo = options.clientInfo ?? { name: 'aipack-mcp', version: '0.1.0' };
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.clientFactory = clientFactory ?? ((cfg, env) => this.defaultClientFactory(cfg, env));
  }

  /** 默认客户端工厂：spawn 子进程（stdio）；http/sse 由 createTransportFromConfig 抛 not-implemented */
  private defaultClientFactory(cfg: McpServerConfig, resolvedEnv?: Record<string, string>): McpClientLike {
    const transport = createTransportFromConfig({
      ...cfg.transport,
      ...(cfg.transport.type === 'stdio' && resolvedEnv ? { env: resolvedEnv } : {}),
    });
    return new McpClient({
      transport,
      clientInfo: this.clientInfo,
      requestTimeoutMs: this.requestTimeoutMs,
    });
  }

  /** 由 McpExtension.setup 注入 */
  bindRuntime(runtime: Runtime): void {
    this.runtime = runtime;
  }

  getDiagnostics(): McpDiagnostic[] {
    return [...this.diagnostics];
  }

  getStatus(): McpServerStatus[] {
    return this.configs.map((cfg) => {
      const st = this.states.get(cfg.name);
      return {
        name: cfg.name,
        enabled: cfg.enabled !== false,
        connected: !!st && !st.error,
        transport: cfg.transport.type,
        toolCount: st?.tools.length ?? 0,
        error: st?.error,
      };
    });
  }

  // ─── 连接 ──────────────────────────────────────────────────

  /** 幂等：已连接则直接返回；并发调用合并为一次 */
  ensureConnected(): Promise<McpDiagnostic[]> {
    if (this.connected) return Promise.resolve(this.getDiagnostics());
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<McpDiagnostic[]> {
    const enabled = this.configs.filter((c) => c.enabled !== false);
    await Promise.allSettled(enabled.map((cfg) => this.connectOne(cfg)));
    this.connected = true;
    this.registerAllTools();
    return this.getDiagnostics();
  }

  private async connectOne(cfg: McpServerConfig): Promise<void> {
    // stdio：env 展开，未定义变量 → 跳过该 server（记 error 诊断）
    let resolvedEnv: Record<string, string> | undefined;
    if (cfg.transport.type === 'stdio') {
      const envRes = resolveEnv(cfg.transport.env);
      if (!envRes.ok) {
        this.diagnostics.push({
          type: 'error',
          server: cfg.name,
          message: `env var(s) undefined: ${(envRes.missing ?? []).join(', ')}`,
        });
        return;
      }
      resolvedEnv = envRes.value ?? undefined;
    }
    // 通过工厂创建客户端（stdio = spawn 子进程；http/sse = fetch + SSE；测试可注入替身）
    const client = this.clientFactory(cfg, resolvedEnv);
    client.setOnListChanged(() => {
      this.refreshOne(cfg.name).catch((e) => {
        this.diagnostics.push({ type: 'warning', server: cfg.name, message: `list_changed refresh failed: ${e.message}` });
      });
    });
    try {
      await client.connect();
      const tools = this.applyFilter(cfg, await client.listTools());
      this.states.set(cfg.name, { config: cfg, client, tools, registeredNames: new Set() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.diagnostics.push({ type: 'error', server: cfg.name, message: `connect failed: ${msg}` });
      this.states.set(cfg.name, { config: cfg, client, tools: [], registeredNames: new Set(), error: msg });
      await client.dispose().catch(() => {});
    }
  }

  private applyFilter(cfg: McpServerConfig, tools: McpToolInfo[]): McpToolInfo[] {
    const f = cfg.toolFilter;
    if (!f) return tools;
    if (typeof f === 'function') return tools.filter((t) => f(t.name));
    const set = new Set(f);
    return tools.filter((t) => set.has(t.name));
  }

  // ─── 工具注册 ──────────────────────────────────────────────

  private registerAllTools(): void {
    if (!this.runtime) return;
    for (const [serverName, st] of this.states) {
      if (st.error) continue;
      for (const tool of st.tools) {
        this.registerOne(serverName, tool);
      }
    }
  }

  private registerOne(serverName: string, tool: McpToolInfo): void {
    if (!this.runtime) return;
    const st = this.states.get(serverName);
    if (!st) return;
    const wrapped = wrapMcpTool(st.config, tool, (rawName, args, signal) =>
      this.callTool(serverName, rawName, args, signal),
    );
    if (this.registered.has(wrapped.name)) return; // 幂等：避免重复注册告警
    this.registered.add(wrapped.name);
    st.registeredNames.add(wrapped.name);
    this.runtime.registerTool(wrapped);
  }

  /** 注销某 server 已注册进 runtime 的全部工具（refresh/reconnect/dispose 用） */
  private unregisterServerTools(serverName: string): void {
    if (!this.runtime) return;
    const st = this.states.get(serverName);
    if (!st) return;
    for (const name of st.registeredNames) {
      this.runtime.unregisterTool(name);
      this.registered.delete(name);
    }
    st.registeredNames.clear();
  }

  // ─── 调用 ──────────────────────────────────────────────────

  async callTool(
    serverName: string,
    rawName: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult> {
    let st = this.states.get(serverName);
    if (!st || st.error) {
      // 惰性重连一次（连接已断场景）
      if (st?.error) {
        await this.reconnectOne(st.config).catch(() => {});
        st = this.states.get(serverName);
      }
      const cur = this.states.get(serverName);
      if (!cur || cur.error) {
        return {
          content: [{ type: 'text', text: `MCP server "${serverName}" not connected` }],
          isError: true,
        };
      }
      st = cur;
    }
    const result = await st.client.callTool(rawName, args, {
      signal,
      timeoutMs: st.config.timeoutMs,
    });
    // 调用后发现传输已断 → 标记待重连
    if (st.client.isDisposed()) {
      st.error = 'client disposed';
    }
    return result;
  }

  // ─── 刷新 / 重连 ──────────────────────────────────────────

  async refresh(): Promise<McpDiagnostic[]> {
    await Promise.allSettled(
      [...this.states.keys()].map((name) => this.refreshOne(name)),
    );
    return this.getDiagnostics();
  }

  private async refreshOne(serverName: string): Promise<void> {
    const st = this.states.get(serverName);
    if (!st || st.error) return;
    try {
      const tools = this.applyFilter(st.config, await st.client.listTools());
      const prefix = st.config.toolPrefix ?? st.config.name;
      // 期望注册的工具全名集合
      const desired = new Set(tools.map((t) => buildToolName(prefix, t.name)));
      // 注销已消失的工具
      for (const name of [...st.registeredNames]) {
        if (!desired.has(name)) {
          this.runtime?.unregisterTool(name);
          this.registered.delete(name);
          st.registeredNames.delete(name);
        }
      }
      st.tools = tools;
      // 注册新增工具
      for (const tool of tools) this.registerOne(serverName, tool);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.diagnostics.push({ type: 'warning', server: serverName, message: `refresh failed: ${msg}` });
    }
  }

  private async reconnectOne(cfg: McpServerConfig): Promise<void> {
    // 先注销旧工具，再重连注册（避免旧名残留）
    this.unregisterServerTools(cfg.name);
    this.states.delete(cfg.name);
    await this.connectOne(cfg);
    const st = this.states.get(cfg.name);
    if (st && !st.error) {
      for (const tool of st.tools) this.registerOne(cfg.name, tool);
    }
  }

  // ─── 释放 ──────────────────────────────────────────────────

  async dispose(): Promise<void> {
    // 注销所有已注册工具（干净移除，不留残留）
    for (const name of [...this.states.keys()]) this.unregisterServerTools(name);
    await Promise.allSettled(
      [...this.states.values()].map((st) => st.client.dispose()),
    );
    this.states.clear();
    this.registered.clear();
    this.connected = false;
  }
}
