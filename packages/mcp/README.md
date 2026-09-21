# @aipack-ai/mcp

连接外部 MCP Server，把远端工具包装为 aipack 原生 `Tool`，零成本接入 MCP 工具生态。一经包装即获得 runtime 全套能力（权限审批 / 超时 / 钩子 / telemetry / 并行调用）。零运行时依赖：自研 JSON-RPC 2.0 编解码 + MCP 核心协议子集。

> 已完成：客户端方向（stdio / Streamable HTTP / legacy SSE 传输 + `.mcp.json` 加载器 + 热刷新）与服务端方向（M3：`McpServerHost` 把 aipack 工具反向暴露为 MCP Server + stdio 进程入口 + resources/prompts 协议支持 + sampling 双向）。`multi-agent/MCPBridge` 已统一（`asTools()` / `toMcpServerHost()`）。

## 安装

```bash
pnpm add @aipack-ai/mcp @aipack-ai/agent
```

## 快速接入

```typescript
import { createRuntime } from '@aipack-ai/agent';
import { createMcpPlugin } from '@aipack-ai/mcp';

const mcp = createMcpPlugin({
  servers: [
    {
      name: 'github',
      transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
    },
  ],
});

const runtime = createRuntime({ extensions: [...mcp.extensions] });
await mcp.ready(); // 可选预热；不调用则首次 run 时 beforeRun 懒连接
```

工具命名：`${serverName}__${rawToolName}`（双下划线分隔）；权限默认 `mcp:<server>`，可经 `McpServerConfig.permissions` 覆盖。

## API

### `createMcpPlugin(options): McpPlugin`

| 字段 | 说明 |
| --- | --- |
| `options.servers` | `McpServerConfig[]` |
| `options.clientInfo` | 客户端标识，默认 `{ name: 'aipack-mcp', version: '0.1.0' }` |
| `options.requestTimeoutMs` | 单次请求超时，默认 30s |

`McpPlugin`：`registry` / `extensions` / `diagnostics` / `ready()` / `refresh()` / `dispose()` / `install()`。

### `McpServerConfig`

| 字段 | 说明 |
| --- | --- |
| `name` | 唯一标识；默认同时作为工具名前缀 |
| `transport` | 传输层配置，见下方「传输层」：`stdio` / `http` / `sse` |
| `enabled?` | 默认 true；false 时跳过连接 |
| `toolPrefix?` | 默认 = name；传空串禁用前缀 |
| `toolFilter?` | `string[]` 或 `(rawName) => boolean` 白名单 |
| `timeoutMs?` | 该 server 单次调用超时 |
| `permissions?` | 覆盖包装工具权限标记 |

## 传输层

```typescript
// ① stdio —— 本地子进程（spawn + 行分隔 JSON-RPC）
{ type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' }, cwd: '.' }

// ② Streamable HTTP —— 远程 server（2025-06-18）
//    会话头 Mcp-Session-Id · 后续请求带 MCP-Protocol-Version 头
//    POST 响应可为 application/json / text/event-stream(SSE) / 202 Accepted
{ type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${MCP_TOKEN}' } }

// ③ legacy SSE —— 兼容旧 server（GET 流首事件 endpoint 给出 POST URL）
{ type: 'sse', url: 'https://legacy.example.com/sse', headers: {} }
```

`.mcp.json` 中 stdio 条目省略 `type` 即可（有 `command` 即识别）；http/sse 条目需 `type` + `url`。

## 高级：直接驱动单个 MCP Server

`createMcpPlugin` 覆盖了绝大多数场景；需要精细控制（单 server、自定义 transport、sampling 应答）时可直接使用 `McpClient`：

```typescript
import { McpClient, createTransportFromConfig } from '@aipack-ai/mcp';

const client = new McpClient({
  transport: createTransportFromConfig({ type: 'stdio', command: 'node', args: ['server.mjs'] }),
  clientInfo: { name: 'aipack-mcp', version: '0.1.0' },
  // 应答外部 server 发起的 sampling/createMessage；设置后在 initialize 中宣告 sampling 能力
  onSampling: async ({ messages, maxTokens }) => ({
    role: 'assistant',
    content: { type: 'text', text: await myModel.complete(messages, { maxTokens }) },
    model: 'deepseek-chat',
  }),
});

await client.connect();
const tools = await client.listTools();
const result = await client.callTool('echo', { text: 'hi' }, { timeoutMs: 10_000 });
await client.dispose();
```

`McpClient` API：`connect()` / `listTools()` / `callTool(name, args, opts?)` / `setOnListChanged(cb)` / `setOnSampling(cb)` / `isInitialized()` / `isDisposed()` / `dispose()`。

## 内部工具

- `mcp_status`：查看各 server 连接状态、已注册工具数、诊断（本地，`permissions: []` 安全放行）。

## 协议与容错

- 版本协商：客户端发 `2025-06-18`，server 返回不支持时降级到 server 版本（≥ `2024-11-05` 基线即接受），完全不匹配则记 error 诊断并禁用该 server。
- `tools/list` 分页：遵循 `nextCursor` 循环拉全。
- 取消：`tools/call` 的 `AbortSignal` 触发 `notifications/cancelled`（协作型 server 可停止计算）；本地超时 + 结果丢弃兜底。
- 服务端主动消息：应答入站 `ping` 请求（否则官方 SDK server 会断连）；订阅 `notifications/tools/list_changed` 自动 re-list。
- content 容错：`resource` / `audio` / 未知类型降级为文本摘要；JSON-RPC 错误统一转 `isError` → `details.error`。
- env 展开：`env` 值支持 `${VAR}`；变量未定义则该 server 记 error 诊断并跳过（不静默传空串）。
- **sampling（server ↔ client LLM 补全）**：
  - 客户端方向：外部 server 发 `sampling/createMessage` → 经 `McpClientOptions.onSampling`（或 `setOnSampling`）应答；设置后客户端在 `initialize` 宣告 `sampling` 能力；未配置回 `-32601`（fail-safe）。
  - 服务端方向：`createMcpServerHost({ ..., sampling: true })` 宣告 sampling 能力；`host.sampleLLM(params)` 经传输层出站通道向 client 请求补全，`stdio-runner` 自动注入出站请求/响应关联。`stdio-entry` 内置 `ask_llm` 演示工具。

## 分层

- 契约层（纯函数，零 Node API）：`jsonrpc` / `protocol` / `adapter` / `types`
- 客户端（Node only）：`stdio-transport` / `http-transport` / `mcp-client` / `registry` / `extension` / `loader`
- 服务端（Node only）：`server/host`（McpServerHost：handleRequest + 反向 content 映射）/ `server/stdio-runner`（runStdioServer 循环）/ `server/stdio-entry`（进程入口）

## 权限说明

`createPermissionPolicy` 为 deny-by-default。MCP 工具默认 `permissions: ['mcp:<server>']`。CLI（`@aipack-ai/cli`）已接线一条 `permission: 'mcp'` 规则 → confirm 档（外部进程/网络调用，不可默认放行）；启用异步审批（`approvals.enabled`）时归入 pending 档。库用户需自行在 `createPermissionPolicy` 中追加该规则，否则 MCP 工具按 deny-by-default 被拒（fail-closed）。

## `.mcp.json` 加载（CLI 自动生效）

```jsonc
// <cwd>/.mcp.json（项目级，优先）/ ~/.aipack/mcp.json（用户级）
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } },
    "docs": { "type": "http", "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer ${MCP_TOKEN}" } }
  }
}
```

程序化加载：`loadMcpConfig({ cwd, userDir })` → `{ servers, diagnostics }`。stdio 条目无需 `type`（有 `command` 即识别）；http/sse 条目需 `type` + `url`。

## 运行示例 / 测试

```bash
pnpm example:mcp            # 连接本地 echo MCP server（离线可运行）
pnpm example:mcp-server     # 以 stdio Server 模式拉起 aipack 工具（离线可运行）
pnpm --filter @aipack-ai/mcp test   # 含 jsonrpc / protocol / adapter / registry / loader / stdio + http 集成 + server host + server stdio 端到端
```

## 服务端方向（M3）：把 aipack 工具暴露为 MCP Server

`McpServerHost` 把 aipack 原生 `Tool[]`（+ 可选 resources / prompts）反向暴露为标准 MCP Server，供 Claude Desktop、Cursor 等外部 MCP 客户端调用。与 `multi-agent/MCPBridge` 的关系：泛化而非复制（MCPBridge 保持不动，避免 breaking）。

### 程序化使用

```typescript
import { createMcpServerHost, runStdioServer } from '@aipack-ai/mcp';
import type { Tool } from '@aipack-ai/agent';

const tools: Tool[] = [
  { name: 'echo', description: 'echo back', parameters: { type: 'object', properties: { text: { type: 'string' } } }, permissions: [],
    async execute(_id, args) { return { content: [{ type: 'text', text: String((args as { text?: string })?.text ?? '') }], details: undefined }; } },
];

const host = createMcpServerHost({
  name: 'my-agent',
  version: '0.1.0',
  tools,
  // stdio 本地默认放行；http 场景可注入 authorize（可包装 PermissionPolicy）
  // authorize: async ({ toolName, args }) => true,
  // 可选：resources / prompts（提供则 advertise capability 并处理 resources/* / prompts/*）
  // resources: [{ uri: 'file://x', name: 'x', text: '...', mimeType: 'text/plain' }],
  // prompts: [{ name: 'greet', messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] }],
});

// 驱动 stdin/stdout 行分隔 JSON-RPC 循环
await runStdioServer(host);
```

`McpServerHost.handleRequest(message)` 为传输层无关入口：接收已分类的 JSON-RPC 消息，返回响应（请求）或 `null`（通知 / 非法）。处理 `initialize` / `tools/list` / `tools/call` / `ping` / `resources/*` / `prompts/*`；未知方法回 `-32601`，内部异常回 `-32603`。工具调用经可选 `authorize` 钩子裁决；`ToolResult.details.error` 存在 → MCP `isError`。

### stdio 进程入口（Claude Desktop 直接拉起）

`node packages/mcp/dist/server/stdio-entry.js`

工具来源（按优先级）：
1. 环境变量 `AIPACK_MCP_TOOLS` 指向一个 ESM 模块，其具名 `tools` 或默认导出为 `Tool[]`；
2. 未设置时回退内置演示工具（`echo` / `add` / `ask_llm`），开箱即用（`ask_llm` 演示 sampling 反向调用）。

Claude Desktop 配置示例：

```jsonc
{
  "mcpServers": {
    "aipack": {
      "command": "node",
      "args": ["/abs/path/to/packages/mcp/dist/server/stdio-entry.js"],
      "env": { "AIPACK_MCP_TOOLS": "/abs/path/to/my-tools.mjs" }
    }
  }
}
```

## CLI 斜杠命令

在 `aipack` 交互模式下：

- `/mcp` — 列出各 MCP server 连接状态（● 已连 / ○ 断开）、工具数、诊断
- `/mcp refresh` — 热刷新工具列表（重连断开的 server + 完整移除已消失工具）
