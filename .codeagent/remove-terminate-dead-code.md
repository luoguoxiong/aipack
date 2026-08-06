# 删除 terminate 死代码

- 日期：2026-08-06
- 类型：重构 / 死代码移除
- 破坏性：是（移除 `ToolResult.terminate` 公开字段），版本 0.1.0

## 背景

`ToolResult.terminate` 字段设计为让工具返回 `terminate: true` 主动终止 agent 循环，但全仓排查发现该特性**完全断裂、零真实用例**：

- `buildToolResultMessage` 未把 `terminate` 写入 `ToolResultMessage`，类型本身也无此字段
- `findToolResult` 注释明说"不携带 terminate"，返回空 `details`
- 导致 `runLoop` 中的 `result?.terminate` 永远为 `undefined`，循环永不因工具而停
- 所有上层包（agentpack-coding / cli / memory / compression）均无工具使用 `terminate`

坏代码"看似工作、实际永不触发"，误导维护者。且与主流 agent "模型决策"设计相悖（Claude / OpenAI SDK 靠 stopReason 结束）。决定删除而非修复。

## 改动文件

| 文件 | 改动 |
| --- | --- |
| `packages/agentpack/core/types.ts` | 移除 `ToolResult.terminate?: boolean` 字段 |
| `packages/agentpack/runtime/index.ts` | 移除 `runLoop` 中的 terminate 检查块；移除仅为该检查服务的 `findToolResult` 私有方法 |
| `packages/agentpack/test/runtime-extended.test.ts` | 文件头注释移除 `terminate / ` 字样 |

## 不变项

- 循环停止统一由"模型不再发起 toolCall"（`runLoop` 中 `if (toolCalls.length === 0) break`）或 `maxTurns` 耗尽决定
- `runLoopStream` 本无 terminate 检查，未改动
- `context-resource` 转换本不搬运 terminate，未改动
- 工具侧中止场景（用户取消 / 超时）仍由 `abort()` + `AbortSignal` 覆盖

## 验证

- `pnpm --filter agentpack typecheck`：通过
- `pnpm --filter agentpack test`：327 tests, 0 fail
- `pnpm --filter agentpack build`：成功
- `rg -n "terminate" packages/agentpack`：无残留

## 计划文件

`.trae/documents/删除-terminate-死代码.md`（在仓库外，被 .gitignore 忽略）
