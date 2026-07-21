# Nanobot 架构优化方案

> 生成时间：2026-07-19
> 分析范围：`src/` 全量代码、`.nanobot/config.json`、运行时行为
> 评估维度：**稳定性（Stability）· 响应效率（Performance）· 成本（Token 消耗）**
> 配套文档：[ARCHITECTURE.md](file:///Users/peroluo/Document/nanobot-ts/ARCHITECTURE.md)（架构说明）、[TOKEN_OPTIMIZATION.md](file:///Users/peroluo/Document/nanobot-ts/TOKEN_OPTIMIZATION.md)（成本专项）

---

## 一、执行摘要

Nanobot 采用「单主 Agent + 按需子 Agent」的经典 ReAct 架构，结构清晰、扩展点合理。但在**生产可用性**层面存在三类系统性短板：

| 维度 | 当前状态 | 关键风险 | 优化后预期 |
|------|---------|---------|-----------|
| **稳定性** | 多处竞态、非原子持久化、无优雅关闭 | 并发消息致会话错乱、崩溃致数据丢失、429 误判放大故障 | 故障率 ↓ 90%，崩溃不丢数据 |
| **响应效率** | 工具顺序执行、prompt cache 全程失效、子 Agent 串行 | 首字延迟高、多工具任务慢、长会话越来越慢 | TTFT ↓ 30%~50%，多工具轮次耗时 ↓ 40%~60% |
| **成本（Token）** | 200 轮迭代 + 全量历史 + 工具 schema 重发 | 单任务 20~60 万 tokens，60% 可优化 | ↓ 50%~70%（详见成本专项文档） |

**核心结论**：三大维度的根因高度重叠在 **6 个架构级缺陷**上（见第四章）。修复这 6 处即可同时改善三个维度，无需推倒重来。

---

## 二、架构现状速览

> 完整说明见 [ARCHITECTURE.md](file:///Users/peroluo/Document/nanobot-ts/ARCHITECTURE.md)，此处仅列与优化相关的关键链路。

```
入口（WS/HTTP/CLI/渠道）─► Nanobot.stream ─► AgentLoop.processDirect
                                                │
                          ┌─────────────────────┴─────────────────────┐
                          │  1. 读历史（全量）                          │
                          │  2. new ContextBuilder().buildSystemPrompt  │ ← 每轮重建
                          │  3. AgentRunner.run（ReAct 循环，max 200 轮）│
                          │     └─ 每轮：getToolDefinitions() + 全量 msg │ ← 每轮重发
                          │     └─ 工具顺序执行（for 循环，无并行）       │
                          │  4. addMessages 写回（非原子）              │
                          └────────────────────────────────────────────┘
```

**关键文件索引**：

| 组件 | 文件 |
|------|------|
| 顶层封装 | [src/nanobot.ts](file:///Users/peroluo/Document/nanobot-ts/src/nanobot.ts) |
| 主循环 | [src/agent/loop.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts) |
| ReAct 内核 | [src/agent/runner.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts) |
| 上下文构建 | [src/agent/context.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/context.ts) |
| 会话管理 | [src/session/manager.ts](file:///Users/peroluo/Document/nanobot-ts/src/session/manager.ts) |
| 消息总线 | [src/bus/queue.ts](file:///Users/peroluo/Document/nanobot-ts/src/bus/queue.ts) |
| 子 Agent | [src/agent/subagent.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts) |
| 默认 Provider | [src/providers/openai_compat_provider.ts](file:///Users/peroluo/Document/nanobot-ts/src/providers/openai_compat_provider.ts) |
| 兜底 Provider | [src/providers/fallback_provider.ts](file:///Users/peroluo/Document/nanobot-ts/src/providers/fallback_provider.ts) |
| WebSocket 入口 | [src/api/server.ts](file:///Users/peroluo/Document/nanobot-ts/src/api/server.ts) |
| 上下文治理（死代码） | [src/agent/context_governance.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/context_governance.ts) |
| 自动压缩（死代码） | [src/agent/autocompact.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/autocompact.ts) |

---

## 三、三维度问题清单

### 3.1 稳定性（Stability）

#### 🔴 S1 · 同会话并发消息无串行化，存在竞态条件
- **位置**：[server.ts:841](file:///Users/peroluo/Document/nanobot-ts/src/api/server.ts#L841)、[queue.ts:71-81](file:///Users/peroluo/Document/nanobot-ts/src/bus/queue.ts#L71)、[loop.ts:133-194](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts#L133)
- **现象**：WebSocket `ws.on('message', async ...)` 每条消息独立 spawn 一个 async 处理器；`MessageBus.publish` 并发触发 handler，**无 per-session 队列/锁**。
- **后果**：用户连发两条消息 → 两个 `processDirect` 并发跑在同一 `sessionKey` 上：
  1. 二者读到相同历史；
  2. 各自跑完 ReAct 后都调 `addMessages` 追加；
  3. 第二条的 LLM 上下文缺失第一条的回复，对话逻辑断裂；
  4. 两次 `fs.writeFile` 竞争同一会话文件（[manager.ts:103](file:///Users/peroluo/Document/nanobot-ts/src/session/manager.ts#L103)），后写覆盖先写，丢失消息。
- **严重度**：🔴 致命——用户体感为「AI 答非所问 / 历史消失」。

#### 🔴 S2 · 会话持久化非原子，崩溃即损坏
- **位置**：[manager.ts:103](file:///Users/peroluo/Document/nanobot-ts/src/session/manager.ts#L103)
- **现象**：`fs.writeFile(filePath, JSON.stringify(session))` 直接覆盖目标文件，无 `tmp + rename` 模式。
- **后果**：进程在写入中途崩溃/断电 → 文件被截断为半段 JSON → 下次 `loadFromDisk` 解析失败（[manager.ts:166](file:///Users/peroluo/Document/nanobot-ts/src/session/manager.ts#L166)）→ **整个会话历史永久丢失**。
- **严重度**：🔴 高——长会话丢失对用户是灾难性的。

#### 🔴 S3 · 无优雅关闭，SIGINT 不等待在途任务
- **位置**：[cli/commands.ts:95-100](file:///Users/peroluo/Document/nanobot-ts/src/cli/commands.ts#L95)、[nanobot.ts:311-313](file:///Users/peroluo/Document/nanobot-ts/src/nanobot.ts#L311)
- **现象**：SIGINT handler 仅调 `cliChannel.stop()` + `loop.stop()` 后立即 `process.exit(0)`。`loop.stop()` 只是置 `running=false`（[loop.ts:225](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts#L225)），**不 await 在途的 `processDirect`**。
- **后果**：
  - 正在执行的 ReAct 循环被强行中断，未写回的 assistant 回复丢失；
  - 子 Agent 后台 Promise 被遗弃，可能留下僵尸进程（exec_session）；
  - Provider 的 HTTP 连接未正常关闭。
- **严重度**：🟠 高——日常重启即丢消息。

#### 🟠 S4 · 无全局未捕获异常 / unhandledRejection 处理
- **位置**：全项目 `process.on('uncaughtException'|'unhandledRejection')` **0 处注册**（grep 确认）
- **现象**：`MessageBus.publish` 用 `Promise.resolve().then(handler).catch(logger.error)`（[queue.ts:75-78](file:///Users/peroluo/Document/nanobot-ts/src/bus/queue.ts#L75)）兜住了总线层；但 `AgentRunner.run`、`SubagentManager._runSubagent`、`server.ts` WS handler 中的异常若未被 try/catch 完全覆盖，会成为 unhandledRejection。
- **后果**：Node 默认行为是输出警告；未来 Node 版本会直接 crash。一个工具异常可能拖垮整个进程。
- **严重度**：🟠 高。

#### 🔴 S5 · 429 / rate limit 被误判为长度错误，加剧限流
- **位置**：[runner.ts:369-376](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L369)
- **现象**：
  ```ts
  return msg.includes('context length') ||
         msg.includes('token limit') ||
         msg.includes('429') ||        // ❌ 限流不是长度问题
         msg.includes('rate limit');
  ```
  触发后会 push `'The conversation is too long. Please summarize...'`（[runner.ts:172](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L172)）并 `continue`。
- **后果**：限流时非但不退避，反而**立即重发一个更长的请求**（多了 user 消息），形成正反馈，可能触发更严的限流甚至封禁。
- **严重度**：🔴 高——故障放大器。

#### 🟠 S6 · 默认 Provider 无重试/退避，仅 FallbackProvider 有
- **位置**：[openai_compat_provider.ts:46-65](file:///Users/peroluo/Document/nanobot-ts/src/providers/openai_compat_provider.ts#L46)（直接 throw）、[fallback_provider.ts:56-107](file:///Users/peroluo/Document/nanobot-ts/src/providers/fallback_provider.ts#L56)（有指数退避）
- **现象**：`OpenAICompatProvider.complete` 捕获错误后立刻 rethrow，无任何重试。重试逻辑只存在于 `FallbackProvider`，但需用户主动配置多 provider。
- **后果**：单 provider 配置下，任何瞬时网络抖动/5xx 都直接失败，整个 turn 报错退出。
- **严重度**：🟠 高。

#### 🟠 S7 · Subagent 取消是空操作
- **位置**：[subagent.ts:321-333](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts#L321)
- **现象**：`cancelBySession` 只遍历计数，**不实际取消** Promise。子 Agent 的 `AgentRunner.run` 无 `AbortController` 传入。
- **后果**：会话结束/用户中断后，后台子 Agent 仍在烧 token、跑工具，直到自然结束。
- **严重度**：🟠 中——资源浪费 + 不可控。

#### 🟡 S8 · 流式中途断连无续传，前端看到半截回复
- **位置**：[openai_compat_provider.ts:100-184](file:///Users/peroluo/Document/nanobot-ts/src/providers/openai_compat_provider.ts#L100)
- **现象**：`stream.on('error')` reject 整个 Promise，但 `onDelta` 已推送部分 delta 给前端。
- **后果**：前端先收到一段文本，然后报错；用户无法区分是「正常结束」还是「中断」。无断点续传。
- **严重度**：🟡 中。

#### 🟡 S9 · exec_session 无超时上限可设为 Infinity
- **位置**：[exec_session.ts:68](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/exec_session.ts#L68)
- **现象**：`this.deadline = options.timeout ? ... : Infinity`。若 LLM 不传 timeout，子进程可无限挂起，持续占用资源。
- **严重度**：🟡 中。

#### 🟡 S10 · Chat WebSocket 无心跳/陈旧连接清理
- **位置**：[server.ts:834-962](file:///Users/peroluo/Document/nanobot-ts/src/api/server.ts#L834)
- **现象**：`chatWss.on('connection')` 仅注册 message/close handler，**无 ping/pong、无 idle 超时**。对比 `wss`（[server.ts:829](file:///Users/peroluo/Document/nanobot-ts/src/api/server.ts#L829)）还有 `wsLogger.addConnection`，chat WS 更简陋。
- **后果**：客户端断网（不发 close 帧）→ 服务端永远认为连接活着 → 连接泄漏。
- **严重度**：🟡 中。

#### 🟡 S11 · 单 turn 无整体超时预算
- **位置**：[runner.ts:134-330](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L134)
- **现象**：循环仅以 `maxIterations` 为上限，无墙钟超时。若每轮 LLM 调用都很慢（如 30s）+ 工具执行慢，单 turn 可挂起数十分钟。
- **严重度**：🟡 中。

#### 🟡 S12 · `maybeCompact` 粗暴 slice 破坏 tool_calls 配对
- **位置**：[manager.ts:223-238](file:///Users/peroluo/Document/nanobot-ts/src/session/manager.ts#L223)
- **现象**：超 200 条消息时 `messages.slice(toRemove)` 砍前 80 条。若切口落在 `assistant.tool_calls` 与 `tool` 之间，留下孤儿 tool result，下次请求部分 provider 会直接报 400。
- **严重度**：🟡 中——偶发但难排查。

---

### 3.2 响应效率（Performance）

#### 🔴 P1 · 同一轮多个 tool_calls 顺序执行，无并行
- **位置**：[runner.ts:233-319](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L233)
- **现象**：
  ```ts
  for (const toolCall of response.tool_calls) {
    // ...
    const result = await tools.executeTool(...);  // 串行 await
    // ...
  }
  ```
- **后果**：LLM 一次返回 3 个独立工具调用（如 `read_file` × 3）→ 顺序执行总耗时 = t1+t2+t3，并行本可 = max(t1,t2,t3)。多文件分析类任务慢 2~3 倍。
- **优化预期**：并行后多工具轮次耗时 ↓ 40%~60%。

#### 🔴 P2 · System prompt 每轮重建且含动态时间，prompt cache 全程失效
- **位置**：[loop.ts:143-151](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts#L143)、[context.ts:79,89](file:///Users/peroluo/Document/nanobot-ts/src/agent/context.ts#L79)
- **现象**：
  - 每次 `processDirect` 都 `new ContextBuilder()` + `buildSystemPrompt()`；
  - `getDefaultIdentity` 写 `Current time: ${new Date().toISOString()}`（[context.ts:79](file:///Users/peroluo/Document/nanobot-ts/src/agent/context.ts#L79)）；
  - `getRuntimeContext` 又写一遍 `Current date and time: ${now.toISOString()}`（[context.ts:89](file:///Users/peroluo/Document/nanobot-ts/src/agent/context.ts#L89)）；
  - 时间戳每秒变化 → system prompt 前缀不稳定 → **DeepSeek/OpenAI prompt cache 永远 miss**。
- **后果**：每轮 LLM 调用都全量重传 + 重新计算 prefill，TTFT（首字延迟）显著上升，token 成本同步上升（见成本文档整改 #2/#11）。
- **严重度**：🔴 高——同时拖慢响应和抬高成本。

#### 🟠 P3 · 工具定义每轮迭代重新构建
- **位置**：[runner.ts:142](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L142)、[registry.ts:48-59](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/registry.ts#L48)
- **现象**：`getToolDefinitions()` 在 for 循环内每轮调用，内部遍历所有 tool 重建数组。
- **后果**：30+ 工具的 schema 每轮重新序列化，CPU 浪费 + 网络重传（见成本文档 #2）。
- **严重度**：🟠 中。

#### 🟠 P4 · 子 Agent 全局并发=1，多任务串行
- **位置**：[subagent.ts:85](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts#L85)
- **现象**：`maxConcurrentSubagents ?? 1`，且为**全局**计数（非 per-session）。
- **后果**：主 Agent 派出多个子任务时只能排队；其他会话的子任务也会被阻塞。
- **严重度**：🟠 中。

#### 🟡 P5 · 流式 delta 回调 await 反压
- **位置**：[openai_compat_provider.ts:139,144,166](file:///Users/peroluo/Document/nanobot-ts/src/providers/openai_compat_provider.ts#L139)
- **现象**：`stream.on('data', async (chunk) => { ... await onDelta(...) ... })`。每个 delta 都 await 回调完成才继续解析下一个 chunk。
- **后果**：若 `onStream` 链路慢（如 server.ts 的 `send` 遇到背压），会拖慢整个流式解析，累积延迟。
- **严重度**：🟡 低-中。

#### 🟡 P6 · 历史每轮全量拷贝
- **位置**：[loop.ts:133](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts#L133)、[manager.ts:198](file:///Users/peroluo/Document/nanobot-ts/src/session/manager.ts#L198)
- **现象**：`getMessages` 返回 `[...session.messages]` 浅拷贝整个数组，每个 turn 都做一次。
- **后果**：长会话（数百条 + 大工具结果）每轮内存抖动 + GC 压力。
- **严重度**：🟡 低-中。

#### 🟡 P7 · 子 Agent 结果回流走总线 → 重新触发完整 processDirect
- **位置**：[subagent.ts:304](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts#L304) → [loop.ts:234](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts#L234)
- **现象**：子 Agent 完成后 publish `inbound_message`，主 Agent 当作新用户输入再走一遍 `processDirect`（含完整 ReAct 循环）。
- **后果**：用户等待 = 子 Agent 执行时间 + 主 Agent 至少一轮 LLM 调用。无轻量「结果注入」通道。
- **严重度**：🟡 中。

#### 🟡 P8 · 会话文件每条消息同步落盘
- **位置**：[manager.ts:74,84,91](file:///Users/peroluo/Document/nanobot-ts/src/session/manager.ts#L74)
- **现象**：`appendMessage` / `appendMessages` 每次都 `fs.writeFile` 全量重写会话 JSON。
- **后果**：高频对话时 I/O 阻塞；会话越大，单次写入越慢（O(N) 写）。
- **严重度**：🟡 中。

#### 🟢 P9 · Dream 模式后台抢占 provider rate limit
- **位置**：`.nanobot/config.json` `memory.dream.interval_h: 2, max_iterations: 15`
- **现象**：每 2 小时后台跑一批 LLM 整理记忆，与前台任务共用同一 provider 配额。
- **后果**：偶发的前台任务延迟尖刺，难定位。
- **严重度**：🟢 低。

#### 🟢 P10 · 单线程 Node，无 cluster
- **位置**：[server.ts](file:///Users/peroluo/Document/nanobot-ts/src/api/server.ts) 全文
- **现象**：单进程单事件循环。CPU 密集（如大 JSON 解析、apply_patch diff）会阻塞所有连接。
- **严重度**：🟢 低——个人助手场景可接受。

---

### 3.3 成本（Token 消耗）

> 完整 21 项分析与整改方案见 [TOKEN_OPTIMIZATION.md](file:///Users/peroluo/Document/nanobot-ts/TOKEN_OPTIMIZATION.md)。此处仅列 Top 5 影响项，便于跨维度对照。

| 排名 | 问题 | 位置 | 单任务浪费 |
|------|------|------|-----------|
| C1 | `max_tool_iterations=200` | [config.json:13](file:///Users/peroluo/Document/nanobot-ts/.nanobot/config.json#L13) | 极高 |
| C2 | 每轮重发 30+ 工具 schema | [runner.ts:142](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L142) | 60~120 万 tokens/任务 |
| C3 | 历史全量重发无截断 | [loop.ts:141](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts#L141) | O(N²) 增长 |
| C4 | Token 估算中文失真（/4） | [helpers.ts:39](file:///Users/peroluo/Document/nanobot-ts/src/utils/helpers.ts#L39) | 截断永远不触发 |
| C5 | ContextGovernor/AutoCompact 死代码 | [context_governance.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/context_governance.ts)、[autocompact.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/autocompact.ts) | 600 行压缩流水线未生效 |

**估算**：当前一次中等复杂度任务消耗 **20~60 万 tokens**，其中 60%+ 属可优化空间。

---

## 四、跨维度根因分析（架构级）

三个维度的具体问题虽多，但根因高度集中于以下 **6 个架构级缺陷**。修复它们可同时改善多个维度。

### A1 · 缺少 per-session 调度层
- **现状**：事件总线 → 直接执行（[queue.ts:71](file:///Users/peroluo/Document/nanobot-ts/src/bus/queue.ts#L71)）。
- **影响**：S1（竞态）、S2（并发写文件）、S12（压缩时序错乱）。
- **本质**：`MessageBus` 是 fan-out 广播，没有「同 sessionKey 串行、跨 sessionKey 并行」的概念。

### A2 · 上下文构建无缓存层 + 动态内容前置
- **现状**：`ContextBuilder` 每 turn 新建，system prompt 含 `new Date().toISOString()`。
- **影响**：P2（prompt cache 失效）、P3（工具定义重算）、C2（重发）、C3（全量历史）。
- **本质**：把「易变内容」（时间、会话 ID）和「稳定内容」（身份、工具策略）混在一个 system prompt 里，且每轮重建。

### A3 · Provider 层无统一 resilience 抽象
- **现状**：`OpenAICompatProvider` 裸跑无重试；`FallbackProvider` 有重试但需手动配；`isLengthError` 把 429 当长度错误。
- **影响**：S5（429 误判）、S6（无重试）、S8（流式断连）。
- **本质**：错误分类与重试策略散落在 runner / provider / fallback 三处，无单一职责层。

### A4 · 工具执行无并发与预算控制
- **现状**：`for (const toolCall of tool_calls) await executeTool(...)` 顺序执行；无整体超时；无并行。
- **影响**：P1（顺序执行）、S11（无 turn 超时）、S9（exec_session 无上限）。
- **本质**：把「LLM 决策的并行意图」与「实际执行」混在一起，且无执行预算。

### A5 · 持久化非原子 + 无优雅关闭
- **现状**：`fs.writeFile` 直写；SIGINT 不 await 在途任务；无全局异常 handler。
- **影响**：S2（数据损坏）、S3（关闭丢消息）、S4（异常 crash）。
- **本质**：把「持久化」当成了「写文件」而非「状态机变更」，缺少事务与生命周期管理。

### A6 · 压缩治理代码已写好但未装配
- **现状**：`ContextGovernor`（443 行）和 `AutoCompact`（164 行）完整可用，但 `grep` 确认 **0 个外部调用点**。
- **影响**：C5（成本）、S12（粗暴 slice）、P6（历史无界增长）。
- **本质**：架构层面预留了治理层，但主流程没接进去——这是**最小改动收益最高**的优化点。

---

## 五、架构优化方案

### 5.1 稳定性优化

#### 优化 S1 / A1：引入 per-session 串行调度器

**目标**：同 `sessionKey` 的消息严格串行，跨 sessionKey 并行。

**方案**：在 `AgentLoop` 与入口之间增加 `SessionDispatcher`：

```ts
// 新增 src/agent/session_dispatcher.ts
export class SessionDispatcher {
  private queues: Map<string, Promise<void>> = new Map();

  /** 同 sessionKey 串行执行；不同 sessionKey 并行 */
  async enqueue<T>(sessionKey: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(sessionKey) ?? Promise.resolve();
    let resolveNext!: () => void;
    const next = new Promise<void>((r) => (resolveNext = r));
    this.queues.set(sessionKey, prev.then(() => next));

    try {
      await prev;              // 等前一个完成
      return await task();     // 执行当前任务
    } finally {
      resolveNext();
      // 若当前是队列尾，清理引用避免内存泄漏
      if (this.queues.get(sessionKey) === next) {
        this.queues.delete(sessionKey);
      }
    }
  }
}
```

**接入点**：
- `Nanobot.stream` / `Nanobot.run`（[nanobot.ts:134,156](file:///Users/peroluo/Document/nanobot-ts/src/nanobot.ts#L134)）调用 `processDirect` 前包一层 `dispatcher.enqueue(sessionKey, ...)`；
- `AgentLoop.handleInboundMessage`（[loop.ts:234](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts#L234)）同样包裹。

**配套**：前端可在用户连发时显示「排队中」状态，提升体验。

#### 优化 S2 / A5：原子写入 + 写前备份

```ts
// manager.ts: save 改造
async save(sessionKey: string): Promise<void> {
  if (!this.persist) return;
  const session = this.sessions.get(sessionKey);
  if (!session) return;
  const filePath = this.getSessionPath(sessionKey);
  const tmpPath = filePath + '.tmp';
  try {
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.writeFile(tmpPath, JSON.stringify(session, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);   // 原子替换
  } catch (err) {
    logger.error({ err, session_key: sessionKey }, 'Failed to persist session');
    // 失败时 tmp 文件残留不影响主文件
  }
}
```

**额外建议**：`loadFromDisk` 解析失败时，尝试加载 `.bak`（每次 rename 前把旧文件复制为 `.bak`），实现「上一版可用」回滚。

#### 优化 S3 / S4 / A5：优雅关闭 + 全局异常兜底

```ts
// src/nanobot.ts 或新增 src/lifecycle.ts
export class LifecycleManager {
  private activeTurns = new Set<Promise<unknown>>();
  private shutdownSignal = false;

  track<T>(p: Promise<T>): Promise<T> {
    this.activeTurns.add(p);
    return p.finally(() => this.activeTurns.delete(p));
  }

  async shutdown(timeoutMs = 10000): Promise<void> {
    this.shutdownSignal = true;
    logger.info({ active: this.activeTurns.size }, 'Graceful shutdown started');
    // 拒绝新请求（入口检查 shutdownSignal）
    // 等待在途任务，超时则强制退出
    await Promise.race([
      Promise.allSettled([...this.activeTurns]),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
  }
}

// 进程级
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaughtException');
  // 不立即退出，记录后继续（视错误性质决定）
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection');
});

// cli/commands.ts SIGINT handler 改造
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  await lifecycleManager.shutdown(10000);  // 等 10s
  await loop.stop();                       // 停总线订阅
  await bot.close();                       // 关 provider
  process.exit(0);
});
```

#### 优化 S5 / A3：错误分类 + 限流退避

```ts
// runner.ts: 拆分 isLengthError
private isLengthError(err: unknown): boolean {
  const msg = (err as Error)?.message?.toLowerCase() || '';
  return msg.includes('context length') ||
         msg.includes('maximum context') ||
         msg.includes('token limit');
}

private isRateLimitError(err: unknown): boolean {
  const msg = (err as Error)?.message?.toLowerCase() || '';
  const code = (err as { code?: string }).code;
  return msg.includes('429') ||
         msg.includes('rate limit') ||
         code === '429';
}

// catch 块新增分支
if (this.isRateLimitError(err)) {
  const delay = Math.min(2000 * Math.pow(2, rateLimitRetryCount++), 60000);
  logger.warn({ delay, retry: rateLimitRetryCount }, 'Rate limited, backing off');
  await sleep(delay);
  continue;  // 不 push 任何消息，直接重试
}
```

#### 优化 S6 / A3：默认 Provider 注入轻量重试

```ts
// openai_compat_provider.ts: 包装 complete/stream
private async withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= maxRetries; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (!this.isTransient(err) || i === maxRetries) throw err;
      await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** i, 10000)));
    }
  }
  throw lastErr;
}
```

> 长期方案：把 `FallbackProvider` 的 `withFallback` 抽成 `ResilientProviderWrapper`，所有 provider 默认套一层。

#### 优化 S7：子 Agent 引入 AbortController

```ts
// subagent.ts
private _abortControllers: Map<string, AbortController> = new Map();

async spawn(...): Promise<string> {
  const ac = new AbortController();
  this._abortControllers.set(taskId, ac);
  // ... 传 ac.signal 到 runner.run 的 options
}

async cancelBySession(sessionKey: string): Promise<number> {
  const taskIds = this._sessionTasks.get(sessionKey);
  if (!taskIds) return 0;
  let count = 0;
  for (const taskId of taskIds) {
    const ac = this._abortControllers.get(taskId);
    if (ac) { ac.abort(); count++; }
  }
  return count;
}

// runner.run 内部检查 signal.aborted，在循环顶部 break
```

#### 优化 S10：Chat WebSocket 心跳

```ts
// server.ts chatWss.on('connection')
const pingInterval = setInterval(() => {
  if (ws.readyState === 1) ws.ping();
}, 30000);
ws.on('pong', () => { /* alive */ });
ws.on('close', () => clearInterval(pingInterval));
// 配合 ws.terminate() 在 2 次 ping 无 pong 后强制断开
```

#### 优化 S11：Turn 级墙钟超时

```ts
// runner.ts: run() 顶部
const turnDeadline = Date.now() + (runtime.turn_timeout_ms ?? 300000); // 默认 5 分钟
for (let iteration = 0; iteration < maxIterations; iteration++) {
  if (Date.now() > turnDeadline) {
    stopReason = 'turn_timeout';
    break;
  }
  // ...
}
```

---

### 5.2 响应效率优化

#### 优化 P1 / A4：工具并行执行

**前提**：仅并行化**无副作用依赖**的工具调用。文件编辑类（`write_file`/`edit_file`/`apply_patch`）需保持顺序，避免冲突。

```ts
// runner.ts: 替换 for 循环
const fileEditCalls: typeof response.tool_calls = [];
const parallelCalls: typeof response.tool_calls = [];

for (const tc of response.tool_calls) {
  if (FILE_EDIT_TOOLS.has(tc.name)) fileEditCalls.push(tc);
  else parallelCalls.push(tc);
}

// 并行执行非文件编辑工具
const parallelResults = await Promise.all(
  parallelCalls.map(tc => this.executeOneTool(tc, tools, toolContext, maxToolResultChars))
);

// 顺序执行文件编辑工具（保持原序）
const fileEditResults: typeof parallelResults = [];
for (const tc of fileEditCalls) {
  fileEditResults.push(await this.executeOneTool(tc, tools, toolContext, maxToolResultChars));
}

// 按 tool_call_id 顺序回填到 messages（provider 要求顺序与 tool_calls 一致）
```

**注意**：`onToolStart`/`onToolComplete` 事件需带 `tool_call_id`，前端已支持。

#### 优化 P2 / P3 / A2：System prompt 分层 + 缓存

**核心思路**：把 system prompt 拆成 **稳定前缀**（身份、工具策略）+ **动态后缀**（时间、会话 ID），稳定前缀跨 turn 缓存。

```ts
// context.ts: 新增
export class ContextBuilder {
  private _cachedStablePrefix: string | null = null;
  private _cacheKey: string | null = null;

  /** 稳定部分：身份 + 工具策略 + 平台策略 + skills（不含时间） */
  buildStablePrefix(): string {
    const key = JSON.stringify({
      botName: this.options.botName,
      botIcon: this.options.botIcon,
      channel: this.options.channel,
      // skills 列表 hash
    });
    if (this._cacheKey === key && this._cachedStablePrefix) {
      return this._cachedStablePrefix;
    }
    this._cacheKey = key;
    this._cachedStablePrefix = [this.getIdentityWithoutTime(), this.options.toolPolicy, ...]
      .filter(Boolean).join('\n\n');
    return this._cachedStablePrefix;
  }

  /** 动态部分：时间 + 会话信息（放在 system prompt 末尾或单独 system 消息） */
  buildDynamicSuffix(): string {
    return `# Runtime Info\nCurrent date and time: ${new Date().toISOString()}\nTimezone: ${this.options.timezone}\nChannel: ${this.options.channel}`;
  }
}
```

**Provider 消息布局**（最大化 prompt cache 命中）：
```
[
  { role: 'system', content: stablePrefix },   // ← 跨 turn 不变，命中 cache
  { role: 'system', content: dynamicSuffix },   // ← 每轮变化
  ...history,
  userMessage
]
```

**配套**：工具定义在 `ToolRegistry` 内缓存（首次 `getToolDefinitions()` 后冻结），避免每轮重建（[registry.ts:48](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/registry.ts#L48)）。

#### 优化 P4 / A1：子 Agent 并发可配 + per-session 隔离

```ts
// subagent.ts
this.maxConcurrentSubagents = options.maxConcurrentSubagents ?? 3;  // 默认提到 3
// 改为 per-session 计数：_sessionTasks.get(sessionKey).size 而非全局 _runningTasks.size
```

#### 优化 P5：流式 delta 解耦回调

```ts
// openai_compat_provider.ts: 用队列解耦解析与回调
const deltaQueue: StreamDelta[] = [];
let processing = false;
const flush = async () => {
  if (processing) return;
  processing = true;
  while (deltaQueue.length > 0) {
    const d = deltaQueue.shift()!;
    await onDelta(d);  // 回调慢不阻塞 stream.on('data')
  }
  processing = false;
};
stream.on('data', (chunk) => {
  // 解析后 push 到 deltaQueue，不 await
  deltaQueue.push(...parsedDeltas);
  void flush();
});
```

#### 优化 P7：子 Agent 结果走轻量注入通道

**方案**：子 Agent 完成后，不 publish `inbound_message` 触发完整 `processDirect`，而是把结果作为一条 `tool` 消息直接 append 到主 Agent 当前 turn 的 messages 队列（主 Agent 仍在 ReAct 循环中等待）。

> 该改动较大，需要主 Agent 调 `spawn` 后进入「等待结果」状态。建议作为 P2 阶段优化，初期保持现状。

#### 优化 P8：会话增量持久化 + 写合并

```ts
// manager.ts: 高频写合并
private _dirtySessions = new Set<string>();
private _flushTimer: NodeJS.Timeout | null = null;

async appendMessages(sessionKey: string, messages: ...): Promise<void> {
  // 仅更新内存
  // 标记 dirty，500ms 后批量落盘
  this._dirtySessions.add(sessionKey);
  this.scheduleFlush();
}

private scheduleFlush() {
  if (this._flushTimer) return;
  this._flushTimer = setTimeout(() => this.flushAll(), 500);
}

private async flushAll() {
  const keys = [...this._dirtySessions];
  this._dirtySessions.clear();
  this._flushTimer = null;
  await Promise.all(keys.map(k => this.store.save(k)));
}
```

**配套**：`SIGINT` 时强制 `flushAll()`，避免丢消息（与 S3 配合）。

---

### 5.3 成本优化（摘要）

> 完整方案见 [TOKEN_OPTIMIZATION.md](file:///Users/peroluo/Document/nanobot-ts/TOKEN_OPTIMIZATION.md)。此处仅列与架构强相关的项。

| 项 | 与架构的关系 |
|----|-------------|
| 调低 `max_tool_iterations` 200→30 | 配置层，配合 S11 的 turn 超时双保险 |
| 接入 `ContextGovernor`（死代码激活） | **A6 的核心**——20 行代码接入，多项整改自动生效 |
| 接入 `AutoCompact`（死代码激活） | **A6 的核心**——长会话渐进式 LLM 摘要 |
| 修正 token 估算（中文 1.5 字符/token） | `utils/helpers.ts` 一处改动，全局生效 |
| 取消 `read_file` 豁免压缩 | `context_governance.ts` 一行改动（接入后才有意义） |
| System prompt 分层 | 与 P2 共用方案，cache 命中后输入 token 大幅下降 |
| 子 Agent 工具集精简 | 与 P4 共用方案 |

**预期总收益**：50%~70% token 下降。

---

### 5.4 架构级整改总览图

```
┌─────────────────────────────────────────────────────────────────────┐
│                        优化后的架构                                  │
├─────────────────────────────────────────────────────────────────────┤
│  入口层（WS/HTTP/CLI/渠道）                                          │
│    │                                                                 │
│    ▼                                                                 │
│  ┌─────────────────────┐                                            │
│  │ SessionDispatcher   │ ◄── 新增：per-session 串行（A1/S1）        │
│  └──────────┬──────────┘                                            │
│             │                                                       │
│             ▼                                                       │
│  ┌─────────────────────┐                                            │
│  │ LifecycleManager    │ ◄── 新增：优雅关闭/异常兜底（A5/S3/S4）    │
│  └──────────┬──────────┘                                            │
│             │                                                       │
│             ▼                                                       │
│  AgentLoop.processDirect                                            │
│    ├─ ContextBuilder                                                 │
│    │   ├─ buildStablePrefix()  ◄── 缓存（A2/P2/C2）                │
│    │   └─ buildDynamicSuffix()                                       │
│    ├─ ContextGovernor.prepareForModel() ◄── 激活死代码（A6/C5）     │
│    │                                                                 │
│    ▼                                                                 │
│  AgentRunner.run（ReAct，max 30 轮 + turn 超时）                     │
│    ├─ 工具定义缓存（A2/P3）                                          │
│    ├─ 工具并行执行（A4/P1）                                          │
│    ├─ ResilientProviderWrapper                                       │
│    │   ├─ 错误分类（length/rate/5xx）（A3/S5/S6）                    │
│    │   ├─ 指数退避重试                                                │
│    │   └─ 流式 delta 解耦（P5）                                       │
│    └─ AbortController 透传（S7）                                     │
│             │                                                       │
│             ▼                                                       │
│  SessionManager                                                      │
│    ├─ 原子写（tmp+rename）（A5/S2）                                  │
│    ├─ 写合并 + 批量落盘（P8）                                        │
│    └─ AutoCompact 渐进压缩（A6/C5）                                  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 六、实施路线图

### Week 1：稳定性急件（P0）
| 任务 | 对应项 | 工时 | 风险 |
|------|-------|------|------|
| per-session 串行调度器 | S1/A1 | 1 天 | 低 |
| 会话原子写 + .bak 回滚 | S2/A5 | 0.5 天 | 低 |
| 优雅关闭 + 全局异常 handler | S3/S4 | 1 天 | 低 |
| 429 误判修复 + 限流退避 | S5/A3 | 0.5 天 | 低 |
| Chat WebSocket 心跳 | S10 | 0.5 天 | 低 |
| 默认 Provider 轻量重试 | S6/A3 | 0.5 天 | 中（需测试流式） |

**预期收益**：故障率 ↓ 80%，崩溃不丢数据。

### Week 2：成本 + 效率主收益（P0/P1）
| 任务 | 对应项 | 工时 | 风险 |
|------|-------|------|------|
| 接入 ContextGovernor（死代码激活） | A6/C5/S12 | 1 天 | 中（需验证配对完整性） |
| 接入 AutoCompact | A6/C5 | 1 天 | 中 |
| 修正 token 估算（中文） | C4 | 0.5 天 | 低 |
| System prompt 分层 + 缓存 | P2/A2/C2 | 1 天 | 中（需测 cache 命中） |
| 调低 max_tool_iterations / max_tokens | C1/C17 | 0.5 天 | 低 |
| 工具定义缓存 | P3 | 0.5 天 | 低 |

**预期收益**：token ↓ 40%~55%，TTFT ↓ 20%~30%。

### Week 3：效率进阶（P1）
| 任务 | 对应项 | 工时 | 风险 |
|------|-------|------|------|
| 工具并行执行（非文件编辑类） | P1/A4 | 1.5 天 | 高（需保证 tool_call_id 顺序） |
| Turn 级墙钟超时 | S11 | 0.5 天 | 低 |
| 子 Agent AbortController | S7 | 1 天 | 中 |
| 子 Agent 并发提到 3 + per-session | P4 | 0.5 天 | 低 |
| 会话写合并 | P8 | 1 天 | 中（需保证不丢消息） |

**预期收益**：多工具轮次耗时 ↓ 40%~60%。

### Week 4+：长期优化（P2/P3）
- 子 Agent 结果轻量注入通道（P7）
- 流式 delta 解耦（P5）
- 历史增量加载（P6）
- Dream 模式调度优化（P9）
- Token 监控告警体系（C21）

---

## 七、验证与监控

### 7.1 基线测量

整改前用一组标准任务记录指标：

```ts
// runner.ts: run() 返回前打印
logger.info({
  session_key: sessionKey,
  iterations_used: iteration,
  total_tokens: totalUsage.total_tokens,
  input_tokens: totalUsage.input_tokens,
  output_tokens: totalUsage.output_tokens,
  cache_read_tokens: totalUsage.cache_read_tokens,
  cache_write_tokens: totalUsage.cache_write_tokens,
  tools_used: toolsUsed,
  duration_ms: Date.now() - startTime,
  stop_reason: stopReason,
}, 'Turn metrics');
```

标准任务集（建议）：
1. 读取 `package.json` 并总结（轻量）
2. 修复一个 bug（中等，含多文件读写）
3. 分析整个项目代码质量（重度，多工具 + 可能 spawn）

### 7.2 关键指标

| 维度 | 指标 | 目标 |
|------|------|------|
| 稳定性 | 崩溃后数据丢失率 | 0% |
| 稳定性 | 429 后故障恢复时间 | < 60s |
| 稳定性 | 并发消息致会话错乱 | 0 次 |
| 效率 | TTFT（首字延迟）P95 | ↓ 30% |
| 效率 | 多工具轮次耗时 P95 | ↓ 50% |
| 成本 | 单任务 total_tokens P95 | ↓ 50% |
| 成本 | prompt cache hit rate | > 60% |

### 7.3 监控点

- 复用 `src/webui/token_usage.ts`，在单任务 token > 50K 时告警；
- 新增 `/api/v1/metrics` 端点暴露 turn 级指标（iterations、tokens、duration）；
- 接入 `ContextGovernor` 后，监控 `compactInflightOverflow` 触发频次，过高说明上游预算过松。

### 7.4 回归测试

每完成一项整改跑同一组标准任务，对比：
- `result.usage.total_tokens`（成本）
- turn `duration_ms`（效率）
- 任务完成质量（人工评估，确保迭代次数下降不等于失败）

---

## 八、附录：风险矩阵

| 整改项 | 收益 | 风险 | 回滚策略 |
|-------|------|------|---------|
| SessionDispatcher 串行化 | 高（S1） | 低 | 入口加 feature flag，故障时退回直接执行 |
| 原子写 | 高（S2） | 低 | 改动局部，回滚即恢复直写 |
| 优雅关闭 | 高（S3） | 中（超时配置不当可能拖慢重启） | timeout 可配，默认 10s |
| 429 退避 | 高（S5） | 低 | 退避次数上限，不会无限重试 |
| ContextGovernor 接入 | 极高（A6） | 中（压缩可能切坏配对） | 接入前已有 `dropOrphanToolResults` 兜底；可先只开 `snipHistory` |
| System prompt 分层 | 高（P2/C2） | 中（部分 provider 对多 system 消息兼容性差） | 回退为单 system，时间放末尾 |
| 工具并行 | 高（P1） | 高（tool_call_id 顺序错乱致 400） | 仅并行化只读工具，编辑类保持顺序 |
| 会话写合并 | 中（P8） | 中（崩溃丢最近 500ms） | SIGINT 强制 flush + 缩短合并窗口 |

---

## 九、附录：与现有文档的关系

- **[ARCHITECTURE.md](file:///Users/peroluo/Document/nanobot-ts/ARCHITECTURE.md)**：描述「现在是什么」，本文档描述「应该改成什么」。
- **[TOKEN_OPTIMIZATION.md](file:///Users/peroluo/Document/nanobot-ts/TOKEN_OPTIMIZATION.md)**：成本维度的 21 项细项清单，本文档 5.3 节为其摘要，并补充了与稳定性/效率的交叉点。
- **本文档的独特价值**：
  1. 首次系统梳理**稳定性**问题（S1~S12），其中 S1/S3/S5/S7 在前述文档中未涉及；
  2. 首次系统梳理**响应效率**问题（P1~P10），其中 P1/P2/P4/P7 是前述文档未覆盖的；
  3. 提出 **6 个架构级根因**（A1~A6），把三个维度的散点问题收敛到可统一治理的根因层；
  4. 给出带**工时/风险/回滚**的实施路线图，可直接进入排期。

---

*文档基于源码静态分析生成，版本：nanobot v0.2.2。如代码重构后行号偏移，请