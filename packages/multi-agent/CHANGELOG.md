# @aipack-ai/multi-agent

## 1.1.6

### Patch Changes

- 版本对齐：`@aipack-ai/*` 全部 9 个发布包统一到 `1.1.6`。

## 1.1.5

### Patch Changes

- 版本对齐：`@aipack-ai/*` 全部 9 个发布包统一到 `1.1.5`（本包原 `1.1.0`），并启用 Changesets `fixed` 分组，此后所有包始终同版本发布。

## 1.1.0

### Minor Changes

- [#16](https://github.com/luoguoxiong/aipack/pull/16) [`7dae9a8`](https://github.com/luoguoxiong/aipack/commit/7dae9a8d48468120d0e0989f4db7454daac6ddc2) Thanks [@luoguoxiong](https://github.com/luoguoxiong)! - M3：MCP 服务端泛化 + sampling 双向。`@aipack-ai/mcp` `McpServerHost` 把 aipack 原生 `Tool[]`（+ 可选 resources / prompts）反向暴露为标准 MCP Server，处理 initialize / tools/_ / resources/_ / prompts/\* / ping，未知方法回 `-32601`，`ToolResult.details.error` → MCP `isError`；`runStdioServer` 驱动 stdin/stdout 行分隔 JSON-RPC 循环并关联出站请求/响应，`server/stdio-entry` 提供独立进程入口（`AIPACK_MCP_TOOLS` 加载外部工具模块，回退内置 demo 工具 echo/add/ask_llm），Claude Desktop 可直接拉起。sampling：客户端方向 `McpClient` 经 `onSampling` 应答外部 server 发起的 `sampling/createMessage`（设置时宣告 `sampling` 能力，否则回 `-32601`）；服务端方向 `McpServerHost({ sampling: true })` 宣告能力并经 `host.sampleLLM()` 经出站通道向 client 请求 LLM 补全（`stdio-runner` 自动注入通道），新增 `createSamplingRequest` / `parseCreateMessageParams` / `buildCreateMessageResult` / `parseCreateMessageResult` 协议纯函数与类型。`@aipack-ai/multi-agent` `MCPBridge` 统一：新增 `asTools()` / `toMcpServerHost()` 与 `createMultiAgentMcpServerHost(graph)` 工厂，把 `AgentGraph` 经 `McpServerHost` + `runStdioServer` 拉起为 stdio MCP Server（补齐 MCPBridge 原缺失的传输层），run/status 核心逻辑在 legacy `handleCall()` 与统一路径间共享；legacy `listTools()`/`handleCall()` API 保持不变。新增 `@aipack-ai/mcp` 为 multi-agent workspace 依赖。

### Patch Changes

- Updated dependencies [[`6dff7b2`](https://github.com/luoguoxiong/aipack/commit/6dff7b22203d065bcdb9f3ce7d19fb947dd961f9), [`6dff7b2`](https://github.com/luoguoxiong/aipack/commit/6dff7b22203d065bcdb9f3ce7d19fb947dd961f9), [`7dae9a8`](https://github.com/luoguoxiong/aipack/commit/7dae9a8d48468120d0e0989f4db7454daac6ddc2)]:
  - @aipack-ai/mcp@2.0.0
  - @aipack-ai/agent@1.1.0
