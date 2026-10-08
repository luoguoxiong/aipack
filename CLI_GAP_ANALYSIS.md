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
- `src/subagents.ts` — 子 agent / `task` 工具（定义加载 + 隔离 Runtime 工厂）

## 二、已实现功能（核心骨架已对齐 cc）

| 功能 | 现状 | 关键位置 |
|---|---|---|
| REPL / 斜杠命令 | 18 个命令：`/help /model /thinking /system /session /sessions /clear /compact /tools /agents /memory /init /skills /skill:* /mcp /approvals /approve /deny /quit`；多行输入、busy 排队、双击 Ctrl+C 退出 | `src/modes/interactive.ts` |
| 内置工具 | read / write / edit / bash / find / grep / ls / task；bash 超时钳制 1s–600s、进程组 kill、环境变量白名单防 API Key 泄漏；`--tools/-xt/--no-tools` 白黑名单 | `src/tools.ts` |
| MCP | 项目级 `.mcp.json` 优先于 `~/.aipack/mcp.json`，兼容 cc/Cursor 格式，stdio/http/sse，懒连接 + `/mcp refresh` 热刷新 | `src/builder.ts:403-409` |
| 上下文管理 | 五级压缩（L1 工具输出裁剪 → L2 消息摘要 → L3 任务状态 → L4 检查点 → L5 会话交接）；`/compact` 手动压缩；`--no-compaction` | `src/builder.ts:261-341` + `packages/compression` |
| 权限/审批 | 三层决策链：`approvals.enabled`（pending 落盘）> `--safe` > 智能默认；危险命令 10 条正则；跨进程 `aipack approvals list/approve/deny` | `src/confirm.ts`、`src/commands/approvals.ts` |
| 会话持久化 | `-c/--continue`、`-r/--resume`（交互选择，最多 15 个）、`--session/--name/--session-dir/--no-session`；按 cwd 分组存于 `~/.aipack/cli-sessions/`；`/sessions <n>` 会话内切换 | `src/version.ts` |
| 非交互模式 | `-p/--print`（stdout 纯文本、工具信息走 stderr）、`--mode json`（JSONL 事件流含 usage/stopReason/toolsUsed）、管道 stdin 自动降级 print 模式 | `src/modes/print.ts`、`src/modes/json.ts`、`src/cli.ts:62-71` |
| 多模态 | `@file` 引用图片走 `Request.media` base64 通道（10MB 上限）；非视觉模型提前警告并丢弃附件 | `src/initial-message.ts` |
| 项目记忆文件（2026-10-08 落地） | 用户级 `~/.aipack/AIPACK.md` + 项目级 `AIPACK.md > AGENTS.md > CLAUDE.md` 自动加载注入系统提示词；`@path` 行级导入（深度 5、循环去重）；`/init` 由 AI 扫描项目生成、`/memory` 查看 | `src/memory.ts`、`src/builder.ts` |
| Hooks（2026-10-08 落地） | `aipack.config.js` 的 `hooks` 字段暴露 `PreToolUse/PostToolUse/UserPromptSubmit/Stop` 四事件（映射 RuntimeHooks）；matcher 过滤 + shell 命令，stdin 收 JSON、exit 2 或 stdout JSON 返回决策；失败/超时仅告警 | `src/hooks.ts` |
| Skills（2026-10-08 接线 CLI） | 复用既有 `@aipack-ai/skills` 插件包（Extension 零侵入接入：beforeModelCall 注入目录段 + 注册按需 `skill` 工具）；CLI 启动时 `createSkillsPlugin({ load: { cwd } })`，交互模式 `/skills` 列表、`/skill:<名称> [参数]` 显式触发 | `packages/skills/`、`packages/cli/src/builder.ts` |
| 子 agent / Task 工具（2026-10-08 落地） | `task` 工具启动隔离上下文的子 agent（独立 Runtime + 独立消息历史，ephemeral 不落盘），仅返回最终报告；同回合多个 task 调用自动并行；防递归（子 agent 工具集恒排除 task）；权限/审批复用主 agent 策略；定义来自内置 `general-purpose` + `aipack.config.js` 的 `agents` 字段（description/prompt 必填，tools/model/maxTurns 可选）；abort 全链路传播；交互模式 `/agents` 列表 | `src/subagents.ts`、`src/builder.ts` |

## 三、与 cc 相比的六大差距

### 1. 项目记忆文件（CLAUDE.md 类）— ✅ 已实现

- `src/memory.ts`：用户级 + 项目级记忆文件自动加载（`AIPACK.md > AGENTS.md > CLAUDE.md`），`@path` 导入展开后注入系统提示词尾部（`<memory source scope>` 段）；无记忆文件时零改动
- `/init` 斜杠命令：复用 agentic 循环让模型扫描项目并写入 `AIPACK.md`；`/memory` 查看已加载文件
- 测试：`test/memory.test.ts`（优先级 / 导入 / 循环去重）

### 2. Hooks — ✅ 已实现（CLI 层暴露）

- `src/hooks.ts`：`createUserHooksExtension` 把用户配置映射到 RuntimeHooks（PreToolUse→beforeToolCall、PostToolUse→afterToolCall、UserPromptSubmit→beforeRun、Stop→done）
- 支持 block（exit 2 或 stdout JSON `{"decision":"block"}`）、terminate、PreToolUse 改写 args、UserPromptSubmit 改写 prompt；默认 60s 超时，失败不中断
- 配置位置：`aipack.config.js` 的 `hooks` 字段；无配置零开销

### 3. Skills — ✅ 已接线（能力由 `@aipack-ai/skills` 插件包提供）

- 本文初稿"零实现"的判断有误：`packages/skills`（`@aipack-ai/skills`）已按 `SKILLS_PLAN.md` 落地——契约层（validateSkill/formatSkillsSection/createSkillTool/expandSkillCommand）+ 同步加载器（SKILL.md frontmatter、目录不递归、多源同名先注册者胜、collision 诊断）+ `SkillsExtension`（Extension 零侵入接入，不依赖 agent 核心 skills 集成）
- 本次补齐的是 **CLI 接线**：`builder.ts` 调用 `createSkillsPlugin({ load: { cwd } })` 并把 `plugin.extensions` 注入 Runtime（诊断告警），交互模式新增 `/skills` 列表与 `/skill:<名称> [参数]` 显式触发
- 修复：`packages/skills/tests/extension.test.ts` 两个端到端用例未配置 permissionPolicy，被框架默认 fail-closed 策略拒绝（补 `permissionFailOpen: true`）

### 4. 子 agent / Task 工具 — ✅ 已实现（2026-10-08）

- `src/subagents.ts`：`task` 工具工厂。每次调用创建独立子 Runtime（独立系统提示词 + 消息历史，ephemeral 请求不落盘），运行到结束后仅把最终报告（截断上限 30k 字符）返回主对话——检索/分析的海量工具输出不污染主上下文
- 并行：同一回合多个 task 调用由框架 `parallelToolCalls`（默认开启）自动并行，各自独立 Runtime 隔离
- 防递归：子 agent 工具集永远排除 task 自身（固定一层）；权限/审批复用主 agent 的 PermissionPolicy 与 ApprovalManager（子 agent 写文件/shell 仍走确认）
- 定义来源：内置 `general-purpose` + `aipack.config.js` 的 `agents` 字段（`description`/`prompt` 必填，`tools` 白名单 / `model` 覆盖（provider/id）/ `maxTurns` 可选）；非法定义告警后跳过；同名覆盖内置
- 细节：`/model` 切换后子 agent 跟随主模型（getter 闭包）；abort 信号（Ctrl+C / 工具超时）传播到子 Runtime 按会话 key 中止；task 启用时主 runtime 单工具超时兜底抬高到 10 分钟；项目记忆注入子 agent 系统提示词
- 交互模式新增 `/agents` 查看可用子 agent；测试：`test/subagents.test.ts`（定义校验 / 防递归 / 模型覆盖 / abort 传播 / 截断等 15 用例）
- 说明：本项为 CLI 级单子 agent 原语；`packages/multi-agent`（Pipeline/Router/Supervisor/Debate/MapReduce 图编排）为独立库能力，后续可作为特殊 agent 类型接入 task 工具

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

- ~~`packages/agent/core/extension.ts` 中 skills 相关仅是注释愿景~~（skills 已于 2026-10-08 独立落地：`core/skills.ts` + `skills/loader.ts`）
- `src/commands/approvals.ts:58`：等待中的运行进程不会被自动唤醒（跨进程无通知机制）
- `src/version.ts:35` 的 `legacyEncodeDir` 仅为存量会话编码兼容
- 测试覆盖：`test/` 下 8 个测试（args、compaction 集成、confirm、mcp-wiring、tools-path、memory、hooks、subagents），**交互模式无测试**

## 六、结论与建议优先级

核心循环（REPL、工具循环、权限审批、MCP、压缩、会话持久化、多模态入口、三种输出模式）已对齐 cc。差距集中在**项目记忆、hooks、skills、子 agent、git 工作流、编辑体验**六大块，其中前四项已落地。

投入产出比排序（框架已就绪、接入成本低者优先）：

1. ~~**Hooks** — RuntimeHooks 已存在，只需在 CLI/配置层暴露~~ ✅ 已实现（2026-10-08，`src/hooks.ts`）
2. ~~**项目记忆文件** — 实现简单（读取 + 注入系统提示词），收益大~~ ✅ 已实现（2026-10-08，`src/memory.ts`）
3. ~~**Skills** — Extension 机制已就绪，配合 `SKILLS_PLAN.md` 落地~~ ✅ 已接线（2026-10-08，能力在既有 `packages/skills` 插件包，本次补齐 CLI 接入）
4. **编辑体验**（diff 预览、multi-edit）— 独立可增量
5. ~~**子 agent / Task 工具** — 依赖 `MULTI_AGENT_IMPROVEMENT.md` 规划推进~~ ✅ 已实现（2026-10-08，`src/subagents.ts`；CLI 级单子 agent 原语，图编排见 `packages/multi-agent`）
6. **git 工作流** — checkpoint / diff / commit 工具集
