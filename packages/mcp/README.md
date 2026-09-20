# @aipack-ai/mcp

连接外部 MCP Server，把远端工具包装为 aipack 原生 `Tool`，零成本接入 MCP 工具生态。一经包装即获得 runtime 全套能力（权限审批 / 超时 / 钩子 / telemetry / 并行调用）。零运行时依赖：自研 JSON-RPC 2.0 编解码 + MCP 核心协议子集。

> 已完成：客户端方向 + stdio / Streamable HTTP / legacy SSE 传输 + `.mcp.json` 加载器 + 热刷新（完整移除已消失工具）。服务端方向、resources/prompts/sampling 留待 M3。

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
| `transport` | `{ type: 'stdio', command, args?, env?, cwd? }`（http/sse M2） |
| `enabled?` | 默认 true；false 时跳过连接 |
| `toolPrefix?` | 默认 = name；传空串禁用前缀 |
| `toolFilter?` | `string[]` 或 `(rawName) => boolean` 白名单 |
| `timeoutMs?` | 该 server 单次调用超时 |
| `permissions?` | 覆盖包装工具权限标记 |

## 内部工具

- `mcp_status`：查看各 server 连接状态、已注册工具数、诊断（本地，`permissions: []` 安全放行）。

## 协议与容错

- 版本协商：客户端发 `2025-06-18`，server 返回不支持时降级到 server 版本（≥ `2024-11-05` 基线即接受），完全不匹配则记 error 诊断并禁用该 server。
- `tools/list` 分页：遵循 `nextCursor` 循环拉全。
- 取消：`tools/call` 的 `AbortSignal` 触发 `notifications/cancelled`（协作型 server 可停止计算）；本地超时 + 结果丢弃兜底。
- 服务端主动消息：应答入站 `ping` 请求（否则官方 SDK server 会断连）；订阅 `notifications/tools/list_changed` 自动 re-list。
- content 容错：`resource` / `audio` / 未知类型降级为文本摘要；JSON-RPC 错误统一转 `isError` → `details.error`。
- env 展开：`env` 值支持 `${VAR}`；变量未定义则该 server 记 error 诊断并跳过（不静默传空串）。

## 分层

- 契约层（纯函数，零 Node API）：`jsonrpc` / `protocol` / `adapter` / `types`
- 客户端（Node only）：`stdio-transport` / `mcp-client` / `registry` / `extension`

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
pnpm --filter @aipack-ai/mcp test   # 含 jsonrpc / protocol / adapter / registry / loader / stdio + http 集成
```

## CLI 斜杠命令

在 `aipack` 交互模式下：

- `/mcp` — 列出各 MCP server 连接状态（● 已连 / ○ 断开）、工具数、诊断
- `/mcp refresh` — 热刷新工具列表（重连断开的 server + 完整移除已消失工具）
