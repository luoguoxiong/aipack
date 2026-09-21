# @aipack-ai/agent

## 1.1.5

### Patch Changes

- 版本对齐：`@aipack-ai/*` 全部 9 个发布包统一到 `1.1.5`（本包原 `1.1.0`），并启用 Changesets `fixed` 分组，此后所有包始终同版本发布。

## 1.1.0

### Minor Changes

- [#16](https://github.com/luoguoxiong/aipack/pull/16) [`6dff7b2`](https://github.com/luoguoxiong/aipack/commit/6dff7b22203d065bcdb9f3ce7d19fb947dd961f9) Thanks [@luoguoxiong](https://github.com/luoguoxiong)! - M2：MCP 生态接入。`@aipack-ai/mcp` 新增 Streamable HTTP + legacy SSE 传输（会话管理 / `MCP-Protocol-Version` 头 / SSE 响应解析 / GET 长连接收 server 主动消息）、`.mcp.json` 加载器（项目级优先于用户级，stdio/http/sse 归一化）、热刷新完整移除已消失工具。`@aipack-ai/agent` 新增 `Runtime.unregisterTool(name)` 供插件热刷新。`@aipack-ai/cli` 接线：自动加载 `.mcp.json` → MCP 插件 + `permission: 'mcp'` → confirm/pending 档 + `/mcp` 与 `/mcp refresh` 斜杠命令。
