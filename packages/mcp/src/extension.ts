/**
 * extension.ts - MCP 插件入口（Node only）
 *
 * 通过 @aipack-ai/agent 的 Extension 机制零侵入接入 Runtime：
 *   1. setup（同步）：注册内部管理工具 mcp_status（查看连接状态 / 诊断，
 *      纯本地，permissions: [] 视为安全工具）；把 registry 与 runtime 绑定
 *   2. beforeRun（waterfall，异步）：首次请求时 await registry.ensureConnected()
 *      → 工具注册进 runtime；幂等。连接失败不阻断 run，记诊断
 *
 * 异步生命周期：Extension.apply/setup 是同步的，MCP 连接是异步的——
 * 故把连接放 beforeRun（runtime/index.ts 在 run loop 前触发，本轮注册的工具可见），
 * 预热放 plugin.ready()（createRuntime 之前调用，CLI 启动可用）。
 */

import {
  BaseExtension,
  type Extension,
  type ExtensionContext,
  type RuntimeHooks,
  type Request,
} from '@aipack-ai/agent';
import { McpRegistry } from './registry';
import type { McpPluginOptions, McpDiagnostic } from './types';

// ─── McpExtension ──────────────────────────────────────────────

export class McpExtension extends BaseExtension {
  readonly name = 'mcp';

  constructor(private registry: McpRegistry) {
    super();
  }

  protected setup(hooks: RuntimeHooks, context: ExtensionContext): void {
    const registry = this.registry;

    // 1. 绑定 runtime（registry 注册工具时需要）
    if (context.runtime) registry.bindRuntime(context.runtime);

    // 2. 注册 mcp_status 内部工具（查看连接状态 / 诊断；permissions: [] 安全放行）
    if (context.runtime) {
      context.runtime.registerTool({
        name: 'mcp_status',
        description:
          '查看 MCP server 连接状态、已注册工具数与诊断信息（本地，不发起远端调用）',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        permissions: [],
        async execute() {
          const status = registry.getStatus();
          const diagnostics = registry.getDiagnostics();
          const text = JSON.stringify({ servers: status, diagnostics }, null, 2);
          return { content: [{ type: 'text' as const, text }], details: undefined };
        },
      });
    }

    // 3. beforeRun：懒连接 + 注册工具（幂等；失败不阻断 run）
    hooks.beforeRun.tapPromise('mcp', async (request: Request): Promise<Request> => {
      try {
        await registry.ensureConnected();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[mcp] ensureConnected failed: ${msg}`);
      }
      return request;
    });
  }
}

// ─── 插件工厂 ──────────────────────────────────────────────────

export interface McpPlugin {
  readonly registry: McpRegistry;
  readonly extensions: Extension[];
  /** 当前诊断快照（连接错误 / 冲突 / 警告） */
  readonly diagnostics: McpDiagnostic[];
  /** 预热连接（可选；不调用则首次请求时懒连接）。createRuntime 之前调用 */
  ready(): Promise<McpDiagnostic[]>;
  /** 热刷新：断线重连 / 重新拉取工具列表（含完整移除已消失工具） */
  refresh(): Promise<McpDiagnostic[]>;
  /** 关闭所有子进程 / HTTP 连接 */
  dispose(): Promise<void>;
  /** 供 aipack.config.js 展开（与 memory / skills 工厂对齐） */
  install(): { extensions: Extension[] };
}

export function createMcpPlugin(options: McpPluginOptions = {}): McpPlugin {
  const registry = new McpRegistry(options);
  const extension = new McpExtension(registry);

  return {
    registry,
    extensions: [extension],
    get diagnostics() {
      return registry.getDiagnostics();
    },
    ready: () => registry.ensureConnected(),
    refresh: () => registry.refresh(),
    dispose: () => registry.dispose(),
    install: () => ({ extensions: [extension] }),
  };
}
