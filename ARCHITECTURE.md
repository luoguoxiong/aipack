# Nanobot 架构与执行流程说明

> 本文档说明 nanobot-ts 项目的 Agent 架构（单 Agent 还是多 Agent），以及用户输入一段话后整个系统的执行流程，并附带关键代码位置引用，方便定位与二次开发。

---

## 一、结论：单 Agent + 按需子 Agent（非对等多 Agent）

Nanobot 是 **"单主 Agent + 按需子 Agent"** 的架构，而不是对等协作的多 Agent 系统（Multi-Agent System）。

| 维度 | 说明 |
|------|------|
| 主 Agent | 全局唯一一个 [AgentLoop](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts#L45)，每个会话（session）串行处理一条用户消息 |
| 执行内核 | [AgentRunner.run](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L73) 是经典的 ReAct 工具调用循环（LLM → tool_calls → 执行 → 回填 → 再 LLM） |
| 子 Agent | **不是常驻**，仅当主 Agent 调用 `spawn` 工具时才由 [SubagentManager](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts#L62) 在后台拉起一个独立任务，跑完通过消息总线把结果回送给主 Agent |
| 并发模型 | 子 Agent 并发数受 `max_concurrent_subagents` 限制（默认 1，见 [subagent.ts:85](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts#L85)） |
| 通信方式 | 子 Agent 不与主 Agent 直接对话，只通过 [MessageBus](file:///Users/peroluo/Document/nanobot-ts/src/bus/queue.ts#L62) 异步投递 `inbound_message` 事件（见 [subagent.ts:304](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts#L304)） |

**一句话总结**：用户面对的始终是同一个主 Agent；主 Agent 在需要时可以"派活"给后台子 Agent，子 Agent 跑完把结果以"新消息"的形式塞回会话里，主 Agent 再据此继续。

---

## 二、核心组件总览

```
┌────────────────────────────────────────────────────────────────────┐
│                         入口层 (Entry Layer)                        │
│  CLI (cli/commands.ts)  WebUI WS (/api/ws/chat)  HTTP (/v1/chat/*) │
│  Channels: Telegram / Discord / Slack / Feishu / WeCom / ... 20+   │
└──────────────┬───────────────────────────┬──────────────────────────┘
               │                           │
               ▼                           ▼
        ┌──────────────┐          ┌─────────────────┐
        │   Nanobot    │          │   MessageBus    │
        │ (nanobot.ts) │          │  (bus/queue.ts) │
        └──────┬───────┘          └────────┬────────┘
               │ run() / stream()          │ inbound_message
               ▼                           ▼
        ┌──────────────────────────────────────────────┐
        │              AgentLoop (单主)                │
        │               (agent/loop.ts)                │
        │  processDirect() ──► 构造上下文 ──► 调 Runner │
        └──────┬───────────────────────────┬───────────┘
               │                           │
               ▼                           ▼
   ┌───────────────────────┐    ┌────────────────────────┐
   │    AgentRunner        │    │   SubagentManager      │
   │ ReAct 工具调用循环    │    │   (按需 spawn 子任务)  │
   │  (agent/runner.ts)    │    │   (agent/subagent.ts)  │
   └──────┬────────────────┘    └──────┬─────────────────┘
          │ 调用工具                  │ spawn 工具触发
          ▼                           ▼
   ┌──────────────────────────────────────────────────────┐
   │              ToolRegistry (工具注册表)               │
   │ filesystem / shell / web / search / memory / cron    │
   │ image_gen / mcp / sandbox / apply_patch / long_task  │
   │ spawn / exec_session / message / cli_apps / util ... │
   └──────────────────────────────────────────────────────┘
```

### 关键文件速查

| 组件 | 文件 | 关键行 |
|------|------|--------|
| SDK 入口 | [src/index.ts](file:///Users/peroluo/Document/nanobot-ts/src/index.ts) | L1-L40 |
| 顶层封装 | [src/nanobot.ts](file:///Users/peroluo/Document/nanobot-ts/src/nanobot.ts) | `Nanobot.run` L134、`Nanobot.stream` L156 |
| 主 Agent 循环 | [src/agent/loop.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts) | `AgentLoop` L45、`processDirect` L115、`handleInboundMessage` L234 |
| Runner（ReAct 内核） | [src/agent/runner.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts) | `AgentRunner.run` L73、循环体 L134-L330 |
| 子 Agent 管理 | [src/agent/subagent.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts) | `SubagentManager` L62、`spawn` L120、`_runSubagent` L198、`_announceResult` L271 |
| spawn 工具 | [src/agent/tools/spawn.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/spawn.ts) | `SpawnTool.execute` L54 |
| 上下文/系统提示 | [src/agent/context.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/context.ts) | `ContextBuilder.buildSystemPrompt` L29 |
| 消息总线 | [src/bus/queue.ts](file:///Users/peroluo/Document/nanobot-ts/src/bus/queue.ts) | `MessageBus` L62 |
| HTTP/WebSocket API | [src/api/server.ts](file:///Users/peroluo/Document/nanobot-ts/src/api/server.ts) | chat WS L834、`/v1/chat/completions` L556 |
| CLI 命令 | [src/cli/commands.ts](file:///Users/peroluo/Document/nanobot-ts/src/cli/commands.ts) | `run` 命令 |

---

## 三、用户输入一段话的完整执行流程

下面以 **WebUI 聊天** 为例（最常用入口），完整追踪一句话从输入到响应的路径。其它入口只在"消息如何进入 AgentLoop"这一步略有不同，后续流程完全一致。

### 3.1 流程总览（ASCII 时序图）

```
 浏览器/WebUI              API Server                Nanobot              AgentLoop             AgentRunner            ToolRegistry / Provider
     │                         │                        │                     │                       │                        │
     │  WS msg {type:message}  │                        │                     │                       │                        │
     ├────────────────────────►│                        │                     │                       │                        │
     │                         │  bot.stream(content,   │                     │                       │                        │
     │                         │     {sessionKey, ...}) │                     │                       │                        │
     │                         ├───────────────────────►│                     │                       │                        │
     │                         │                        │ loop.processDirect()│                       │                        │
     │                         │                        ├────────────────────►│                       │                        │
     │                         │                        │                     │ 1. 取历史消息         │                        │
     │                         │                        │                     │ 2. 构造 system prompt │                        │
     │                         │                        │                     │ 3. runner.run({msg,   │                        │
     │                         │                        │                     │     tools, runtime})  │                        │
     │                         │                        │                     ├──────────────────────►│                        │
     │                         │                        │                     │                       │ ┌──┐ 迭代 0..N:         │
     │                         │                        │                     │                       │ │  │ provider.stream()  │
     │                         │                        │                     │                       │ │  ├───────────────────►│
     │                         │                        │                     │                       │ │  │◄─ text_delta ──────┤
     │                         │                        │                     │                       │ │  │◄─ tool_calls ──────┤
     │                         │                        │                     │                       │ │  │                    │
     │                         │                        │                     │                       │ │  │ 有 tool_calls?     │
     │                         │                        │                     │                       │ │  │  是→ 执行工具      │
     │                         │                        │                     │                       │ │  │     tools.execute()│
     │                         │                        │                     │                       │ │  │  否→ finalContent  │
     │                         │                        │                     │                       │ │  │     break          │
     │                         │                        │                     │                       │ └──┘                    │
     │                         │                        │                     │◄─result───────────────┤                        │
     │                         │                        │ 4. 写历史消息       │                       │                        │
     │                         │                        │   sessionManager    │                       │                        │
     │                         │  StreamEvent 流        │◄────────────────────┤                       │                        │
     │                         │  (text_delta/tool_*)   │                     │                       │                        │
     │ ◄─ WS event: delta ─────┤                        │                     │                       │                        │
     │ ◄─ WS event: tool_* ────┤                        │                     │                       │                        │
     │ ◄─ WS event: turn_end ──┤                        │                     │                       │                        │
```

### 3.2 逐步详解

#### 第 1 步：消息接入（Entry）

WebUI 通过 WebSocket 连接到 `/api/ws/chat`，发送 `{type: 'message', chat_id, content}`：

- WS 连接处理见 [src/api/server.ts:834](file:///Users/peroluo/Document/nanobot-ts/src/api/server.ts#L834)
- 收到 `type === 'message'` 后调用 `this.bot.stream(content, {...})`，见 [server.ts:887](file:///Users/peroluo/Document/nanobot-ts/src/api/server.ts#L887)

其它入口等价路径：

| 入口 | 触发代码 | 调用方法 |
|------|----------|----------|
| CLI `nanobot run <msg>` | [cli/commands.ts](file:///Users/peroluo/Document/nanobot-ts/src/cli/commands.ts) `run` 命令 | `bot.run()` 或 `bot.stream()` |
| OpenAI 兼容 HTTP | [server.ts:556](file:///Users/peroluo/Document/nanobot-ts/src/api/server.ts#L556) `POST /api/v1/chat/completions` | `bot.run()` / `bot.stream()` |
| 渠道（Telegram 等） | [src/channels/](file:///Users/peroluo/Document/nanobot-ts/src/channels) 收消息 → `bus.publish(inbound_message)` → [loop.ts:218](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts#L218) `bus.onInboundMessage` | `loop.processDirect()` |

#### 第 2 步：Nanobot 顶层封装

[`Nanobot.stream()`](file:///Users/peroluo/Document/nanobot-ts/src/nanobot.ts#L156)（[nanobot.ts:156](file:///Users/peroluo/Document/nanobot-ts/src/nanobot.ts#L156)）：

1. 推送 `run_started` 事件（L200）
2. 在后台启动 `this.loop.processDirect(message, options)`（L211）
3. 通过 `pushEvent` 队列把 `text_delta` / `tool_started` / `tool_completed` / `file_edit` / `run_completed` / `run_failed` 等事件 yield 给调用方（L247-L274）

`Nanobot.run()`（[nanobot.ts:134](file:///Users/peroluo/Document/nanobot-ts/src/nanobot.ts#L134)）是其非流式版本，内部也是调 `processDirect`。

#### 第 3 步：AgentLoop.processDirect —— 主 Agent 的核心入口

[`AgentLoop.processDirect`](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts#L115)（[loop.ts:115](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts#L115)）按顺序做 4 件事：

1. **解析 Runtime / Provider**（L125-L129）
   根据 `model` / `model_preset` 配置确定调用哪个 LLM Provider，见 `getLLMRuntime` [loop.ts:81](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts#L81)。

2. **加载会话历史并拼装消息**（L133-L155）
   ```ts
   const history = await this.sessionManager.getMessages(sessionKey);          // 历史消息
   const userMessage = { role: 'user', content: message };                     // 当前用户消息
   const allMessages = [...historyProviderMessages, userMessage];
   const systemWithContext = contextBuilder.buildSystemPrompt();               // 系统提示
   const messagesWithSystem = [{role:'system',...}, ...allMessages];
   ```
   系统提示由 [ContextBuilder](file:///Users/peroluo/Document/nanobot-ts/src/agent/context.ts#L17) 拼接：身份信息 + 工具策略 + 平台策略 + Skills 段落 + 长期记忆 + 运行时信息（见 [context.ts:29](file:///Users/peroluo/Document/nanobot-ts/src/agent/context.ts#L29)）。

3. **交给 AgentRunner 跑 ReAct 循环**（L157-L173）
   ```ts
   const result = await this.runner.run({
     initialMessages: messagesWithSystem,
     tools: this.toolRegistry,
     runtime, provider,
     maxIterations: this.config.agents.defaults.max_tool_iterations,
     ...
   });
   ```

4. **持久化新历史 + 返回结果**（L175-L211）
   从 `result.messages` 里取出从用户消息开始的新增部分，写回 `sessionManager`，最后返回 `ProcessDirectResult`。

#### 第 4 步：AgentRunner.run —— ReAct 工具调用循环

[`AgentRunner.run`](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L73)（[runner.ts:73](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L73)）是整个 Agent 的"心脏"，是一个最多 `maxIterations` 轮的 for 循环（[L134](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L134)）：

```
for iteration in 0..maxIterations:
    1. 调 LLM: provider.stream(messages, toolDefs, runtime, streamCallback)
       (或 provider.complete 非流式)  —— runner.ts:144-163
    2. 累加 token usage                              —— L165
    3. 构造 assistant 消息并 push 进 messages         —— L190-191
    4. 分支判断:
       (a) 无 tool_calls 且有内容  → finalContent = content; break  —— L196-212
       (b) 无 tool_calls 且无内容  → 长度恢复 / 空回复重试 / break   —— L214-228
       (c) 有 tool_calls           → 逐个执行工具                   —— L230-329
            - onToolStart 事件
            - FILE_EDIT_TOOLS 触发 onFileEdit(start)
            - tools.executeTool(name, id, args, ctx)                —— L265-271
            - 成功/失败 → onToolComplete / onToolError
            - 把 tool 结果以 role:'tool' 消息 push 进 messages       —— L314-321
            - 最后一轮若还没结束 → 推 buildGoalContinueMessage()    —— L323-328
    5. 进入下一轮迭代（带着工具结果再问 LLM）
```

**循环终止条件**：
- LLM 产出无 `tool_calls` 的纯文本回复 → 正常结束（`stopReason='completed'`）
- 达到 `maxIterations` 上限 → 主循环退出（可能由 `buildGoalContinueMessage` 引导继续）
- LLM Provider 报错且非长度错误 → `stopReason='error'` 直接返回（[L179](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L179)）
- 长度错误（context length） → 最多重试 `MAX_LENGTH_RECOVERIES=3` 次（[L169](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L169)）
- 空回复 → 最多重试 `MAX_EMPTY_RETRIES=2` 次（[L198](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L198)）

#### 第 5 步：工具执行（ToolRegistry）

工具调用走 [`ToolRegistry.executeTool`](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/registry.ts)（在 [runner.ts:265](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L265) 调用）。所有工具在 [src/agent/tools/](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools) 下，按类别分组：

| 类别 | 文件 | 典型工具 |
|------|------|----------|
| 文件系统 | [filesystem.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/filesystem.ts) | read_file / write_file / edit_file / delete_file / list_directory ... |
| 补丁 | [apply_patch.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/apply_patch.ts) | apply_patch |
| Shell | [shell.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/shell.ts) | shell_exec |
| 沙箱 | [sandbox.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/sandbox.ts) | wrapCommand（沙箱执行） |
| Web | [web.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/web.ts) | web_search / web_fetch |
| 搜索 | [search.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/search.ts) | find_files / grep |
| 记忆 | [memory.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/memory.ts) | 长期记忆读写 |
| 定时任务 | [cron.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/cron.ts) | cron_create / cron_list ... |
| 调度器 | [scheduler.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/scheduler.ts) | task_list / task_add / task_cancel ... |
| 图像生成 | [image_generation.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/image_generation.ts) | image_generation |
| CLI Apps | [cli_apps.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/cli_apps.ts) | 调用预定义 CLI 应用 |
| MCP | [mcp.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/mcp.ts) | 接入外部 MCP server 工具 |
| 长任务/目标 | [long_task.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/long_task.ts) | create_goal / update_goal |
| 子 Agent | [spawn.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/spawn.ts) | **spawn**（派生子 Agent） |
| 执行会话 | [exec_session.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/exec_session.ts) | 长时命令交互式会话 |
| 消息 | [message.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/message.ts) | 主动发消息到渠道 |
| 实用工具 | [utilities.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/utilities.ts) | 其它辅助工具 |
| 自身 | [self.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/self.ts) | 自省/元信息 |

工具结果会受 `max_tool_result_chars` 截断，避免上下文爆炸。

#### 第 6 步：流式事件回流

在 Runner 循环过程中，所有事件通过回调冒泡：
- `onStream(delta)` / `onReasoning(delta)` → 文本/推理增量
- `onToolStart` / `onToolComplete` / `onToolError` → 工具状态
- `onFileEdit` → 文件编辑开始/结束/错误（仅 `FILE_EDIT_TOOLS`，见 [runner.ts:28](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L28)）

这些回调由 `Nanobot.stream` 转成 `StreamEvent` 推给调用方（[nanobot.ts:178-198](file:///Users/peroluo/Document/nanobot-ts/src/nanobot.ts#L178)）。API Server 再把它们映射成前端 WS 事件（`delta` / `tool_started` / `tool_completed` / `file_edit` / `turn_end`，见 [server.ts:893-943](file:///Users/peroluo/Document/nanobot-ts/src/api/server.ts#L893)）。

#### 第 7 步：会话持久化

`processDirect` 末尾（[loop.ts:175-198](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts#L175)）把本轮新增的 `user / assistant / tool` 消息写回 `SessionManager`，下次同一 `sessionKey` 进来时再读出作为历史。`ephemeral: true` 时跳过持久化。

---

## 四、子 Agent（Subagent）机制

### 4.1 何时触发

仅当主 Agent 在 ReAct 循环中调用 `spawn` 工具时才触发（[spawn.ts:54](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/spawn.ts#L54)）。这是 LLM 自主决策的——它判断"这个子任务可以并行/后台跑"时才会调用。

### 4.2 触发后的流程

1. **并发检查**：当前运行中的子 Agent 数 < `max_concurrent_subagents`（默认 1），否则报错（[spawn.ts:62-70](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/spawn.ts#L62)）。
2. **创建任务**：[`SubagentManager.spawn`](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts#L120)（[subagent.ts:120](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts#L120)）生成 `taskId`，登记状态，立即返回"已启动"提示给主 Agent（[L195](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts#L195)）——主 Agent 不会被阻塞。
3. **后台执行**：`_runSubagent`（[L198](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts#L198)）在后台 Promise 中：
   - 用独立的子 Agent 系统提示（[L308](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts#L308)）
   - 用**同一个** `AgentRunner.run` 跑 ReAct 循环（[L221](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts#L221)）
   - 拥有完整的工具集（`_buildTools` 返回默认 `ToolRegistry`，[L116](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts#L116)）
4. **结果回送**：子 Agent 跑完后通过 `_announceResult`（[L271](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts#L271)）把结果包装成一条 `InboundMessage`，以 `channel: 'system'` 投递到消息总线（[L304](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts#L304)）。
5. **主 Agent 接收**：`AgentLoop.handleInboundMessage`（[loop.ts:234](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts#L234)）收到这条消息，把它当作一条新的用户输入再走一遍 `processDirect`——此时主 Agent 看到"子 Agent 完成了 X，结果是 Y"，可以继续推进任务。

### 4.3 子 Agent 的特点

- **独立上下文**：子 Agent 有自己的 system prompt 和消息历史，不共享主 Agent 的对话历史（[L212-L215](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts#L212)）。
- **异步非阻塞**：主 Agent 调用 `spawn` 后立即拿到"已启动"的回执，可以继续干别的或结束本轮。
- **结果以消息形式回流**：通过总线，而非函数返回值。
- **可取消**：`cancelBySession(sessionKey)`（[L321](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts#L321)）。
- **状态可查**：`getStatus(taskId)`（[L351](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts#L351)）。

---

## 五、消息总线与多渠道接入

### 5.1 MessageBus

[MessageBus](file:///Users/peroluo/Document/nanobot-ts/src/bus/queue.ts#L62) 是一个简单的 EventEmitter 风格的事件总线，事件类型有（[L53-L58](file:///Users/peroluo/Document/nanobot-ts/src/bus/queue.ts#L53)）：
- `inbound_message`：外部渠道进来的消息
- `outbound_message`：Agent 给渠道的回复
- `stream_delta` / `stream_end`：流式增量
- `tool_call`：工具调用事件

`AgentLoop.start()`（[loop.ts:214](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts#L214)）会订阅 `inbound_message`，由 `handleInboundMessage`（[L234](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts#L234)）处理——这是所有"渠道消息"进入 Agent 的统一入口。

### 5.2 支持的渠道

[src/channels/](file:///Users/peroluo/Document/nanobot-ts/src/channels) 下支持 20+ 渠道，包括但不限于：

CLI · WebSocket · Telegram · Discord · Slack · Feishu（飞书）· WeCom（企业微信）· Weixin（微信）· WhatsApp · Signal · QQ · NapCat · Email · Matrix · Mattermost · MS Teams · DingTalk（钉钉）· MoChat ...

所有渠道继承自 [base.ts](file:///Users/peroluo/Document/nanobot-ts/src/channels/base.ts)，统一把外部消息转成 `InboundMessage` 投到总线。

### 5.3 三种入口对比

```
                ┌── CLI (cli/commands.ts) ─────────────────┐
                │                                          │
用户输入 ───────┼── WebUI WS (/api/ws/chat) ───────────────┼──► bot.run / bot.stream
                │                                          │   ──► AgentLoop.processDirect
                └── HTTP (/api/v1/chat/completions) ───────┘
                
外部渠道 ────────► MessageBus.publish(inbound_message)
                │
                └──► AgentLoop.handleInboundMessage ──► processDirect
                          ▲
                          │
                子 Agent 完成后也走这条路把结果回送（channel='system'）
```

---

## 六、关键配置项

配置文件位于 `~/.nanobot/config.json`（路径见 [config/loader.ts](file:///Users/peroluo/Document/nanobot-ts/src/config/loader.ts)），关键参数：

| 配置路径 | 含义 | 默认值参考 |
|----------|------|-----------|
| `agents.defaults.model` | 主 Agent 使用的模型 | — |
| `agents.defaults.provider` | Provider（auto/openai/...） | auto |
| `agents.defaults.max_tool_iterations` | ReAct 循环最大轮数 | 见 [loop.ts:162](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts#L162) |
| `agents.defaults.max_tool_result_chars` | 单个工具结果截断长度 | 见 [loop.ts:163](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts#L163) |
| `agents.defaults.context_window_tokens` | 上下文窗口 | — |
| `agents.defaults.workspace` | 工作目录 | — |
| `agents.defaults.unified_session` | 是否所有渠道共用一个会话 | false（见 [loop.ts:293](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts#L293)） |
| `agents.model_presets.*` | 模型预设 | 见 [loop.ts:94](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts#L94) |
| `SubagentManager.maxConcurrentSubagents` | 子 Agent 最大并发 | 1（[subagent.ts:85](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts#L85)） |

---

## 七、一图总结：用户输入 "帮我分析一下这个项目的代码质量" 的完整链路

```
1. 用户在 WebUI 输入 → WS {type:'message', content:'帮我分析...'}
      │
      ▼ [server.ts:887]
2. bot.stream(content, {sessionKey:'websocket:chat-xxx'})
      │
      ▼ [nanobot.ts:211]
3. AgentLoop.processDirect(message, options)
      │
      ├─► sessionManager.getMessages()           读历史
      ├─► ContextBuilder.buildSystemPrompt()     拼 system prompt
      │
      ▼ [loop.ts:157]
4. AgentRunner.run({initialMessages, tools, runtime, provider, ...})
      │
      ▼ [runner.ts:134]  迭代 0:
5. provider.stream(messages, toolDefs, runtime, cb)
      │
      ▼ LLM 返回 tool_calls: [{name:'find_files', ...}]
6. tools.executeTool('find_files', ...)           [runner.ts:265]
      │
      ▼ 结果回填为 role:'tool' 消息
7. 进入迭代 1: 再问 LLM
      │
      ▼ LLM 又返回 tool_calls: [{name:'read_file', ...}, {name:'grep', ...}]
8. 依次执行工具，结果回填
      │
      ▼ 迭代 2..N: LLM 可能再调 spawn 工具派子 Agent
9. (可选) SpawnTool.execute → SubagentManager.spawn   [spawn.ts:81]
      │
      ├─► 后台 _runSubagent → AgentRunner.run（独立循环）
      │       │
      │       └─► 完成后 _announceResult → bus.publish(inbound_message)
      │                                          │
      │                                          ▼
      │                              AgentLoop.handleInboundMessage
      │                                          │
      │                                          └─► 又走一遍 processDirect
      │
      ▼ 主循环 LLM 最终返回纯文本（无 tool_calls）
10. finalContent = "经过分析，这个项目..."     [runner.ts:208]
      │
      ▼ [loop.ts:175]
11. sessionManager.addMessages()                  写历史
      │
      ▼ [nanobot.ts:224]
12. pushEvent(run_completed)
      │
      ▼ [server.ts:930]
13. WS event: turn_end → 浏览器渲染完成
```

---

## 八、扩展指引

- **加一个新工具**：在 [src/agent/tools/](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools) 新建文件，继承 `BaseTool`，再在 [registry.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/registry.ts) 的 `createDefaultToolRegistry` 里注册。
- **加一个新渠道**：在 [src/channels/](file:///Users/peroluo/Document/nanobot-ts/src/channels) 新建文件继承 `base.ts`，在 [registry.ts](file:///Users/peroluo/Document/nanobot-ts/src/channels/registry.ts) 注册，收到消息时 `bus.publish({type:'inbound_message', payload})`。
- **加一个新 Provider**：在 [src/providers/](file:///Users/peroluo/Document/nanobot-ts/src/providers) 实现 `LLMProvider` 接口，在 [factory.ts](file:///Users/peroluo/Document/nanobot-ts/src/providers/factory.ts) 注册。
- **调子 Agent 行为**：改 [subagent.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts) 的 `_buildSubagentPrompt`（[L308](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts#L308)）或 `maxConcurrentSubagents`。
- **加 Hook**：参考 [src/agent/hook.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/hook.ts) 与 [turn_hooks.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/turn_hooks.ts)，通过 `RunOptions.hooks` 传入。

---

*文档基于源码生成，版本：nanobot v0.2.2。如代码重构后行号偏移，请以函数/类名为准定位。*
