# @aipack-ai/cli

## 1.1.0

### Minor Changes

- [#16](https://github.com/luoguoxiong/aipack/pull/16) [`6dff7b2`](https://github.com/luoguoxiong/aipack/commit/6dff7b22203d065bcdb9f3ce7d19fb947dd961f9) Thanks [@luoguoxiong](https://github.com/luoguoxiong)! - M2：MCP 生态接入。`@aipack-ai/mcp` 新增 Streamable HTTP + legacy SSE 传输（会话管理 / `MCP-Protocol-Version` 头 / SSE 响应解析 / GET 长连接收 server 主动消息）、`.mcp.json` 加载器（项目级优先于用户级，stdio/http/sse 归一化）、热刷新完整移除已消失工具。`@aipack-ai/agent` 新增 `Runtime.unregisterTool(name)` 供插件热刷新。`@aipack-ai/cli` 接线：自动加载 `.mcp.json` → MCP 插件 + `permission: 'mcp'` → confirm/pending 档 + `/mcp` 与 `/mcp refresh` 斜杠命令。

### Patch Changes

- Updated dependencies [[`6dff7b2`](https://github.com/luoguoxiong/aipack/commit/6dff7b22203d065bcdb9f3ce7d19fb947dd961f9), [`6dff7b2`](https://github.com/luoguoxiong/aipack/commit/6dff7b22203d065bcdb9f3ce7d19fb947dd961f9), [`7dae9a8`](https://github.com/luoguoxiong/aipack/commit/7dae9a8d48468120d0e0989f4db7454daac6ddc2)]:
  - @aipack-ai/mcp@2.0.0
  - @aipack-ai/agent@1.1.0
  - @aipack-ai/compression@2.0.0

## 0.0.2

### Patch Changes

- [`d1f5731`](https://github.com/luoguoxiong/aipack/commit/d1f5731459c034551bf8d6f3a0a638b4c18bcc34) Thanks [@luoguoxiong](https://github.com/luoguoxiong)! - fix(cli): 修复全局安装后 aipack 命令无任何输出的问题

  - 新增独立 bin 入口 dist/bin.js，无条件调用 main()，不再依赖 argv 入口检测
  - 原入口检测在全局安装（bin 符号链接名为 aipack）及 tsup 代码分割场景下失效，导致静默退出
  - APP_NAME 改为取自 package.json 的 bin 字段，--help 正确显示 aipack 命令名
