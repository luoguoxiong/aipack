# aipack CLI 与 Claude Code (cc) 功能差距分析

> 分析对象：`packages/cli`（v1.1.8，依赖 `@aipack-ai/agent` / `@aipack-ai/compression` / `@aipack-ai/mcp`）
> 分析日期：2026-10-08

## 一、整体架构

- `src/bin.ts` — 可执行入口（`bin: aipack`），处理 EPIPE 静默退出
- `src/cli.ts` — `main()`：子命令分发（approvals）→ 参数校验 → stdin/管道处理 → 构建 Runtime → 三模式路由（json / print / interactive）
- `src/args.ts` — 参数解析 + 帮助文本，全部 CLI 选项的唯一清单
- `src/builder.ts` — Runtime 组装：`aipack.config.js` 加载、模型解析、会话 key 解析、权限策略、MCP 插件、五级压缩 transformer
- `src/tools.ts` — 7 个内置工具 + 工作区路径越界防护
- `src/confirm.ts` — 危险命令正则检测 + 三选项确认
- `src/modes/interactive.ts` — REPL + 全部斜杠命令 + 多行输入 + Ctrl+C 语义 + L5 会话交接
- `src/modes/print.ts` / `json.ts` / `render.ts` — 非交互模式 / JSON 事件流 / 共用 Chunk 渲染器
- `src/commands/approvals.ts` / `models.ts` — `approvals` 子命令 / `--list-models`

## 二、已实现功能（核心骨架已对齐 cc）

| 功能 | 现状 | 关键位置 |
|---|---|---|
| REPL / 斜杠命令 | 13 个命令：`/help /model /thinking /system /session /sessions /clear /compact /tools /mcp /approvals /approve /deny /quit`；多行输入、busy 排队、双击 Ctrl+C 退出 | `src/modes/interactive.ts` |
| 内置工具 | read / write / edit / bash / find / grep / ls；bash 超时钳制 1s–600s、进程组 kill、环境变量白名单防 API Key 泄漏；`--tools/-xt/--no-tools` 白黑名单 | `src/tools.ts` |
| MCP | 项目级 `.mcp.json` 优先于 `~/.aipack/mcp.json`，兼容 cc/Cursor 格式，stdio/http/sse，懒连接 + `/mcp refresh` 热刷新 | `src/builder.ts:403-409` |
| 上下文管理 | 五级压缩（L1 工具输出裁剪 → L2 消息摘要 → L3 任务状态 → L4 检查点 → L5 会话交接）；`/compact` 手动压缩；`--no-compaction` | `src/builder.ts:261-341` + `packages/compression` |
| 权限/审批 | 三层决策链：`approvals.enabled`（pending 落盘）> `--safe` > 智能默认；危险命令 10 条正则；跨进程 `aipack approvals list/approve/deny` | `src/confirm.ts`、`src/commands/approvals.ts` |
| 会话持久化 | `-c/--continue`、`-r/--resume`（交互选择，最多 15 个）、`--session/--name/--session-dir/--no-session`；按 cwd 分组存于 `~/.aipack/cli-sessions/`；`/sessions <n>` 会话内切换 | `src/version.ts` |
| 非交互模式 | `-p/--print`（stdout 纯文本、工具信息走 stderr）、`--mode json`（JSONL 事件流含 usage/stopReason/toolsUsed）、管道 stdin 自动降级 print 模式 | `src/modes/print.ts`、`src/modes/json.ts`、`src/cli.ts:62-71` |
| 多模态 | `@file` 引用图片走 `Request.media` base64 通道（10MB 上限）；非视觉模型提前警告并丢弃附件 | `src/initial-message.ts` |

## 三、与 cc 相比的六大差距

### 1. 项目记忆文件（CLAUDE.md 类）— 完全缺失

- 全 src 无任何 `AIPACK.md` / `AGENTS.md` / `CLAUDE.md` 加载逻辑（搜索 0 命中）
- 系统提示词是硬编码 4 行中文（`src/builder.ts:530-539`）
- 没有 `/init` 命令生成项目记忆文件

### 2. Hooks — 框架有、CLI 未接入

- agent 框架有内部 `RuntimeHooks`（before/afterToolCall、beforeModelCall 等 12 个钩子）
- CLI 未暴露任何用户 hook 配置（无 settings 里的 PreToolUse/PostToolUse 等）

### 3. Skills — 零实现

- `packages/agent/core/extension.ts:34,95` 注释提到"skills 目录注入"作为典型用途，但仅存在于注释，无任何实现
- 仓库根有 `SKILLS_PLAN.md` 规划文档，尚未落地

### 4. 子 agent / Task 工具 — 无

- agent 包的 TaskGraph 只是"工具调用链分析"（`analyzeToolChains` / `findOrphanedToolCalls`），非子 agent 编排
- 无 agent tool、无并行子任务；仓库根 `MULTI_AGENT_IMPROVEMENT.md` / `multi-agent-design.md` 为规划文档

### 5. git 工作流 — 无

- 唯一 git 相关代码是遍历剪枝 `.git` 目录（`src/tools.ts:330`）
- 无 git diff/commit 工具、无 checkpoint 回滚

### 6. 编辑体验 — 最小实现

- `edit` 工具仅单一 oldString→newString 精确替换（`src/tools.ts:141-180`）
- 无 diff 渲染预览、无行号编辑、无 multi-edit、无"拒绝并反馈"、无 notebook

## 四、次级差距

| 差距项 | 说明 |
|---|---|
| settings.json 多层级配置 | 仅项目根 `aipack.config.js`，无 user/project/local 分层 |
| 精确 token 计数 | 4 字符/token 粗估（`packages/agent/core/tokens.ts`），无精确 tokenizer |
| `/context` 命令与费用统计 | 无 context 状态展示，JSON 模式仅 token 数无 cost |
| web 搜索工具 | 无 |
| TODO / plan 模式 | 无 |
| output style | 无 |
| IDE / VS Code 集成 | 无 |
| JSON 模式字段 | 事件流精简：无 tool args、无 thinking 内容、无 sessionId 体系 |
| `--verbose` / stream-json include_partial | 无 |

## 五、半成品与已知限制

- `packages/agent/core/extension.ts` 中 skills 相关仅是注释愿景
- `src/commands/approvals.ts:58`：等待中的运行进程不会被自动唤醒（跨进程无通知机制）
- `src/version.ts:35` 的 `legacyEncodeDir` 仅为存量会话编码兼容
- 测试覆盖：`test/` 下 5 个测试（args、compaction 集成、confirm、mcp-wiring、tools-path），**交互模式无测试**

## 六、结论与建议优先级

核心循环（REPL、工具循环、权限审批、MCP、压缩、会话持久化、多模态入口、三种输出模式）已对齐 cc。差距集中在**项目记忆、hooks、skills、子 agent、git 工作流、编辑体验**六大块。

投入产出比排序（框架已就绪、接入成本低者优先）：

1. **Hooks** — RuntimeHooks 已存在，只需在 CLI/配置层暴露
2. **项目记忆文件** — 实现简单（读取 + 注入系统提示词），收益大
3. **Skills** — Extension 机制已就绪，配合 `SKILLS_PLAN.md` 落地
4. **编辑体验**（diff 预览、multi-edit）— 独立可增量
5. **子 agent / Task 工具** — 依赖 `MULTI_AGENT_IMPROVEMENT.md` 规划推进
6. **git 工作流** — checkpoint / diff / commit 工具集
