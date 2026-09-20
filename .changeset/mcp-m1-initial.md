---
"@aipack-ai/mcp": minor
---

新增 `@aipack-ai/mcp` 包（M1 客户端闭环）：连接外部 MCP Server（stdio 传输），把远端工具包装为 aipack 原生 `Tool`。自研 JSON-RPC 2.0 编解码 + MCP 核心协议子集（initialize / tools/list / tools/call / ping / notifications/cancelled / tools/list_changed）。提供 `createMcpPlugin` 插件工厂（beforeRun 懒连接 + ready 预热 + refresh 热刷新 + mcp_status 内部工具），零运行时依赖。含纯函数单测 + stdio 集成测试（自举 echo server 夹具）+ `examples/mcp-client.ts`。
