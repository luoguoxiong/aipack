# aipack —— 简历写法 + 面试题库

> 项目概况：9 个 npm 包 · 333 个 TS/TSX 文件 · 约 7.4 万行 · 53 个测试文件 · 224 commits
> 技术栈：TypeScript 5.5+ · Node.js 18+ · pnpm workspace / tsup / Changesets · Tapable 插件架构 · MCP · BM25 / 向量混合检索 · SQLite · React + Vite

---

## 一、简历写法

### 1. 项目条目（直接粘贴版）

**aipack —— 轻量级 TypeScript AI Agent 框架**（个人开源项目，独立开发）

**技术栈**：TypeScript 5.5+ · Node.js 18+ · pnpm workspace / tsup / Changesets · Tapable 插件架构 · MCP · BM25 / 向量混合检索 · SQLite · React + Vite

**项目地址**：github.com/luoguoxiong/aipack ｜ 已发布 9 个 npm 包（`@aipack-ai/*`）

自研零外部依赖的 Agent 运行时，采用 Runtime + Extension + Transformer 三段式架构，支持 13+ 模型提供商、流式/同步双入口、MCP 双向生态与多 Agent 编排。

- **框架内核**：设计「请求 → 任务图 → 上下文转换 → 模型调用 → 工具执行」的核心调度循环；实现自研 Tapable 钩子系统（Sync / AsyncSeries / Waterfall + stage 优先级 + 单插件失败隔离），支撑 6 类插件零侵入接入
- **长上下文治理**：实现五级压缩策略（工具输出裁剪 → 消息摘要 → 任务状态提取 → 会话检查点 → 跨会话交接）+ 上下文溢出自动探测恢复（识别 error / 零产出 / thinking 耗尽 / output 打满四类可恢复截断，预算按 `0.5^n` 指数收紧、摘要优先硬截断兜底，同回合重试不消耗回合数）
- **长期记忆插件**：零依赖实现 BM25 倒排索引，针对中日韩设计 bigram 分词；通过 `score/Σidf` 把无界 BM25 分映射到 `[0,1]` 与 cosine 同量纲；BM25 与向量双路独立召回加权融合，解决「向量召回被 BM25 top-K 封顶」问题；增量窗口合并将去重从 O(N²) 降为增量
- **MCP 双向打通**：不依赖官方 SDK，自研 JSON-RPC 2.0 编解码与 MCP 协议子集，实现 stdio / Streamable HTTP / SSE 三种传输、协议版本协商降级、未知 content block 降级；既包装外部 MCP 工具为原生 Tool，也把框架工具反向暴露为标准 MCP Server
- **可靠性工程**：会话文件存储采用 `temp + rename` 原子写、损坏文件转储 `.corrupt`、跨进程文件锁（`O_EXCL` 独占创建 + 持有进程 `kill(pid,0)` 存活探测 + 指数退避 jitter + token 归属校验）；实现权限策略 + 跨进程人工审批（HITL）
- **可观测性**：埋点 SDK（失败本地缓存补报）+ SQLite 落盘收集服务 + Dashboard + Prometheus `/metrics` 导出，覆盖 Token 用量、TTFT、工具成功率、错误分类

### 2. 不同岗位方向的侧重点

| 目标岗位 | 标题改成 | 突出这 3 条 |
| --- | --- | --- |
| AI Agent / LLM 应用 | AI Agent 框架（TypeScript） | 上下文压缩与溢出恢复、混合检索记忆、工具循环与权限 |
| Node.js / 基础设施 | Node.js 框架与 SDK 开发 | 插件架构与钩子系统、并发与文件锁、协议解析（SSE / JSON-RPC） |
| 全栈 | AI Agent 框架 + 可观测性平台 | 全链路埋点、SQLite 聚合 + Dashboard + Prometheus、monorepo 工程化 |

### 3. 电梯陈述（30 秒，背下来）

> 这是一个我自己从零写的 TypeScript Agent 框架，不依赖 LangChain 之类的任何外部框架。核心是一个 Runtime 调度循环，插件通过自研的 Tapable 钩子挂在生命周期上，记忆、压缩、MCP、Skills 这些能力全是插件。我重点解决了两个真实痛点：一是长对话上下文爆炸，做了五级压缩和溢出自动恢复；二是记忆检索，零依赖实现了支持中日韩的 BM25 + 向量双路召回。另外 MCP 协议也是自己实现的，没用官方 SDK。

---

## 二、面试题库（按追问深度分层）

### A 层：项目整体（必答，答不好直接减分）

**Q1. 为什么要自己写，不用 LangChain / Vercel AI SDK / Mastra？**
要点：控制反转 vs 依赖倒置的取舍；外部框架抽象泄漏（改一处要跟上游版本）；本项目的差异化在**上下文治理**和**插件边界**，这些必须自己掌控内核。诚实补充：生态广度确实不如，所以做了 MCP / Skills 对齐开放规范来换生态。

**Q2. Runtime + Extension + Transformer 三段式，为什么这么切？三者职责边界？**
要点：**Runtime 管时序**（回合循环、中断、并发）；**Extension 管事件**（钩子，不改数据流）；**Transformer 管数据**（上下文数组，顺序链式、上一个输出是下一个输入）。追问准备：为什么 Transformer 不用钩子实现？→ 因为它是**有序的、可组合的数据管道**，钩子的 stage 排序表达不了「输出必须作为输入」的语义。

**Q3. 一次 `runtime.stream()` 从请求到结果，完整链路是什么？**
要点：校验 / 标准化 → `beforeInitialize` / `afterInitialize` → `beforeRun`（waterfall，可改请求）→ 从存储 hydrate 历史 → 构造 Compilation → 追加 user 消息 → **回合循环**：`transformMessages` → 阈值压缩检查 → 模型调用（含溢出恢复）→ push assistant → 落盘 → 抽取 tool_calls → 有则执行工具（并行 / 串行）→ 落盘 → 回到循环；无则 break → `buildResult` → `beforeEmit` / `afterEmit` / `done` → yield done → finally 持久化。
加分点：**每次 assistant 产出和工具结果都会实时落盘**，中断也能看到最新会话。

**Q4. 架构里最大的技术难点是什么？**
用「溢出恢复」或「文件锁」二选一深讲，见 D / E 层。

**Q5. 9 个包怎么组织？为什么做 monorepo？**
要点：pnpm workspace + tsup 构建 + Changesets 发版；`@aipack-ai/agent` 是 peer 依赖，插件包不反向依赖彼此，保证插件可单独安装。

### B 层：插件与扩展机制

**Q6. 自研 Tapable 和 webpack 的 tapable 有什么区别？为什么不直接用？**
要点：只实现了需要的三种（`SyncHook` / `AsyncSeriesHook` / `AsyncSeriesWaterfallHook`）+ `HookMap`；带 `stage` 排序；**每个 tap 独立 try/catch，失败不影响其他 tap**（插件隔离）。动机：零运行时依赖，且只需要子集。

**Q7. 钩子的失败语义：Waterfall 钩子某个 tap 抛错会怎样？**
要点：**保持当前值不变**继续往下传；`AsyncSeriesHook` 是跳过该 tap 继续；`Extension.apply()` 抛错只 warn 不影响其他插件。这是有意的「降级而非中断」设计——插件不该搞挂主流程。

**Q8. `beforeToolCall` 能做什么？为什么用 waterfall 而不是普通 hook？**
要点：可 `block`（该工具不执行，生成 `[blocked]` 结果）、`terminate`（终止整个 run）、**改写 args**。用 waterfall 是因为决策对象是**可流转修改的结构**。
补充细节：串行模式下前序工具 terminate 后，剩余工具要生成 `[skipped]` 结果保持工具调用配对（否则模型上下文里 tool_call 没有对应 result，API 会报错）。

**Q9. Skills 的「渐进式披露」怎么做？解决了什么问题？**
要点：system prompt 只注入 `<available_skills>` 目录（name + description），全文由模型通过内置 `skill` 工具按需获取。解决 skill 多了以后 prompt 爆炸。多源加载顺序 user → project → extraPaths，同名先注册者胜。

### C 层：记忆与检索算法（最容易被深挖）

**Q10. 中文为什么用 bigram 而不是单字分词？**
要点：单字 df 高、idf 低、区分度差（「数据库」vs「数据科学」全靠「数 / 据」匹配）；bigram 区分度远高于单字；奇数长度串尾部补单字，保证单字查询仍可命中。覆盖汉字（含扩展 A 区 / 兼容区）、日文假名、韩文谚文。

**Q11. BM25 原始分是无界的，你怎么和向量的 cosine（0..1）统一量纲？**
**这是本项目最漂亮的细节，一定要会讲**：`BM25Retriever` 里把 `score` 除以**查询的理论满分 `Σidf(t)`**（完全同文、tf=1、len≈avgdl 时的分数），截断到 `[0,1]`。这样完全同文 ≈ 1，部分命中按比例衰减，**绝对阈值（如 0.85）对 BM25 和 cosine 统一成立**。且该变换是单调的，对普通检索路径的 min-max 归一化幂等（排序不变）。

**Q12. 混合检索为什么要「双路独立召回」而不是「BM25 候选 + 向量重排」？**
要点：重排模式下向量召回被 BM25 的 top-K 候选池封顶——纯语义相关但关键词不命中的记忆永远进不来。双路各自召回 `top limit*3`，按 id 取并集加权融合。兼容路径：自定义 store 未实现 `searchVectors()` 时退化为重排。

**Q13. 归一化在什么时候反而有害？**
要点：min-max 会把同一查询内的次优分数压到 0，使绝对阈值失去意义。所以给 `HybridRetriever` 加了 `raw` 模式（不做归一化），专供 **consolidate 合并器**按绝对相似度判定；双路命中时取 `max`（任一来源判相似即相似）。

**Q14. 记忆合并怎么避免 O(N²) 全量两两比较？**
要点：基于 `lastConsolidatedAt` 的**增量候选窗口**，只比较上次合并后新增 / 变更的条目；配合 TTL / prune 修剪过期与低置信度条目。诚实说明：consolidate 是 best-effort，合并期间新写入留到下一轮，不保证全局原子。

**Q15. sentinel 机制解决什么问题？**
要点：记忆块随消息持久化进 session，多轮后会累积多份导致 token 膨胀（且旧记忆污染上下文）。方案：**每轮「先剥后注」**——注入前剥除所有 user 消息里的历史 sentinel 块，保证当前轮只有一个记忆块，历史 user 消息恢复为原文。

### D 层：上下文治理（强差异化，建议作为主打亮点）

**Q16. 五级压缩（L1–L5）分别在什么时机、解决什么问题？**
L1 工具输出裁剪 → L2 旧消息摘要 → L3 任务状态提取 → L4 会话检查点 → L5 跨会话交接。
**注意区分两套触发路径**：
1. `maybeCompactByThreshold`——每轮模型调用前按 `contextWindow × triggerRatio` 阈值触发（低频、主动）；
2. `recoverFromOverflow`——模型报错后被动触发。

**Q17. 你怎么判断「上下文溢出」？只看报错吗？**
**四类可恢复截断**：`stopReason === 'error'`、`usage.output === 0`、**thinking-only**（只有 thinking 块、无文本无 tool_call，说明 reasoning 预算耗尽）、**output 打满**（`output >= maxTokens × 0.95`，回复被截断）。不看 HTTP 错误码——不同 provider 报文不一样，统一从 usage + stopReason + content 探测。

**Q18. 溢出恢复怎么保证重试一定成功、不会死循环？**
要点：
1. 预算按 `contextWindow × ratio × 0.5^recovery` **指数收紧**；
2. **至少丢弃可丢弃部分的一半**（`mustDrop = floor(droppable/2)`），即使 token 估算偏小也必然缩小规模；
3. 最后一条消息（当前请求 / 最新产出）始终保留；
4. `OVERFLOW_RECOVERY_LIMIT` 上限；
5. **同回合重试不消耗回合数**；
6. 单次请求本身超窗（split = 0）时补发被吞掉的 error chunk 原样返回，不假装成功。

**Q19. 压缩后上下文会不会出现 tool_call 没有对应 result？**
要点：会，所以截断 / 摘要后都要过 `ensureToolPairing` 修复保留段的工具配对——否则 Anthropic / OpenAI 都会直接 400。

**Q20. 没有 tiktoken 怎么估算 token？误差怎么收敛？**
要点：字符启发式（ASCII 4 字符/token、CJK 1.5 字符/token，图片按 1500 token）+ LRU 缓存（避免长会话全量重算）+ **用真实 usage 回填 `recordActualUsage`，以 EMA（α=0.3）校准比例**，并过滤 ratio > 5 或 < 0.2 的噪声样本；预留 `TokenizerLike` 接口可注入真实 tokenizer。
追问：CJK 判定为什么用 `charCodeAt(0) > 0x2e80`？→ 覆盖 CJK 及全角标点区间，零依赖。

### E 层：并发、存储、可靠性（考察工程底子）

**Q21. 会话文件为什么「temp + rename」？**
要点：`rename` 在同分区是原子操作，进程中断不会留下半截 JSON。tmp 文件名带 `pid` 避免多进程互踩。

**Q22. 多进程同时写同一个会话怎么办？**
要点：Runtime 对非 ephemeral 请求全程持有**存储级锁**（「读-改-写」互斥，防止 last-write-wins 丢消息）。流式版本因为生成器不能用回调包住，改用手动 `acquireLock` / `release`，在 `finally` 释放。锁本身：`O_EXCL` 独占创建锁文件 + 内容写 `pid\n时间戳\nUUID` + 竞争方指数退避 + jitter（上限 500ms）+ 超时抛错。

**Q23. 持有锁的进程崩溃了怎么办？（经典追问）**
要点：陈旧锁回收，但**必须先探测持有进程存活**（`process.kill(pid, 0)`，EPERM 也算存活）。安全方向是「宁可等到超时报错也不冒双写风险」。另外 release 时校验锁文件内容是否还是自己写的 token——即使自己的锁被回收接管，也不会误删他人新持有的锁。

**Q24. 会话文件 JSON 损坏怎么处理？**
要点：不静默当作「无会话」（否则下次 save 直接覆盖，整段历史无痕丢失），而是 `rename` 成 `.corrupt` 保留待抢救，并返回 null。

**Q25. AbortController 怎么贯穿全链路？**
要点：每回合新建 `AbortController` 挂在 session 上；`abort()` 触发信号 → 模型流中断 → 工具超时信号级联；`AbortError` 单独识别（不打印栈、走静默路径），其他错误打印完整栈便于排障。

**Q26. 工具超时怎么算？审批等待算不算超时？**
要点：**不算**。`withTimeoutSignal` 在**权限裁决（含审批挂起）完成后才起表**，避免人工审批耗时吃掉工具执行预算。

**Q27. 并行工具调用怎么保证结果顺序和配对？**
要点：并行执行但按 tool_call 顺序回填结果；任一 `terminate` 则整体终止，剩余工具补 `[skipped]` 结果保持配对。

### F 层：协议与模型层

**Q28. 为什么自己实现 MCP 而不用官方 SDK？**
要点：官方 TS SDK 体积和依赖较重，且需要的是协议子集；自研 `jsonrpc.ts` 是**纯函数、不依赖任何 Node API**，可在任意 JS 运行时复用，stdio 传输层负责行分隔后逐条调用 `parseMessage`。

**Q29. stdio 传输的坑？**
要点：`child_process` 起子进程、按**行分隔 JSON-RPC**（需处理半包 / 粘包，缓冲区跨 chunk 拼接）；子进程 stderr 是日志通道不能当协议帧；`env` 里 `${VAR}` 未定义则跳过该 server 而非报错。

**Q30. SSE 解析为什么要写两套（`parseSSEEvents` / `extractDataLines`）？**
要点：Anthropic 风格是**事件块**（`\n\n` 分隔，含 `event:` / `data:` 多行）；OpenAI 风格是**逐行 `data:`**。规范终止符是 `\r\n\r\n`，其内部是 `\n\r` 序列不匹配 `\n\n`，所以用 `/\r?\n\r?\n/` 同时兼容 LF 与 CRLF。

**Q31. 13+ 提供商怎么统一？**
要点：标准化 `Model` 目录（id / provider / contextWindow / maxTokens / reasoning），按 `model.api` 自动分派 `streamOpenAI` / `streamAnthropic`；适配器层 `adaptAiModel` + `createStreamFnFromAi` 把模型层接到框架核心，用户零手写 streamFn。

**Q32. 协议容错具体做了哪些降级？**
要点：协议版本协商失败降级、未知 content block 降级为文本、JSON-RPC 错误统一转 `isError` 结果（不让工具异常炸穿对话）、env 变量缺失跳过 server。

### G 层：开放性与压力题（最容易翻车，提前准备）

**Q33. 你做过的最难的技术决策是什么？有没有推翻重来过？**
建议讲「向量召回被 BM25 top-K 封顶」这个 bug 的发现与修复，或「BM25 与 cosine 量纲不一致导致合并永不触发」。这两个都是**从现象反推到根因**的真实工程故事，比架构叙述有说服力。

**Q34. 这个项目的局限 / 不足是什么？（必问，答不出显得没反思）**
诚实清单，建议直接用：
- 记忆索引**全量常驻内存**，百万级需按 TTL 控制条数或外接磁盘索引
- token 估算在极端场景（代码、多语言混排）仍有误差，靠 EMA 校准只是缓解
- `consolidate` 是 best-effort，不保证全局原子
- 单 Runtime 单会话模型在多会话高并发下需要多实例，内存成本上升
- 生态广度不如成熟框架（用 MCP / Skills 对齐规范来补）

**Q35. 有量化结果吗？性能数据、用户量？**
个人项目如果没有，就讲**可验证的工程指标**：53 个测试文件、`pnpm lint` 全量 `tsc --noEmit` 通过、测试覆盖了 session-lock / compaction / approval / tool-hooks 等关键路径。不要编造下载量。

**Q36. 如果让你重做，会改什么？**
建议答：把 Transformer 从「原地修改数组」改为显式不可变管道（现在原地替换是为了保持 session 引用，是个 trade-off，代价是可测试性）；以及把记忆索引抽象出磁盘后端接口。

**Q37. 你怎么保证插件不会把主流程搞挂？**
三层隔离：tap 级 try/catch、Extension.apply 级 try/catch、**Transformer 失败跳过并告警**。再补一句：权限策略是**框架级安全底线，先于扩展钩子裁决**——插件无法通过钩子绕过权限。

**Q38. 危险命令识别怎么做？误判 / 漏判怎么权衡？**
要点：黑名单规则（rm / sudo / mkfs / dd / `curl | sh` / chmod -R 777 / shutdown / reboot / fork 炸弹）；**危险命令每次都重新确认，不受「总是允许」影响**；「总是允许」只对非危险命令生效。默认策略是「正常操作零打断」以保住体验。

---

## 三、上场前必做的 3 件事

1. **亲手复现一遍关键路径**：`pnpm cli:dev -p "..."`、`pnpm example:mcp`（离线可跑）、`pnpm --filter @aipack-ai/memory test`。面试官问「演示一下」时不至于卡壳。
2. **挑 1 个模块背到源码级**：建议选 `packages/memory/src/retrieval/`（BM25 + bigram + Σidf 归一化 + 双路融合）或 `packages/agent/runtime/index.ts` 的 `modelTurnWithRecovery`。能说出**函数名和行号级别的设计动机**，比泛泛讲架构强十倍。
3. **准备好「哪部分是你写的」的诚实回答**：框架里有参考 `rohitg00/agentmemory` 的部分（README 里已注明），主动说出来反而加分。

---

## 四、与主流 Agent 框架的对比（面试高频）

### 0. 先定好位：aipack 属于哪一类

2026 年格局：**大厂集体入场**（OpenAI Agents SDK、Google ADK 2.0、Microsoft Agent Framework 合并了 AutoGen + Semantic Kernel、Claude Agent SDK），**MCP 已成为 agent-to-tool 的事实标准**。TS 侧三强是 Mastra / Vercel AI SDK / LangGraph.js。

aipack 的准确坐标：**TypeScript 原生的轻量级 Agent Runtime 内核**，面向**本地 / 桌面 / CLI 型 Agent**（自带 CLI + Tauri 桌面端），而不是面向云上多用户服务端应用。先讲清这一定位，后面的优劣势才成立。

### 1. 横向对比表

| 维度 | **aipack** | Mastra | LangGraph.js | Vercel AI SDK | OpenAI Agents SDK |
| --- | --- | --- | --- | --- | --- |
| 定位 | Agent Runtime 内核 + 插件生态 | TS 原生全栈 Agent 框架 | 图编排（Python 优先，TS port） | 流式 UI 库 + 薄工具循环 | 官方轻量 Agent 循环 |
| 核心抽象 | Runtime + Extension + Transformer | Agent / Workflow / Step | 有向图 Node + Edge + State | `generateText` + tools | Agent / Handoff / Guardrail |
| 持久化 | 文件存储 + 跨进程锁（本地向） | Postgres / LibSQL / Inngest | Checkpointer（Postgres 为主） | ❌ 无 | 会话存储 |
| 记忆 | 自研 BM25 + 向量双路混合检索 | Memory 模块（PG/Upstash/Pinecone） | Store / checkpointer 线程 | ❌ 无 | 基础 |
| 上下文治理 | **五级压缩 + 溢出自动恢复** | 有上下文裁剪，非分级体系 | 需自行组合 | ❌ 无 | 基础裁剪 |
| MCP | **自研协议栈，双向（客户端 + 服务端）** | 支持接入 | 支持接入 | 支持接入 | 支持 |
| 多 Agent | AgentGraph + 5 种编排模式 | Workflow.parallel / 子 Agent | `Send` 原语 / 子图 | ❌ 无 | Handoff |
| Durable execution | ❌ 无（会话持久化 ≠ 工作流持久化） | ✅ Inngest / 自托管 | ✅ Checkpointer | ❌ 无 | 部分 |
| Eval 体系 | ❌ 无 | ✅ 一等公民 | ⚠️ LangSmith 耦合 | ❌ 自带 | 部分 |
| 可观测性 | 自建 SDK + SQLite + Prometheus | 需外接 | LangSmith | 需外接 | 官方 tracing |
| 依赖体积 | **零外部 Agent 框架依赖** | 依赖 AI SDK / Inngest | 依赖 LangChain 生态 | 轻 | 轻 |
| 生态 / 社区 | ⚠️ 个人项目 | ~18K star，周更 | 最成熟，但 TS 落后 Python 4–8 周 | 事实标准 | OpenAI 绑定 |

### 2. aipack 相对优势（真实成立的部分，讲这些不虚）

1. **上下文治理的粒度更细**：五级压缩 + 四类溢出探测（error / 零产出 / thinking-only / output 打满）+ `0.5^n` 指数收紧预算 + 同回合重试。Mastra 和 Vercel AI SDK 都没有这个深度的分级策略——这是 aipack 最硬的差异化。
2. **零运行时依赖 + 完全可控**：MCP、JSON-RPC、SSE、BM25、文件锁全部自研。改内核不用等上游发版，也不用跟 LangGraph TS 那种 4–8 周的 Python→TS 移植延迟。
3. **通用插件层**：自研 Tapable 钩子（Sync / AsyncSeries / Waterfall + stage 排序 + 失败隔离）是 LangGraph 那种图模型没有的东西——图模型表达的是「节点流转」，表达不了「生命周期上任意挂载 + 可改写数据」。
4. **本地场景的工程细节**：`temp + rename` 原子写、`.corrupt` 转储、跨进程 `O_EXCL` 文件锁 + pid 存活探测、危险命令识别 + 跨进程 HITL 审批。这些是云上框架不会做但本地 CLI/桌面 Agent 必须做的。
5. **端侧覆盖**：CLI + Tauri 桌面端 + Web 三端，是服务端框架的结构性空白。

### 3. aipack 明显劣势（必须主动承认，否则被当场打穿）

1. **没有 durable execution**：会话持久化 ≠ 工作流持久化。进程崩溃后能从会话恢复，但**没有 Inngest/Temporal 那种 step 级 checkpoint 与重放**。这是 Mastra 和 LangGraph 的核心卖点，aipack 确实没有。
2. **没有 eval 体系**：2026 年 eval 已经是生产 Agent 的门槛（Mastra 把它做成一等公民），aipack 完全没有。这是最大的能力缺口。
3. **生态与社区基本为零**：个人项目 vs Mastra 18K star。工具集成、provider 覆盖、issue 响应速度都无法比较。
4. **记忆索引全量常驻内存**：没有 Postgres / Pinecone / 磁盘索引后端，百万级不可行。
5. **单 Runtime 单会话模型**：多会话高并发需要多实例，内存成本线性上升。
6. **无生产验证**：没有真实流量、没有 SLA、没有大规模回归。测试是单元级的，不是生产级的。

### 4. 面试话术：怎么回答而不显得嘴硬

**Q：和 Mastra / LangGraph 比，你的框架优势在哪？**
> 正确姿态不是「我更强」，而是「**定位不同，我在某几个点上做得更深**」：
> "它们面向云上多用户的服务端应用，核心卖点是 durable workflow 和 eval；我的目标场景是本地 / 桌面 / CLI 型 Agent，所以我把力气花在了上下文治理和端侧可靠性上。比如上下文溢出恢复，通用框架一般只做简单截断，我做了四类探测 + 指数收紧预算 + 同回合重试。反过来，durable execution 和 eval 我确实没有——如果需要我会直接用 Inngest，不会自己造。"

**Q：既然有现成的，为什么还要自己写？**
> "我想搞清楚 Agent Runtime 的每一个子系统到底怎么工作。用框架我只会调 API，自己写才会被迫去解决 tool_call 配对、上下文溢出、跨进程会话锁这些真问题。这些认知迁移到任何框架上都是有效的。"

**Q：你的框架能替代 LangGraph 吗？**
> "不能，也没打算。它缺 durable execution 和 eval，生产多用户场景我不会选它。它的价值是让我把 Runtime 的每个环节都实现了一遍。"

**Q：生产上你会选什么？**
> "服务端多用户场景选 Mastra，TS 项目需要图编排且团队有 Python 侧就 LangGraph，纯 chat UI 用 Vercel AI SDK。我这个框架适合嵌到本地工具里，或者作为理解 Agent 内核的参考实现。"

### 5. 一句话总结（背下来）

> aipack 的竞争力不在「比 Mastra 强」，而在「**用 7 万行代码证明了 Agent Runtime 的每一个关键子系统我都能从零实现**」——上下文治理、混合检索、协议栈、并发存储、插件架构。它的短板（durable execution、eval、生态）我非常清楚，也不会硬吹。
