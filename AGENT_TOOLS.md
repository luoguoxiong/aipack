# Nanobot Agent 工具说明文档

本文件说明 nanobot-ts 项目中 Agent 可用工具的总数、分类、注册方式与执行流程。所有结论均基于源码（`src/agent/tools/`、`src/agent/runner.ts`、`src/agent/skills.ts`）。

---

## 一、总数概览

| 类别 | 数量 | 说明 |
| --- | --- | --- |
| 内置基础工具（`BaseTool` 子类） | **33 个** | 分布在 13 个工具模块中 |
| 默认加载工具（`ToolLoader` 默认配置） | **23 个** | spawn、exec_session 默认关闭 |
| 最小注册工具（`createDefaultToolRegistry`） | **18 个** | 仅含 7 个核心分组 |
| MCP 动态工具 | 不固定 | 由外部 MCP Server 在运行时注入，命名规则 `mcp_<server>_<tool>` |
| 内置技能（Skills） | **11 个** | 注意：Skills 不是工具，而是注入到系统提示词中的 Markdown 文档，引导 Agent 调用上述工具 |

> **关键区分**：本项目里「工具（Tool）」和「技能（Skill）」是两套不同机制。工具是 Agent 可直接调用的函数；技能是把 `SKILL.md` 文档拼进系统提示词，让模型学会「在什么场景下用哪些工具组合完成任务」。

---

## 二、工具体系架构

### 2.1 核心抽象：`BaseTool`

[src/agent/tools/base.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/base.ts) 定义了所有工具的基类：

```ts
export abstract class BaseTool {
  abstract name: string;             // 运行时工具名（如 'shell_exec'）
  abstract description: string;      // 给模型看的说明
  abstract input_schema: ZodType;    // Zod 校验的入参 schema
  tags: string[] = [];
  scope = 'global';

  // 把 Zod schema 转成 OpenAI function-calling 的 JSON Schema
  toProviderTool(): { type: 'function'; function: { name; description; parameters } };

  // 入参校验
  validateArguments(args: unknown): unknown { return this.input_schema.parse(args); }

  // 子类必须实现：真正干活的函数
  abstract execute(args: unknown, context: ToolContext): Promise<ToolResult>;
}
```

`ToolContext`（[base.ts:19-27](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/base.ts#L19-L27)）携带 `session_key / channel / chat_id / sender_id / workspace / runtime` 等运行时上下文；`ToolResult` 是 `{ content: string; is_error?: boolean; metadata? }`。

### 2.2 工具注册表：`ToolRegistry`

[src/agent/tools/registry.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/registry.ts) 是工具的中央仓库：

- `register(tool)` / `registerMany(tools)`：注册工具，按 `tool.name` 去重存入 `Map`。
- `get(name)` / `has(name)` / `list()`：查询。
- `getToolDefinitions()`：把所有工具转成 LLM Provider 期望的 function-calling 定义数组，供模型选择调用。
- **`executeTool(toolName, toolCallId, args, context, options)`**（[registry.ts:61-113](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/registry.ts#L61-L113)）：统一的执行入口，做四件事：
  1. 查表拿到 `BaseTool` 实例；
  2. `tool.validateArguments(args)` 用 Zod 校验入参；
  3. `await tool.execute(validatedArgs, context)` 执行；
  4. 截断超过 `maxResultChars`（默认 16000 字符）的输出，并把执行记录推入 `executionHistory`。
- 异常会被捕获并转成 `{ is_error: true }` 的 `ToolResult`，**不会让 Agent 主循环崩溃**。

### 2.3 工具加载器：`ToolLoader`

[src/agent/tools/loader.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/loader.ts) 提供按分组、按 scope 装载工具的能力：

- `discover()`：枚举所有 13 个工厂函数返回的工具，按名字排序缓存。
- `load(registry, options)`：根据 `options` 的布尔开关选择加载哪些分组，跳过 scope 不匹配的工具，遇到重名会 warn 并覆盖。

`ToolLoaderOptions` 默认值（[loader.ts:86-101](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/loader.ts#L86-L101)）：

| 分组 | 默认 | 工具数 |
| --- | --- | --- |
| filesystem / shell / web / memory / cron / utilities / search | ✅ true | 4 + 1 + 2 + 5 + 3 + 1 + 2 = 18 |
| message / self / apply_patch / long_task | ✅ true | 1 + 1 + 1 + 2 = 5 |
| **spawn** | ❌ false | 1（默认不加载） |
| **exec_session** | ❌ false | 2（默认不加载） |

因此默认加载 **23 个工具**；如果显式打开 `spawn` 和 `exec_session`，则是 26 个。

`createDefaultToolRegistry`（[registry.ts:124-154](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/registry.ts#L124-L154)）是更精简的版本，只装 7 个核心分组（18 个工具），通常被 `AgentLoop` 和 `SubagentManager` 当作 fallback 使用。

---

## 三、工具执行流程

工具的真正调用发生在 [src/agent/runner.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts) 的 `AgentRunner.run()` 主循环中：

```
┌──────────────────────────────────────────────────────────────┐
│ for (iteration = 0; iteration < maxIterations; iteration++)  │
│   1. toolDefs = tools.getToolDefinitions()                   │
│   2. response = provider.complete/stream(messages, toolDefs) │  ← 模型选择工具
│   3. 把 assistant 消息（含 tool_calls）push 进 messages       │
│   4. 若无 tool_calls 且有 content → 结束循环，返回最终回复    │
│   5. 若有 tool_calls：                                        │
│      for each toolCall in response.tool_calls:               │
│        a. onToolStart 回调                                    │
│        b. args = parseToolArguments(toolCall.arguments)      │
│        c. 若是文件编辑类工具 → onFileEdit('start') 回调       │
│        d. result = await tools.executeTool(                  │
│              toolCall.name, toolCall.id, args, toolContext,  │
│              { maxResultChars }                               │
│           )                                                   │  ← 真正执行
│        e. onToolComplete / onToolError 回调                  │
│        f. toolResults.push({ role: 'tool',                   │
│              tool_call_id, content: result.content })         │
│      messages.push(...toolResults)                            │
│   6. 进入下一轮迭代，模型基于工具结果继续推理                  │
└──────────────────────────────────────────────────────────────┘
```

要点（参见 [runner.ts:134-330](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L134-L330)）：

1. **每个迭代都重新把工具定义发给模型**，模型自行决定是否调用以及调用哪个。
2. **工具调用是顺序执行的**（`for ... await`），同一轮里多个 tool_call 不会并发。
3. **文件编辑类工具**（`write_file` / `edit_file` / `apply_patch` / `delete_file` / `rename_file` / `create_directory` / `remove_directory`，定义见 [runner.ts:28-36](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L28-L36)）会额外触发 `onFileEdit` 回调，用于 WebUI 实时刷新。
4. 工具结果超过 `maxToolResultChars` 会被 `truncateText` 截断，并附 `[truncated from N chars]` 提示。
5. 达到 `maxIterations - 1` 仍未结束时，会注入一条 `buildGoalContinueMessage()` 让模型续跑。

### 3.1 HTTP 侧的对外事件

[src/api/server.ts](file:///Users/peroluo/Document/nanobot-ts/src/api/server.ts) 把 runner 的回调转成 SSE 事件流推给前端：

- `tool_started` — `onToolStart` 触发
- `tool_completed` — `onToolComplete` 触发
- `file_edit` — `onFileEdit` 触发，带 `tool_name / file_path / action`

工具本身在服务端进程内执行，前端只接收事件，不能直接调用工具。

---

## 四、完整工具清单（33 个内置工具）

### 4.1 文件系统（filesystem） — 4 个
源文件：[src/agent/tools/filesystem.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/filesystem.ts)

| 工具名 | 类 | 作用 |
| --- | --- | --- |
| `read_file` | `ReadFileTool` | 读取文件内容，支持 `offset / limit` 分页 |
| `write_file` | `WriteFileTool` | 写文件，支持 `append` 模式 |
| `list_dir` | `ListDirTool` | 列出目录内容，支持 glob 过滤 |
| `edit_file` | `EditFileTool` | 精确字符串替换（要求 `old_string` 唯一） |

### 4.2 Shell 执行（shell） — 1 个
源文件：[src/agent/tools/shell.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/shell.ts)

| 工具名 | 类 | 作用 |
| --- | --- | --- |
| `shell_exec` | `ShellExecTool` | 通过 `child_process.exec` 执行 shell 命令，默认 120 秒超时 |

### 4.3 Web 访问（web） — 2 个
源文件：[src/agent/tools/web.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/web.ts)

| 工具名 | 类 | 作用 |
| --- | --- | --- |
| `web_search` | `WebSearchTool` | 调用 DuckDuckGo API 搜索 |
| `web_fetch` | `WebFetchTool` | 抓取 URL 内容，自动剥离 HTML 标签 |

### 4.4 长期记忆（memory） — 5 个
源文件：[src/agent/tools/memory.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/memory.ts)

| 工具名 | 类 | 作用 |
| --- | --- | --- |
| `memory_store` | `MemoryStoreTool` | 写入 key-value 到 `<workspace>/memory/<key>.json` |
| `memory_recall` | `MemoryRecallTool` | 按 key 读取 |
| `memory_search` | `MemorySearchTool` | 在所有记忆条目里模糊搜索 |
| `memory_list` | `MemoryListTool` | 列出所有 key，支持前缀过滤 |
| `memory_delete` | `MemoryDeleteTool` | 删除指定 key |

### 4.5 定时任务（cron） — 3 个
源文件：[src/agent/tools/cron.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/cron.ts)，存储后端：[cron_store.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/cron_store.ts)

| 工具名 | 类 | 作用 |
| --- | --- | --- |
| `cron_list` | `CronListTool` | 列出所有定时任务 |
| `cron_add` | `CronAddTool` | 添加任务，支持 cron 表达式或 `every N<unit>` |
| `cron_remove` | `CronRemoveTool` | 按 ID 删除任务 |

### 4.6 系统工具（utilities） — 1 个
源文件：[src/agent/tools/utilities.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/utilities.ts)

| 工具名 | 类 | 作用 |
| --- | --- | --- |
| `system_info` | `SystemInfoTool` | 返回平台、CPU、内存、Node 版本等环境信息 |

### 4.7 代码搜索（search） — 2 个
源文件：[src/agent/tools/search.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/search.ts)

| 工具名 | 类 | 作用 |
| --- | --- | --- |
| `find_files` | `FindFilesTool` | 按路径片段/glob/类型查找文件，自动跳过 `node_modules` 等 |
| `grep` | `GrepTool` | 正则搜文件内容，支持 `content / files_with_matches / count` 三种输出模式 |

### 4.8 消息发送（message） — 1 个
源文件：[src/agent/tools/message.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/message.ts)

| 工具名 | 类 | 作用 |
| --- | --- | --- |
| `message` | `MessageTool` | 主动发消息到指定 channel/chat，支持附件和按钮，用于跨通道投递 |

### 4.9 自省（self） — 1 个
源文件：[src/agent/tools/self.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/self.ts)

| 工具名 | 类 | 作用 |
| --- | --- | --- |
| `my` | `MyTool` | `check / set` 自身运行时状态（模型、context window、迭代进度、scratchpad 等），带敏感字段黑名单和写权限校验 |

### 4.10 多块补丁（apply_patch） — 1 个
源文件：[src/agent/tools/apply_patch.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/apply_patch.ts)

| 工具名 | 类 | 作用 |
| --- | --- | --- |
| `apply_patch` | `ApplyPatchTool` | 一次对多个文件做 `replace / add` 编辑，支持 `dry_run` 预演 |

### 4.11 长任务目标（long_task） — 2 个
源文件：[src/agent/tools/long_task.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/long_task.ts)

| 工具名 | 类 | 作用 |
| --- | --- | --- |
| `create_goal` | `CreateGoalTool` | 创建持续型会话目标 |
| `update_goal` | `UpdateGoalTool` | 标记目标 `complete / cancel / block / replace` |

### 4.12 子 Agent（spawn） — 1 个  ⚠️ 默认关闭
源文件：[src/agent/tools/spawn.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/spawn.ts)

| 工具名 | 类 | 作用 |
| --- | --- | --- |
| `spawn` | `SpawnTool` | 派生子 Agent 异步执行任务，受 `max_concurrent_subagents` 限制 |

### 4.13 长会话进程（exec_session） — 2 个  ⚠️ 默认关闭
源文件：[src/agent/tools/exec_session.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/exec_session.ts)

| 工具名 | 类 | 作用 |
| --- | --- | --- |
| `write_stdin` | `WriteStdinTool` | 启动长驻进程并向 stdin 写入字符，可轮询输出 |
| `list_exec_sessions` | `ListExecSessionsTool` | 列出当前活跃的 exec session |

### 4.14 图像生成（image_generation） — 1 个  ⚠️ 不在默认 loader 里
源文件：[src/agent/tools/image_generation.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/image_generation.ts)

| 工具名 | 类 | 作用 |
| --- | --- | --- |
| `generate_image` | `ImageGenerationTool` | 调 OpenAI 兼容接口生成图像，支持参考图、比例、批量 |

### 4.15 任务调度器（scheduler） — 5 个  ⚠️ 不在默认 loader 里
源文件：[src/agent/tools/scheduler.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/scheduler.ts)

| 工具名 | 类 | 作用 |
| --- | --- | --- |
| `task_list` | `TaskListTool` | 列出调度器中的任务 |
| `task_add` | `TaskAddTool` | 添加 cron / once / interval 任务 |
| `task_remove` | `TaskRemoveTool` | 删除任务 |
| `task_cancel` | `TaskCancelTool` | 取消运行中任务 |
| `task_clear` | `TaskClearTool` | 清空所有任务 |

### 4.16 CLI 应用桥（cli_apps） — 1 个  ⚠️ 不在默认 loader 里
源文件：[src/agent/tools/cli_apps.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/cli_apps.ts)

| 工具名 | 类 | 作用 |
| --- | --- | --- |
| `run_cli_app` | `CliAppsTool` | 调用预注册的本地 CLI 应用（如 `gh`、`gimp`） |

> **小结**：
> - 默认 loader 自动加载 23 个（4.1–4.11 + 4.12/4.13 关闭）。
> - 4.14 / 4.15 / 4.16 共 7 个工具需要业务侧显式 `registry.registerMany(getXxxTools())` 才会启用。
> - 全部相加 = **33 个内置工具**。

---

## 五、MCP 动态工具

源文件：[src/agent/tools/mcp.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/mcp.ts)

MCP（Model Context Protocol）让外部进程作为工具源接入。`connectMcpServers(mcpServers, registry)`（[mcp.ts:630-697](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/mcp.ts#L630-L697)）的流程：

1. 对每个 MCP server 配置（`type: 'stdio' | 'sse' | 'streamableHttp'`）创建 session（目前实现仅支持 stdio，见 [mcp.ts:307-331](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/mcp.ts#L307-L331)）。
2. 调 `session.listTools()` 拿到远程工具定义，按 `enabled_tools` 白名单过滤。
3. 每个远程工具包成 `MCPToolWrapper`（[mcp.ts:368-477](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/mcp.ts#L368-L477)），重命名为 `mcp_<server>_<tool>`，注册进 registry。
4. 若白名单是 `['*']`，还会把 resources / prompts 也包成 `MCPResourceWrapper` / `MCPPromptWrapper` 注册进来。

执行时（[mcp.ts:418-461](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/mcp.ts#L418-L461)）：

- `MCPToolWrapper.execute` → `session.callTool(originalName, kwargs)`，带 `tool_timeout`（默认 30 秒）。
- 命中瞬态错误（`ClosedResourceError / ECONNRESET / ...`）会自动重连一次 + 重试一次。
- 返回的 `content` 数组里 text 块拼成字符串，image 块转成 `[Image: mime, N bytes]` 占位。

由于 MCP 工具数量取决于用户配置的 server，**总数不固定**，可在运行时通过 `registry.list()` 查询。

---

## 六、技能（Skills）系统

> 技能不是工具，而是文档化的「行为指南」。本节解释二者关系，避免混淆。

### 6.1 加载机制

[src/agent/skills.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/skills.ts) 的 `SkillLoader`：

1. `addSkillDir(dir)` 注册技能目录。
2. `load()` 遍历每个目录下的子目录，读取 `SKILL.md`。
3. `parseSkill()` 解析 YAML front matter（`name / description / tags / version`）和正文。
4. `buildSkillPrompt(skillNames)` 把指定技能的完整 Markdown 拼成一段 `# Skills\n\n## <name>\n\n<content>` 注入系统提示词。

模型读到这段提示词后，会学会「在 X 场景下应该调用 Y 工具组合」。**真正的执行仍然走第四节那些工具**。

### 6.2 内置技能清单（11 个）

位于 [skills/](file:///Users/peroluo/Document/nanobot-ts/skills)，每个子目录一份 `SKILL.md`：

| 技能 | 作用 |
| --- | --- |
| `clawhub` | 从 ClawHub 公共技能仓库搜索/安装技能 |
| `cron` | 安排提醒和周期任务 |
| `github` | 通过 `gh` CLI 操作 issue / PR / CI |
| `image-generation` | 生成图像并迭代编辑已保存的图像 |
| `memory` | 两层记忆系统，由 Dream 管理知识文件 |
| `my` | 自省并调整 Agent 运行时状态 |
| `skill-creator` | 创建或更新 AgentSkill |
| `summarize` | 摘要 URL / 播客 / 本地文件 |
| `tmux` | 远程控制 tmux 会话 |
| `update-setup` | 升级技能的一次性设置向导 |
| `weather` | 通过 wttr.in 查询天气 |

另外 `src/skills/skill-creator/` 下有 `init_skill.{ts,py}`、`package_skill.{ts,py}`、`quick_validate.{ts,py}` 脚本，是技能打包工具链。

---

## 七、整体调用链一图总结

```
用户消息
  │
  ▼
AgentLoop.processDirect()        src/agent/loop.ts
  │
  ▼
AgentRunner.run(spec)            src/agent/runner.ts
  │
  ├─ tools.getToolDefinitions()  → 把 BaseTool 转成 function-calling JSON
  ├─ provider.complete/stream()  → 模型返回 tool_calls
  │
  └─ for each tool_call:
       │
       ▼
     ToolRegistry.executeTool(name, id, args, ctx)   src/agent/tools/registry.ts
       │
       ├─ tool.validateArguments(args)  ← Zod 校验
       └─ tool.execute(args, ctx)       ← 真正执行
            │
            ├── 内置工具：直接调用 Node API（fs / child_process / axios / ...）
            ├── MCP 工具：session.callTool() → stdio → 子进程
            └── 返回 ToolResult { content, is_error, metadata }
       │
       ▼
     截断到 maxResultChars，写入 executionHistory
       │
       ▼
     push { role: 'tool', tool_call_id, content } 进 messages
       │
       ▼
   下一轮迭代，模型基于工具结果继续
```

---

## 八、如何扩展

### 8.1 新增内置工具

1. 在 `src/agent/tools/` 下新建 `my_tool.ts`，导出 `class MyTool extends BaseTool` 和 `getMyTools()`。
2. 在 [src/agent/tools/index.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/index.ts) 追加 `export`。
3. 在 [src/agent/tools/loader.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/loader.ts) 的 `toolFactories` 和 `toolGroups` 里加入新工厂，并在 `ToolLoaderOptions` 增加开关。
4. 若希望默认开启，把 `opts.xxx` 默认值设为 `true`。

### 8.2 接入 MCP 工具

在配置里加 `mcp_servers`，调用 `connectMcpServers(mcpServers, registry)` 即可，无需改代码。

### 8.3 新增技能

1. 在 `skills/` 下建 `<name>/SKILL.md`，写好 front matter 和正文。
2. 把目录加进 `SkillLoader.addSkillDir()`（项目默认就会扫 `skills/`）。
3. 模型即可在合适场景下根据技能文档调用对应工具。

---

## 九、参考索引

- 工具基类与接口：[src/agent/tools/base.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/base.ts)
- 注册与执行：[src/agent/tools/registry.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/registry.ts)
- 分组加载：[src/agent/tools/loader.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/loader.ts)
- Agent 主循环（工具调度）：[src/agent/runner.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts)
- MCP 集成：[src/agent/tools/mcp.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/mcp.ts)
- 技能加载：[src/agent/skills.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/skills.ts)
- 技能目录：[skills/](file:///Users/peroluo/Document/nanobot-ts/skills)
- HTTP 事件流：[src/api/server.ts](file:///Users/peroluo/Document/nanobot-ts/src/api/server.ts)

---

## 十、工具模块优化方案（提升 Agent 稳定性 + 降低 Token 成本）

> 以下方案均基于对 `src/agent/tools/` 和 `src/agent/runner.ts` 的实际代码审查，每条都标注了问题位置、改造方向和预期收益。按优先级分为 P0（高收益低风险，建议立即做）、P1（中收益需评估）、P2（长期重构）。

### P0 — 高优先级（Quick Win，Token 与稳定性双收益）

#### 10.1 缓存 `getToolDefinitions()`，避免每轮迭代重复序列化

**问题**：[runner.ts:142](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L142) 在 `for` 循环内每次都调用 `tools.getToolDefinitions()`，而 [registry.ts:48-59](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/registry.ts#L48-L59) 每次都重新遍历 `Map`、调用 `tool.getDefinition()` 和 `toProviderTool()`，并 new 一组 `ProviderToolDefinition` 对象。Zod → JSON Schema 的转换（[base.ts:71-136](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/base.ts#L71-L136)）每个工具每次都重做一遍。

**方案**：
- 在 `ToolRegistry` 内部加 `private _defsCache: ProviderToolDefinition[] | null = null`。
- `register / registerMany` 时置空缓存。
- `getToolDefinitions()` 命中缓存直接返回。
- `AgentRunner.run()` 在循环外取一次 `toolDefs`，循环内复用。

**预期收益**：单次迭代节省 23 次对象构造 + 23 次 Zod 转换；按 20 轮迭代算，每轮 23 工具，节省 ~460 次重复转换。Token 不变，但延迟和 CPU 显著下降，间接减少超时引发的 retry。

---

#### 10.2 精简过长的工具 description

**问题**：以下工具的 description 在每轮迭代都会被原样塞进 prompt，token 成本随迭代次数线性放大：

| 工具 | description 行数 | 字符数 | 位置 |
| --- | --- | --- | --- |
| `my` | ~22 行 | ~1.4 KB | [self.ts:89-109](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/self.ts#L89-L109) |
| `message` | ~12 行 | ~1.0 KB | [message.ts:49-59](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/message.ts#L49-L59) |
| `grep` | ~6 行 | ~0.5 KB | [search.ts:376-382](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/search.ts#L376-L382) |
| `find_files` | ~6 行 | ~0.4 KB | [search.ts:294-300](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/search.ts#L294-L300) |

23 个工具的 description 累计约 6–8 KB（≈ 1.5K–2K token），每个 iteration 都重发。

**方案**：
- description 精简到 1–2 句话（≤ 200 字符），只保留「做什么 + 何时用」。
- 详细用法、参数说明、示例移到对应 `skills/<name>/SKILL.md`，由 `SkillLoader` 在系统提示词里**只发一次**（而非每轮重发）。
- 或者把详细描述放进 Zod schema 的 `.describe()`（OpenAI function-calling 会把参数 description 单独序列化，模型在需要时才参考）。

**预期收益**：每轮迭代节省 ~1K token；20 轮 session 节省 ~20K token。对长会话收益更明显。

---

#### 10.3 统一并下调工具结果截断阈值

**问题**：截断阈值分散且过大：

| 位置 | 阈值 | 备注 |
| --- | --- | --- |
| [registry.ts:91](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/registry.ts#L91) | `maxResultChars = 16000` | 默认值，约 4K token / 单工具 |
| [search.ts:8](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/search.ts#L8) | `_MAX_RESULT_CHARS = 128_000` | grep 内部硬上限，约 32K token |
| [search.ts:9](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/search.ts#L9) | `_MAX_FILE_BYTES = 2_000_000` | 单文件 2 MB |
| [exec_session.ts:13](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/exec_session.ts#L13) | `MAX_OUTPUT_CHARS = 50000` | 单次 poll 50K 字符 |

`grep` 的 `_MAX_RESULT_CHARS = 128_000` 远超 registry 的 16K 上限，结果会先在 grep 内部拼到 128K 再被 registry 截到 16K，中间的拼接纯粹浪费 CPU 和内存。

**方案**：
- 在 [registry.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/registry.ts) 引入按工具类型的分级阈值：
  - 只读搜索类（`find_files / grep / list_dir`）：4K 字符
  - 读取类（`read_file / web_fetch`）：8K 字符
  - 执行类（`shell_exec / run_cli_app`）：6K 字符
  - 默认：8K 字符
- 工具内部不再做截断（移除 `_MAX_RESULT_CHARS`），统一交给 registry。
- `maxToolResultChars` 配置项保留，作为全局上限覆盖。

**预期收益**：单工具结果从最大 32K token 降到 ≤ 2K token；一次 grep 命中大量文件时节省的 token 尤其可观（曾观察到单次 grep 返回 80K 字符 ≈ 20K token）。

---

#### 10.4 `read_file` 加大小与二进制检查

**问题**：[filesystem.ts:36-54](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/filesystem.ts#L36-L54) 直接 `fs.readFile(filePath, 'utf-8')`，没有大小上限，没有二进制检测。对比 `grep` 工具有 `_MAX_FILE_BYTES` 和 `_isBinary` 保护（[search.ts:156-166](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/search.ts#L156-L166)）。

读到一个 5 MB 的日志或二进制文件会：1) OOM 风险；2) 把几 MB 垃圾塞进 messages 数组；3) 后续每轮迭代都带着这几 MB 上下文 → token 成本爆炸。

**方案**：
- `read_file` 先 `fs.stat` 检查大小，超过 1 MB 直接返回错误并提示用 `grep` 或 `offset/limit`。
- 复用 `search.ts` 的 `_isBinary` 逻辑（抽到 `path_utils.ts` 共享），命中二进制返回 `[Binary file, N bytes]`。
- `offset/limit` 缺省时强制上限 2000 行。

**预期收益**：消除单次工具调用把上下文撑爆导致的 OOM 和 token 失控；稳定性提升明显。

---

#### 10.5 `edit_file` 支持 `replace_all` 与 `occurrence_index`

**问题**：[filesystem.ts:149-152](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/filesystem.ts#L149-L152) 在 `old_string` 出现 ≥2 次时直接报错。模型常见反应是再加更多上下文重试 → 多轮 token 消耗，且不一定成功。

**方案**：
- 入参增加 `replace_all?: boolean` 和 `occurrence_index?: number`。
- 默认行为不变（保持唯一性约束的稳定性）。
- 显式传 `replace_all: true` 时全量替换；传 `occurrence_index: N` 时替换第 N 次出现。

**预期收益**：减少编辑类工具的 retry 轮次；每个 retry 节省 ~1K token（重新读文件 + 重新构造 old_string）。

---

### P1 — 中优先级（收益明确，需评估改动范围）

#### 10.6 只读工具并发执行

**问题**：[runner.ts:233](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L233) 对 `response.tool_calls` 是 `for ... await` 串行执行。同一轮里多个独立的 `read_file` 或 `find_files` 本可并发，串行会让 agent 循环延迟叠加。

**方案**：
- 给 `BaseTool` 加 `readonly sideEffect: boolean` 字段（默认 `true`，只读工具显式标 `false`）。
- 在 `AgentRunner.run` 里把同一批 `tool_calls` 按 `sideEffect` 分组：无副作用组用 `Promise.all` 并发，有副作用组保持串行。
- 候选并发工具：`read_file / list_dir / find_files / grep / memory_recall / memory_list / memory_search / system_info / web_search / web_fetch / my (action=check) / list_exec_sessions / task_list / cron_list`。

**预期收益**：典型「读 5 个文件」场景从 5×100ms 降到 ~100ms；并发不增加 token，但减少 wall-clock 让用户感知更流畅，间接减少超时 retry。

---

#### 10.7 只读工具结果 LRU 缓存

**问题**：同一 session 内多次 `read_file` 同一文件、多次 `find_files` 同一目录，每次都重做 I/O 且把同样内容重新塞进 messages → 重复 token。

**方案**：
- 引入 `ToolResultCache`，key = `${toolName}:${stableHash(args)}:${fileMtime}`。
- 对只读工具（同 10.6 的候选集）启用缓存，LRU 容量 64 条，TTL 60s。
- 复用已有的 [file_state.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/file_state.ts) `FileStates` 追踪文件变更，写入工具（`write_file / edit_file / apply_patch`）执行后失效对应路径的缓存。
- 缓存命中时返回 `content` + `metadata: { cached: true }`。

**预期收益**：典型「读 → 改 → 再读确认」流程节省一次重复读取的 token；长 session 内重复 `find_files` 收益更大。

---

#### 10.8 `shell_exec` 默认超时下调 + 输出 tail 截断

**问题**：
- [shell.ts:20](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/shell.ts#L20) `defaultTimeout = 120` 秒，长命令会阻塞整个 agent 循环 2 分钟，期间无法响应用户。
- [shell.ts:36-37](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/shell.ts#L36-L37) 把 `stdout + stderr` 全量返回，长输出（如 `npm install` 日志）容易超 token。
- 失败时 [shell.ts:39-44](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/shell.ts#L39-L44) 把 stdout/stderr/timeout 全拼一起，输出更长。

**方案**：
- 默认超时下调到 30 秒，配置项保留可覆盖。
- 输出超过 4K 字符时只保留 head 1K + tail 2K + `[truncated N chars in middle]`。
- 失败时只返回最后 2K stderr + exit code，不拼 stdout。
- 在 description 里明确：「长任务请改用 `write_stdin`（exec_session）」。

**预期收益**：避免单次 shell 调用阻塞 2 分钟；典型 `npm install` 输出从 ~30K 字符降到 3K，节省 ~7K token/次。

---

#### 10.9 `web_search` 接入高质量搜索后端

**问题**：[web.ts:28-36](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/web.ts#L28-L36) 用 DuckDuckGo Instant Answer API，该接口众所周知返回稀少（多数 query 返回空 `AbstractText` 和空 `RelatedTopics`）。无结果时模型倾向于换关键词重试 → 多轮 token 浪费。

**方案**：
- 抽象 `SearchProvider` 接口，支持 `ddg / serper / tavily / brave` 多后端。
- 默认仍 ddg（零配置），但配置文件里可选切换。
- 无结果时返回明确信号 `No results. Consider rephrasing or switch provider via my(set web_config.search_provider).`，避免模型盲目重试。
- 配合 [self.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/self.ts) 暴露 `web_config.search_provider` 切换（目前 `web_config` 是 read-only，见 [self.ts:30-37](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/self.ts#L30-L37)，需要开放写入）。

**预期收益**：搜索类任务的平均轮次从 3+ 降到 1–2 轮；每轮节省 ~1.5K token。

---

#### 10.10 `web_fetch` 用 Markdown 提取替代朴素正则

**问题**：[web.ts:110-124](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/web.ts#L110-L124) 用一连串正则剥 HTML：`replace(/<script.*?<\/script>/gi, '')` → `replace(/<[^>]*>/g, ' ')` → 实体解码。对真实页面（嵌套表格、`<pre>`、导航栏）效果差，返回大量导航/广告噪声，信噪比低 → token 浪费在无用内容上。

**方案**：
- 引入 `cheerio` 或 `@mozilla/readability` + `turndown`。
- 提取主内容后转 Markdown，保留代码块和表格的语义结构。
- 默认 `max_length` 从 8000 降到 4000（信噪比提升后 4K 足够）。

**预期收益**：相同 token 预算下模型能看到 2–3 倍有效信息；典型场景每轮节省 ~2K token 的噪声。

---

#### 10.11 统一 `AgentLoop` 默认 registry 与 `ToolLoader` 默认配置

**问题**：[loop.ts:58](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts#L58) 用 `createDefaultToolRegistry()` 作 fallback，只装 7 个分组（18 个工具）；而 [loader.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/loader.ts) 的 `ToolLoader` 默认装 23 个。这意味着默认 `AgentLoop` 实例里 **没有** `message / my / apply_patch / create_goal / update_goal` 等工具，但 [subagent.ts:117](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts#L117) 子 Agent 也用同一个 fallback。

用户/技能文档里期望 `my` 工具可用（如 `skills/my/SKILL.md`），实际默认场景下不可用 → 模型尝试调用报 `Unknown tool` → retry → token 浪费 + 体验损坏。

**方案**：
- 把 `AgentLoop` 和 `SubagentManager` 的 fallback 改为 `new ToolLoader().load(new ToolRegistry())`。
- 或者在 `createDefaultToolRegistry` 里把 7 个分组扩到 11 个（加上 `message / self / apply_patch / long_task`）。
- 启动时 log 实际注册的工具列表，方便排查。

**预期收益**：消除「技能文档说有 X 工具，实际没有」的不一致；减少 `Unknown tool` 错误引发的 retry。

---

### P2 — 长期重构（收益大但改动大）

#### 10.12 工具选择优化（按 query 预筛工具子集）

**问题**：每个 iteration 把全部 23+ 工具定义发给模型（≈ 6–8 KB）。在「用户只是问个天气」的场景下，`apply_patch / spawn / write_stdin / cron_add` 等工具的定义纯属 token 浪费，还会诱导模型误调用。

**方案**：
- 离线对每个工具的 `name + description + tags` 做 embedding。
- 用户消息进来时，取 top-K（K=8–10）最相关工具发给模型。
- 保留一组「始终可用」的核心工具（`my / message / read_file / shell_exec`）。
- 模型若发现需要的工具不在子集，可通过 `my` 工具请求扩展（类似 function-calling 的二级加载）。

**预期收益**：每轮迭代工具定义从 ~2K token 降到 ~700 token；长 session 收益线性放大。需要权衡：工具预筛错误会导致模型拿不到合适工具。

---

#### 10.13 Zod → JSON Schema 改用成熟库

**问题**：[base.ts:71-136](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/base.ts#L71-L136) 手写的 `zodToJsonSchema` 不支持 `ZodDefault / ZodUnion / ZodIntersection / ZodRecord / ZodTuple` 等，遇到这些类型回退成 `type: 'string'`，模型拿到的 schema 不准 → 参数错误 → retry。

**方案**：
- 替换为 `zod-to-json-schema` 库（成熟、维护活跃）。
- 或在 `BaseTool` 构造时一次性转好并缓存（配合 10.1）。
- MCP 工具的 [_normalizeSchemaForOpenAI](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/mcp.ts#L86-L134) 也可统一复用。

**预期收益**：减少因 schema 误导导致的参数错误 retry；schema 更紧凑（可选字段不再被误标 required），节省少量 token。

---

#### 10.14 `find_files / grep` 接入 ripgrep 与 `.gitignore`

**问题**：[search.ts:230-289](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/search.ts#L230-L289) 手写递归遍历，硬编码 `_IGNORE_DIRS`（[search.ts:34-38](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/search.ts#L34-L38)）。不读 `.gitignore`，会把 `dist/ build/` 之外的忽略目录（如 `.next/ coverage/ *.min.js`）也扫进来，结果集膨胀 → token 浪费。

**方案**：
- 优先调用 `rg --files` 和 `rg <pattern>` 子进程（项目已要求环境装 ripgrep）。
- 退化路径保留现有实现。
- 或集成 `ignore` npm 库读 `.gitignore`。

**预期收益**：大仓库（10K+ 文件）下搜索结果从几百条降到几十条；节省 token + 提升准确性。

---

#### 10.15 MCP 工具加 Zod 校验

**问题**：[mcp.ts:414-416](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/mcp.ts#L414-L416) `validateArguments` 直接 `return args`，模型传错参数会到 MCP 子进程才报错，浪费一次完整往返（含子进程 RPC + 重试逻辑）。

**方案**：
- 启动时把 MCP `inputSchema`（已是 JSON Schema）转成 Zod（用 `json-schema-to-zod` 或手写转换器）。
- 或退而求其次：校验 `required` 字段存在性 + 顶层类型，不追求完整覆盖。

**预期收益**：减少 MCP 子进程无效调用；错误信息更友好（`missing required field: foo` vs 子进程异常栈）。

---

#### 10.16 工具结果结构化压缩

**问题**：所有工具结果都压成 `string`（[base.ts:29-33](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/base.ts#L29-L33)），即使是结构化数据（如 `find_files` 的路径列表、`system_info` 的环境信息）也用 `\n` 拼字符串。模型要重新解析，且重复的 prefix（每行 `file `、`dir `）占用 token。

**方案**：
- `ToolResult` 增加 `structured?: unknown` 字段，存原始结构化数据。
- Provider 侧根据模型能力决定如何序列化：
  - 支持 OpenAI vision/structured output 的模型，直接用 JSON 块（更紧凑）。
  - 不支持的退化到文本。
- 文本序列化时用更紧凑的格式（如 `find_files` 结果用 `\n` 分隔路径，去掉 `file /dir ` 前缀，改用末尾 `/` 标记目录）。

**预期收益**：结构化结果 token 减少 20–30%；模型解析准确性提升。

---

### 实施建议（按工作量与收益排序）

| 阶段 | 任务 | 预计工作量 | 预期 Token 节省 |
| --- | --- | --- | --- |
| 第 1 周 | 10.1 缓存 toolDefs + 10.2 精简 description + 10.3 统一截断阈值 | 1–2 人日 | 每轮迭代 -1.5K token |
| 第 1 周 | 10.4 read_file 大小检查 + 10.5 edit_file replace_all | 0.5 人日 | 消除 OOM 风险 + 编辑 retry -50% |
| 第 2 周 | 10.8 shell_exec 超时下调 + 10.10 web_fetch Markdown 化 | 1 人日 | shell/web 类每次 -5K token |
| 第 2 周 | 10.11 统一默认 registry | 0.5 人日 | 消除 Unknown tool retry |
| 第 3 周 | 10.6 只读工具并发 + 10.7 结果缓存 | 2–3 人日 | 延迟 -30%，重复调用 token -50% |
| 第 4 周 | 10.9 搜索后端可切换 + 10.13 zod-to-json-schema | 2 人日 | 搜索轮次 -50%，schema 错误 -80% |
| 长期 | 10.12 工具预筛 + 10.14 ripgrep + 10.15 MCP 校验 + 10.16 结构化压缩 | 5–8 人日 | 每轮再 -1K token，准确性显著提升 |

### 量化预期

对一个典型 20 轮迭代的 session（每轮 23 工具定义 + 平均 2 次工具调用）：

- **优化前**：约 60K–80K token 用于工具相关（定义 + 结果 + retry）
- **完成 P0 + P1 后**：约 30K–40K token，节省 **45–50%**
- **完成 P2 后**：约 20K–25K token，累计节省 **60–70%**

稳定性方面：P0 中的 10.4（read_file 大小检查）和 10.11（统一 registry）直接消除两类高发故障模式（OOM、Unknown tool retry），收益最直接。

---

### 10.17 按需加载工具（独立专题，建议升级为 P0）

> 这是对原 10.12 的展开。原方案放在 P2 是低估了——按需加载是**单点 ROI 最高**的优化：实现成本可控，token 收益最大，且与其他方案正交可叠加。建议从 P2 提到 P0。

#### 为什么按需加载是最高 ROI

每轮迭代 [runner.ts:142](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L142) 把 registry 里**全部**工具定义发给模型。23 个工具 ≈ 6–8 KB ≈ 1.5K–2K token，20 轮 session 就是 30–40K token 纯工具定义开销。

更糟的是工具越多，模型误调用概率越高（在「读个文件」场景看到 `cron_add` 也会考虑要不要用）→ retry → 进一步放大 token。

**按需加载的本质**：把「23 个工具全发」变成「只发本次大概率用到的 5–8 个」。

#### 当前基础设施盘点（好消息）

源码已经为按需加载预留了字段，无需大改：

1. **`BaseTool.tags`** — [base.ts:47](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/base.ts#L47)，每个工具都已打标（如 `['filesystem', 'read']`、`['cron']`、`['memory']`）。
2. **`BaseTool.scope`** — [base.ts:48](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/base.ts#L48)，已有按 scope 过滤的逻辑（[loader.ts:122-125](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/loader.ts#L122-L125)），但只在启动时静态生效。
3. **`ToolLoaderOptions`** — [loader.ts:23-38](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/loader.ts#L23-L38)，已有分组布尔开关，但同样是启动时一次性决定。
4. **`ToolRegistry.getToolDefinitions()`** — [registry.ts:48-59](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/registry.ts#L48-L59)，目前返回**全部**工具定义，是改造成「按 query 返回子集」的天然切入点。

#### 四级实现策略（按工作量递增，可叠加）

##### L1 — 场景路由（0.5 人日，纯静态分组）

按 `channel` / 任务类型在启动时选不同工具子集：

```ts
// src/agent/loop.ts 构造函数里
const toolProfile = this.config.tools?.profile
  ?? (channel === 'cli' ? 'developer' : 'chat');

const loaderOpts: ToolLoaderOptions = {
  // 'developer' profile: CLI 编程场景，专注代码操作
  developer: { filesystem: true, shell: true, search: true, memory: true,
               apply_patch: true, self: true, spawn: true,
               message: false, cron: false, long_task: false, web: false },
  // 'chat' profile: 普通对话场景，专注交互
  chat:       { filesystem: false, shell: false, search: false, memory: true,
               message: true, self: true, web: true, utilities: true,
               apply_patch: false, spawn: false, long_task: false, cron: true },
  // 'full' profile: 当前默认行为
  full:       { /* 全部 true */ },
}[toolProfile];

new ToolLoader().load(this.toolRegistry, loaderOpts);
```

**收益**：CLI 场景从 23 工具降到 ~12，每轮 -3K token；WebUI 闲聊场景降到 ~8，每轮 -4K token。

**局限**：粒度粗，开发者偶尔需要 `web_search` 时没有。

---

##### L2 — Query 关键词 → tag 动态选择（1–2 人日，推荐主力方案）

在 `AgentRunner.run` 入口解析用户消息，命中关键词则把对应 tag 的工具加入本轮工具集。核心改动只在 runner 和 registry 各加一个方法：

```ts
// src/agent/tools/registry.ts 新增
getToolDefinitionsByTags(tags: string[]): ProviderToolDefinition[] {
  const tagSet = new Set(tags);
  const defs: ProviderToolDefinition[] = [];
  for (const tool of this.tools.values()) {
    // 始终包含的工具（核心 5 个）
    if (ALWAYS_ON_TOOLS.has(tool.name)) {
      defs.push(this._toDef(tool));
      continue;
    }
    // 命中任一 tag 即加入
    if (tool.tags.some(t => tagSet.has(t))) {
      defs.push(this._toDef(tool));
    }
  }
  return defs;
}

const ALWAYS_ON_TOOLS = new Set(['my', 'message', 'read_file', 'shell_exec', 'find_files']);

// src/agent/runner.ts 入口处
const QUERY_TAG_RULES: Array<[RegExp, string[]]> = [
  [/写|修改|编辑|write|edit|patch|refactor/i, ['filesystem', 'edit', 'patch']],
  [/搜索|查找|grep|find|search|look/i,        ['search', 'filesystem']],
  [/定时|cron|schedule|reminder/i,            ['cron']],
  [/记忆|memory|remember/i,                   ['memory']],
  [/图片|image|draw|图|画/i,                  ['image', 'generation']],
  [/goal|目标|任务/i,                          ['goal', 'long_task']],
  [/子agent|subagent|spawn/i,                 ['subagent', 'spawn']],
  [/网页|url|http|browse/i,                   ['web']],
  [/cli|命令行|tmux|gh /i,                    ['cli', 'apps', 'exec']],
];

function pickTagsFromQuery(query: string): string[] {
  const tags = new Set<string>();
  for (const [re, ts] of QUERY_TAG_RULES) {
    if (re.test(query)) ts.forEach(t => tags.add(t));
  }
  return [...tags];
}

// run() 主循环内
const dynamicTags = pickTagsFromQuery(lastUserMessage);
const toolDefs = tools.getToolDefinitionsByTags(dynamicTags);
// 之后传给 provider.complete/stream
```

**收益**：典型场景 23 → 6–8 工具，每轮 -4K token；20 轮 session 省 ~80K token。误调用率显著下降。

**优势**：纯字符串匹配，零依赖；规则可配置化（移到 `config/tools.json`）；tags 字段已存在无需改工具代码。

**注意**：关键词规则要定期 review，漏判会让模型拿不到关键工具。建议加 fallback：若本轮工具 < 5 个，自动补齐 ALWAYS_ON_TOOLS。

---

##### L3 — 模型自举二级加载（2–3 人日，处理长尾需求）

模型在对话中发现需要某个未加载的工具时，通过 `my` 工具主动请求加载。改造点：

1. 扩展 `MyToolSchema` 增加 `action: 'load_tools'`，参数 `value: string[]`（工具组名）。
2. `AgentRunner` 在 `executeTool` 后检查是否调用了 `my(action=load_tools)`，若是则动态 `registry.register` 对应组。
3. 下一轮迭代 `getToolDefinitions` 自动包含新工具。

```ts
// self.ts 扩展 schema
const MyToolSchema = z.object({
  action: z.enum(['check', 'set', 'load_tools']),
  key: z.string().optional(),
  value: z.union([z.string(), z.number(), z.array(z.string())]).optional(),
});

// runner.ts 在 tool 执行后
if (toolCall.name === 'my') {
  const parsed = parseToolArguments(toolCall.arguments);
  if (parsed?.action === 'load_tools' && Array.isArray(parsed.value)) {
    const loader = new ToolLoader();
    loader.load(tools, Object.fromEntries(
      parsed.value.map(g => [g, true])
    ));
    // 下一轮 toolDefs 会自动包含新工具
  }
}
```

**收益**：默认只装 5 个核心工具（每轮 -6K token），长尾需求由模型自举覆盖。

**风险**：模型可能不知道有哪些组可加载 → 需要在系统提示词里列出可用工具组清单。可让 `my(action=check, key='available_tool_groups')` 返回清单。

---

##### L4 — Embedding 语义匹配（5+ 人日，原 10.12 方案）

离线对 `tool.name + tool.description + tool.tags` 做 embedding 存表；运行时对 query embedding 后取 top-K（K=8）。

适合工具数 > 50 的场景（含大量 MCP 工具时）。对当前 23 个内置工具而言，L2 已经能覆盖 80% 收益，L4 边际收益有限。

#### 与其他优化的叠加效应

| 叠加方案 | 单独收益 | 叠加后每轮 token |
| --- | --- | --- |
| 现状（23 工具全发） | — | ~2K |
| L2 按需加载 | -1.4K | ~600 |
| L2 + 10.2 精简 description | -1.6K | ~400 |
| L2 + 10.2 + 10.7 结果缓存 | -1.8K | ~200 等效 |
| L2 + L3 二级加载 | -1.7K | ~300 |

#### 推荐落地路径

1. **第 1 周**：先做 L1（场景路由），0.5 人日，立即拿到 -3K token/轮。
2. **第 2 周**：做 L2（query 关键词 → tag），1–2 人日，再降 -1K token/轮。规则放配置文件，可热更新。
3. **第 4 周**：评估 L3（模型自举），处理长尾。如果 L2 覆盖率 > 90% 可暂缓。
4. **长期**：工具数显著增长（MCP 接入多个 server）后再上 L4。

#### 与 10.12 的关系

本节是 10.12 的展开和升级：10.12 只提了 L4 一种实现，本节给出 L1–L3 三种更轻量的前置方案。**实施时以本节为准，10.12 视为 L4 的引用**。
