# @aipack-ai/mcp 设计方案

> 状态：已评审（v1.1 修订：权限默认行为修正、工具注销缺口、协议细节补充：ping / cancelled / list_changed / Streamable HTTP 复杂度 / content 容错）
> 范围：`packages/mcp`（新增包，可选附带 `packages/cli` 接线）
> 参考：MCP 规范（2025-06-18）、`packages/multi-agent/extensions/mcp-bridge.ts` 既有实现、`packages/skills` 插件包模板

---

## 1. 目标与原则

- **打通 MCP 生态，双向扩展**：
  - **客户端方向（主）**：Agent 连接外部 MCP Server（GitHub / 文件系统 / 数据库 / 浏览器…），把远端工具包装为 aipack 原生 `Tool`，零成本接入 MCP 工具生态
  - **服务端方向（辅）**：把 aipack 的 Agent / 工具集合反向暴露为标准 MCP Server，供 Claude Desktop、Cursor 等外部 MCP 客户端调用
- **零外部依赖**：自研 JSON-RPC 2.0 编解码 + MCP 核心协议子集，不引入 `@modelcontextprotocol/sdk`（对齐仓库"零运行时依赖"约定，也是 `mcp-bridge.ts` 已声明的原则："不依赖外部 MCP SDK，仅输出符合 MCP 规范的 JSON 结构"）
- **原生 Tool 适配**：MCP 工具一经包装即获得 runtime 全套能力——`PermissionPolicy` 审批、`toolTimeoutMs` 超时、`beforeToolCall / afterToolCall` 钩子、telemetry 埋点、并行调用——无需任何特殊通道
- **协议子集，按需演进**：v1 只实现 `initialize` + `tools/list` + `tools/call`（Agent 框架最核心的能力面），resources / prompts / sampling 留待后续版本
- **零侵入向后兼容**：不配置 MCP server 时行为与现在完全一致；包可选安装（peer 依赖 `@aipack-ai/agent`）

## 2. 现状分析

| 现状 | 说明 | 缺口 |
|---|---|---|
| `packages/multi-agent/extensions/mcp-bridge.ts` | `MCPBridge` 把 `AgentGraph` 作为 MCP Server 暴露，输出 MCP 规范形状的 JSON（含 `isError` + content blocks） | **仅服务端、无传输层**（"由宿主环境负责实际的 MCP 传输"），且绑死 multi-agent 场景 |
| `packages/skills` | 最新插件包模板：`Extension` 在 `setup` 阶段经 `context.runtime.registerTool()` 注册工具，`beforeModelCall` 注入 prompt 段 | 无 MCP 能力 |
| agent 核心 | `Tool { name, description, parameters, permissions, execute }` + Tapable 钩子 + 权限/审批/超时/telemetry 完整工具执行链 | 无任何 MCP 客户端方向实现 |
| 全仓 | 零运行时外部依赖文化（memory 自研 BM25、skills 手写 frontmatter 解析、agent 自研 tapable） | 引入官方 SDK 将破坏该约定 |

**结论**：新包 `packages/mcp` 补齐"客户端消费外部 MCP Server"这一主缺口，同时把 MCPBridge 的服务端思路泛化为通用能力。

## 3. 总体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                        @aipack-ai/mcp                             │
│                                                                  │
│  ┌─ 客户端方向（主）──────────────────────────────────────────┐  │
│  │                                                            │  │
│  │  McpExtension (Extension)                                  │  │
│  │    setup: 注册壳工具 / beforeRun: ensureConnected          │  │
│  │         │                                                  │  │
│  │         ▼                                                  │  │
│  │  McpRegistry（多 server 管理、命名空间、冲突处理）           │  │
│  │         │                                                  │  │
│  │         ▼                                                  │  │
│  │  McpClient ── initialize / tools/list / tools/call         │  │
│  │         │                                                  │  │
│  │         ▼                                                  │  │
│  │  Transport: stdio (child_process) | http (Streamable HTTP) │  │
│  │             | sse (legacy)                                  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ 服务端方向（辅）─────────────────────────────────────────┐  │
│  │  McpServerHost: 把 Tool[] / Runtime 暴露为 MCP Server      │  │
│  │  （泛化 multi-agent/MCPBridge，提供 stdio 入口）            │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
          │ 客户端方向产出
          ▼
┌──────────────────────────────────────────────────────────────────┐
│  AgentRuntime（现有，零改动）                                     │
│  registerTool(mcpWrappedTool) → 权限/审批/超时/钩子/telemetry      │
└──────────────────────────────────────────────────────────────────┘
```

## 4. 分层与目录结构

对齐 skills 包的分层约定（契约层纯函数零 Node API，加载/传输层 Node only）：

```
packages/mcp/
├── index.ts                  # 分层导出：插件入口 / 契约层 / 客户端 / 服务端 / 类型
├── package.json
├── tsup.config.ts            # 与 skills 一致（esm / dts / skipNodeModulesBundle）
├── src/
│   ├── types.ts              # McpServerConfig / McpToolInfo / McpCallResult / 诊断类型
│   ├── extension.ts          # McpExtension + createMcpPlugin（聚合工厂，仿 memory 包）
│   ├── adapter.ts            # MCP 工具 → agent Tool 适配（纯函数）
│   ├── registry.ts           # McpRegistry：多 server 生命周期、命名空间、冲突去重
│   ├── client/
│   │   ├── jsonrpc.ts        # JSON-RPC 2.0 编解码 + 请求关联（纯函数）
│   │   ├── protocol.ts       # MCP 消息构造/校验：initialize / tools/*（纯函数）
│   │   ├── mcp-client.ts     # McpClient：握手、工具缓存、调用、断线重连
│   │   ├── stdio-transport.ts    # child_process spawn + 行分隔 JSON（Node only）
│   │   └── http-transport.ts     # Streamable HTTP + SSE 降级（Node only）
│   └── server/
│       ├── host.ts           # McpServerHost：tools/list + tools/call → 本地 Tool
│       └── stdio-entry.ts    # 进程入口（stdin/stdout 循环，供外部 MCP 客户端拉起）
└── tests/
    ├── jsonrpc.test.ts       # 纯函数单测
    ├── protocol.test.ts      # 握手/工具消息编解码单测
    ├── adapter.test.ts       # 映射、命名冲突、权限标记单测
    ├── registry.test.ts       # 多 server 合并、诊断
    └── integration.test.ts   # 测试内自举最小 MCP server 子进程，端到端验证 stdio
```

## 5. 核心类型设计

### 5.1 服务端配置（`src/types.ts`）

```ts
export type McpTransportConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: 'http'; url: string; headers?: Record<string, string> }   // Streamable HTTP（含 ${ENV} 展开）
  | { type: 'sse'; url: string; headers?: Record<string, string> };   // legacy SSE 兼容

export interface McpServerConfig {
  /** 唯一标识；默认同时作为工具前缀 */
  name: string;
  transport: McpTransportConfig;
  /** 默认 true；false 时跳过连接（配置文件中保留条目） */
  enabled?: boolean;
  /** 工具名前缀，默认 = name；传空字符串可禁用前缀 */
  toolPrefix?: string;
  /** 工具白名单：只注册匹配的工具（名称为 MCP 原始名） */
  toolFilter?: string[] | ((rawName: string) => boolean);
  /** 该 server 单次调用超时（默认走 runtime 的 toolTimeoutMs） */
  timeoutMs?: number;
  /** 覆盖包装工具的权限标记，默认 ['mcp:<name>'] */
  permissions?: string[];
}

export interface McpDiagnostic {
  type: 'error' | 'warning' | 'collision';
  server: string;
  message: string;
}
```

### 5.2 客户端契约（`client/protocol.ts`，纯函数）

```ts
export interface McpToolInfo {
  name: string;                  // server 端原始名
  description?: string;
  inputSchema: unknown;          // JSON Schema，直接对接 agent Tool.parameters
}

export interface McpToolCallResult {
  content: Array<{
    type: string;                        // 'text' | 'image' | 'resource' | 'audio' | …（未知类型降级为文本摘要）
    text?: string;
    data?: string;
    mimeType?: string;
    /** 规范中 resource 块的载荷在嵌套字段（非扁平 data），v1 按 resource.uri 归档 + 文本摘要 */
    resource?: { uri: string; text?: string; blob?: string; mimeType?: string };
  }>;
  isError?: boolean;
}

// 纯函数：构造 initialize / tools/list / tools/call 的 JSON-RPC 请求
export function createInitializeRequest(opts): JsonRpcRequest;
export function createListToolsRequest(cursor?: string): JsonRpcRequest;
export function createCallToolRequest(name: string, args: unknown): JsonRpcRequest;
export function parseToolListResponse(payload: unknown): { tools: McpToolInfo[]; nextCursor?: string };
export function parseToolCallResult(payload: unknown): McpToolCallResult;
```

**容错约定**（`parseToolCallResult` / `parseToolListResponse`）：

- 规范中 `resource` 块载荷在 `resource: { uri, text|blob }` 嵌套字段（扁平 `data` 形状与规范不符）；2025-06-18 另新增 `audio` 类型与 `structuredContent`
- 对未知 `type` / 未知字段降级为文本摘要（`[unsupported content: <type>]`），保证对协议演进前向兼容
- JSON-RPC 层错误（如 `-32601` method not found、超时）统一转为 `isError: true` + 错误文本，走与 `isError` 相同的 `details.error` 通道

### 5.3 工具适配（`src/adapter.ts`，纯函数）

```ts
/**
 * McpToolInfo → agent Tool：
 * - name: `${prefix}__${rawName}`（前缀默认 server name，双下划线分隔，
 *   因 MCP 工具名常用单下划线/连字符）
 * - description: 保留原始 description，可标注 `[mcp:${server}]` 来源
 * - parameters: inputSchema 原样透传（JSON Schema 与 agent 约定一致）
 * - permissions: 默认 ['mcp:<server>']（CLI 权限 deny-by-default，需 M2 接线 'mcp' 前缀规则 → confirm 档）
 * - execute: (id, args, signal) => registry.callTool(server, rawName, args, signal)
 *   内部处理 content blocks → ToolResult.content 的 1:1 映射、
 *   isError → details.error（对齐 agent "details.error 存在 = 错误结果" 的约定）
 */
export function wrapMcpTool(server: McpServerConfig, tool: McpToolInfo,
                            call: (rawName: string, args: unknown, signal?: AbortSignal) => Promise<McpToolCallResult>): Tool;
```

**命名冲突策略**：registry 在注册前用 `Map` 预检，冲突时默认 `collision` 诊断 + 跳过（并告警），可通过 `toolPrefix` 显式解决；不依赖 `registerTool` 的静默覆盖行为。

### 5.4 插件入口（`src/extension.ts`）

```ts
export interface McpPlugin {
  registry: McpRegistry;
  extensions: Extension[];        // [McpExtension]
  diagnostics: McpDiagnostic[];
  /** 预热连接（可选；不调用则首次请求时懒连接） */
  ready(): Promise<McpDiagnostic[]>;
  /** 运行期热刷新：断线重连 / 重新拉取工具列表 */
  refresh(): Promise<McpDiagnostic[]>;
  dispose(): Promise<void>;       // 关闭所有子进程/HTTP 连接
  install(): { extensions: Extension[] };  // 供 aipack.config.js 展开
}

export function createMcpPlugin(options: McpPluginOptions): McpPlugin;
```

**异步生命周期问题与解法**（关键设计点）：`Extension.apply/setup` 是同步的，而 MCP 连接是异步的。方案：

1. `McpExtension.setup()` 同步注册一个**内部管理工具** `mcp_status`（查看连接状态/诊断，纯本地，`permissions: []`）
2. `hooks.beforeRun.tapPromise('McpExtension', ...)`：首次请求时 `await registry.ensureConnected()` → `tools/list` → 逐个 `context.runtime.registerTool(wrapMcpTool(...))`，幂等（已连接则直接返回）。`beforeRun` 是 waterfall 钩子，发生在 run loop 之前，注册的工具对本轮请求可见
3. 需要预热的宿主直接 `await plugin.ready()`（在 `createRuntime` 之前调用），CLI 启动时可用
4. 失败策略：单个 server 连接失败不阻断整体——记入 diagnostics，其余 server 正常工作；包装工具 execute 中发现连接已断则触发**惰性重连**（一次），仍失败返回 `details.error`
5. **工具注销（关键缺口）**：Runtime 仅有 `registerTool`（覆盖语义，见 `runtime/index.ts` 的 `_globalTools`），**无 `unregisterTool`**。v1 的 `refresh()` 只做**增量更新**——新增/覆盖 + 诊断报告"残留工具"（已从远端消失、`toolFilter` 收窄、`toolPrefix` 变更后遗留的旧名工具）；残留工具被模型调用时会走惰性重连 → 失败 → `details.error`，可自愈。M2 在 agent 包补 `unregisterTool(name)`（`_globalTools.delete` + 事件，改动极小）后实现完整移除

### 5.5 服务端方向（`server/host.ts`）

```ts
export interface McpServerHostOptions {
  name: string; version?: string;              // serverInfo
  tools: Tool[];                                // 或 () => Tool[]
  permissions?: PermissionPolicy;              // 复用现有权限裁决，外呼同样走审批
}
export function createMcpServerHost(options): {
  /** 供任意传输层驱动的消息处理入口（stdio / http 共用，仿 MCPBridge.handleCall） */
  handleRequest(jsonRpcRequest: unknown): Promise<unknown>;
};
```

- 与 `multi-agent/MCPBridge` 的关系：**泛化而非复制**——MCPBridge 保持不动（避免 breaking），`packages/mcp` 提供面向 `Tool[]` 的通用实现；multi-agent 后续可迁移（标记为 M3 可选项）
- `stdio-entry.ts` 提供独立进程入口：读 stdin 行分隔 JSON-RPC → `handleRequest` → 写 stdout，外部 MCP 客户端（Claude Desktop 等）可直接在配置里以 `node packages/mcp/dist/server/stdio-entry.js` 拉起

## 6. 关键流程（客户端时序）

```
宿主                          McpExtension/Registry          McpClient(stdio)        外部 MCP Server
 │ createMcpPlugin(cfg)  │                                    │                        │
 │ createRuntime({...})   │                                    │                        │
 │ runtime.run(req) ─────▶│ beforeRun: ensureConnected        │                        │
 │                        │─── spawn + initialize ──────────▶│──── initialize ──────▶│
 │                        │◀── serverInfo/capabilities ───────│◀── protocolVersion ───│
 │                        │─── notifications/initialized ────▶│──────────────────────▶│
 │                        │─── tools/list ───────────────────▶│──── tools/list ──────▶│
 │                        │◀── tools[] ───────────────────────│◀────────────────────── │
 │                        │ registerTool(wrapMcpTool…) ×N     │                        │
 │           （run loop 正常执行，模型看到 MCP 工具）            │                        │
 │ 模型调用 mcp 工具 ──────▶│ execute → tools/call              │                        │
 │                        │   （权限/审批/超时/钩子由 runtime 统一处理）                  │
 │                        │─── tools/call(name, args) ───────▶│──── tools/call ──────▶│
 │                        │◀── content blocks / isError ──────│◀──────────────────────│
```

- **协议版本协商**：client 发送 `2025-06-18`，server 返回不支持时降级到 server 版本（若 ≥ `2024-11-05` 基线），完全不匹配则记 error 诊断并禁用该 server
- **分页**：`tools/list` 遵循 `nextCursor` 循环拉全
- **取消**：`execute(toolCallId, args, signal)` 收到的 signal 透传给传输层——HTTP 场景 `AbortController.abort()`；stdio 场景无法强制中断子进程计算，仅本地超时 + 结果丢弃（由 runtime 的 `withTimeoutSignal` 兜底）。两种场景均**发送 `notifications/cancelled`**（携带请求 id），协作型 server 可停止计算，成本一行
- **服务端主动请求**：消息循环需区分入站**响应 / 通知 / 请求**三类消息——Streamable HTTP 下官方 SDK server 会周期发送 `ping` **请求**（非通知），不回复会被断连。v1 至少实现 `ping` → `{}` 应答；未知方法返回 JSON-RPC error `-32601`
- **工具列表变更通知**：握手后若 server 声明 `tools.listChanged` capability，订阅 `notifications/tools/list_changed` 自动触发 re-list（比手动 `/mcp refresh` 体验好，实现便宜）

## 7. 安全与权限

| 关注点 | 设计 |
|---|---|
| 权限标记 | 包装工具默认 `permissions: ['mcp:<server>']`（外部进程/网络调用，不可默认放行）；可用 `McpServerConfig.permissions` 覆盖。**注意**：`createPermissionPolicy` 为 **deny-by-default**（无规则匹配默认 deny），CLI builtin 规则仅覆盖 `fs:read` / `fs:write` / `shell:exec`——**M1 未做 CLI 接线时 MCP 工具会被全部拒绝**（fail-closed，方向安全，需在文档明示）；M2 接线时一条 `permission: 'mcp'` 规则即可前缀命中所有 `mcp:<server>`（`hasPermission` 支持前缀匹配）→ **confirm 档** |
| 环境变量 | `env` 值支持 `${VAR}` 展开（对齐 `.mcp.json` 生态惯例）；**变量未定义时该 server 记 `error` 诊断并跳过连接**（不静默传空串，避免难排查的下游认证失败）；不透传宿主全量环境变量，最小化泄漏面 |
| stdio 子进程 | 限定 `command` 白名单不做（个人助手框架，交由权限层把关）；子进程 stdio 之外默认 `ignore`，防止污染宿主 stdout（JSON-RPC 通道完整性） |
| 远程 server | v1 仅支持静态 header / bearer token；OAuth 授权流留待后续版本 |
| 服务端方向 | 外部客户端的 `tools/call` 同样经过 `PermissionPolicy`；stdio 场景（本地拉起）默认放行，http 场景默认确认 |

## 8. 配置与生态兼容

采用社区事实标准 `.mcp.json` 格式（Claude Code / Cursor 兼容），v1 支持手动加载：

```jsonc
// .mcp.json（项目级）/ ~/.aipack/mcp.json（用户级），项目级优先
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    },
    "docs": { "type": "http", "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer ${MCP_TOKEN}" } }
  }
}
```

```ts
// 加载器（Node only）
export function loadMcpConfig(options?: { cwd?: string; userDir?: string }): { servers: McpServerConfig[]; diagnostics: McpDiagnostic[] };
```

程序化接入（库用户）：

```ts
import { createRuntime, createRequest, ... } from '@aipack-ai/agent';
import { createMcpPlugin } from '@aipack-ai/mcp';

const mcp = createMcpPlugin({
  servers: [{ name: 'github', transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] } }],
});

const runtime = await createRuntime({ /* ... */ extensions: [...mcp.extensions] });
// 可选预热：await mcp.ready();
```

## 9. CLI 集成（M2 阶段，可选）

- `packages/cli/src/builder.ts` 组装处接入：检测 `.mcp.json` → `createMcpPlugin` → extensions 展开
- 斜杠命令：`/mcp`（列出 server 连接状态与工具数）、`/mcp refresh`（热刷新工具列表）
- 权限策略接线：`mcp:*` → confirm 档
- `aipack mcp serve`：以 stdio Server 模式把当前会话工具暴露给外部 MCP 客户端（复用 `server/stdio-entry.ts`）

## 10. 测试策略

- **纯函数单测**（零 Node API，与 skills 的 core 单测同风格）：jsonrpc 编解码（含畸形输入）、协议消息构造、`parseToolListResponse` 容错、adapter 映射（name 前缀 / 冲突 / isError → details.error / permissions）、registry 多 server 合并与诊断
- **集成测试**：测试内用 `child_process.spawn(process.execPath, [echo-server-fixture])` 自举一个最小 MCP echo server（~100 行测试夹具，实现 initialize/tools_list/tools/call + 周期 ping + tools/list_changed），端到端验证 stdio 握手、工具注册、调用、入站 ping 应答、取消通知、超时与断连重连
- **回归**：不配置任何 server 时，插件对 runtime 行为零影响（空 extensions 场景快照测试）

## 11. 实施计划

| 里程碑 | 内容 | 交付判据 |
|---|---|---|
| **M1** 客户端闭环 | types / jsonrpc / protocol / stdio-transport / mcp-client / adapter / registry / extension + `createMcpPlugin` + 单测 + stdio 集成测试 | `examples/mcp-client.ts`：连接 npx github server，模型成功调用远端工具 |
| **M2** 生态接入 | http/sse 传输、`.mcp.json` 加载器、重连与热刷新（含 agent 包 `unregisterTool` 支持 + `tools/list_changed` 自动同步）、CLI 接线（builder + `/mcp` 命令 + `permission: 'mcp'` → confirm 档） | `aipack` 命令下 `.mcp.json` 自动生效，`/mcp` 可视化状态，MCP 工具默认走 confirm 审批 |
| **M3** 服务端泛化 | `server/host.ts` + stdio 入口 +（可选）multi-agent MCPBridge 迁移、resources/prompts 协议支持 | Claude Desktop 配置拉起 aipack 工具成功调用 |

## 12. 备选方案与风险

| 决策点 | 选择 | 备选 | 理由 |
|---|---|---|---|
| 依赖官方 `@modelcontextprotocol/sdk` | **否** | 是 | 全仓零运行时依赖约定；MCP 核心子集（initialize/tools）协议稳定，自研约 300 行；代价是后续 resources/sampling 等扩展需自行跟进协议演进 |
| 传输层首版范围 | stdio + Streamable HTTP + legacy SSE | 仅 stdio | remote server 日益主流；**Streamable HTTP 细节较多**：`Mcp-Session-Id` 会话管理、后续请求携带 `MCP-Protocol-Version` 头、POST 响应可能是 `text/event-stream` 流而非 JSON、`202 Accepted` 空响应——零依赖可用 Node 18+ fetch + 手写 SSE 解析，但预估**数百行**而非"复用 http 解析"，M2 排期需留足（M1 仅交付 stdio） |
| 工具注册时机 | `beforeRun` 懒连接 | 仅 `plugin.ready()` 预热 | 懒连接保证库用户零模板代码；预热作为 CLI/高级用户的可选优化 |
| 与 multi-agent MCPBridge 关系 | 共存，M3 再统一 | 直接替换 | 避免 breaking；MCPBridge 有独立消费者 |
| 协议版本演进（2025-06-18 之后） | 版本协商 + 降级 | 锁死版本 | 已设计协商逻辑，风险可控 |
| stdio 无法中断长调用 | 超时兜底 + 结果丢弃 + 发送 `notifications/cancelled` | kill 子进程 | kill 会摧毁 server 状态（连接缓存全失效），代价大于收益；cancelled 通知让协作型 server 自行停止 |
| 服务端主动消息（`ping` 请求 / `tools/list_changed` 通知） | v1 处理 ping 应答；订阅 list_changed 自动 re-list | 忽略入站请求 | 不应答 ping 会被官方 SDK server 断连；list_changed 实现便宜且体验好 |
| 工具注销能力缺失 | v1 `refresh()` 增量更新 + 残留诊断；M2 补 agent `unregisterTool` | v1 即实现完整移除 | Runtime 现无 `unregisterTool`；绕过（重建 Runtime）代价大；残留工具调用失败可经惰性重连/诊断自愈 |

## 13. 接线清单（实施时勾选）

- [ ] `packages/mcp/package.json`：`@aipack-ai/mcp`，peerDependencies `@aipack-ai/agent: workspace:*`，prebuild 先构建 agent（照抄 skills）
- [ ] `packages/mcp/tsup.config.ts`：esm / dts / sourcemap / skipNodeModulesBundle
- [ ] 根 `tsconfig.json` paths 增加 `"@aipack-ai/mcp": ["./packages/mcp/index.ts"]`
- [ ] 根 `package.json` 增加 `example:mcp` 脚本 + devDependencies（M2 时）
- [ ] 根 `README.md` 包结构表与核心包介绍补充 `@aipack-ai/mcp`
- [ ] changeset 初始化版本
- [ ] （M2）`packages/agent`：新增 `unregisterTool(name)`（`_globalTools.delete` + 事件），供 `refresh()` 完整移除工具
- [ ] （M2）CLI 权限规则：`{ permission: 'mcp', decision: 'confirm' }` 一条规则前缀命中所有 `mcp:<server>` 工具
- [ ] （M1）文档明示：未接 CLI 权限规则时 MCP 工具按 deny-by-default 被拒（fail-closed）
