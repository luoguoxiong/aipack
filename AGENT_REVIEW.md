# `@aipack-ai/agent` 包评估报告

> 评估日期：2026-08-16
> 评估对象：`packages/agent`（v0.2.1）
> 评估方式：源码逐文件审查 + 关键路径验证
> 更新记录：
>
> - 2026-08-16（一）：修复缺陷 1、2（及附带的缺陷 4）
> - 2026-08-16（二）：修复缺陷 3、5、6、7、8、10；剩余缺陷 9（并入溢出自动恢复闭环优化）
> - 2026-08-16（三）：完成溢出自动恢复闭环，修复缺陷 9 —— 全部缺陷清零
> - 2026-08-16（四）：完成扩展项「自动上下文压缩」（内置摘要压缩，见三、可扩展）

---

## 总评

整体质量高于典型自研框架：

- ✅ 会话持久化采用 temp + rename 原子写入
- ✅ 跨进程文件锁（O_EXCL + 陈旧锁回收含持有进程存活探测 + 指数退避）
- ✅ TaskGraph 带环检测（visiting set）
- ✅ 重试带指数退避 + jitter，AgentError 分类优先，abort 类错误明确不可重试
- ✅ 上下文溢出三模式检测（显式 / 静默 / 截断），覆盖 15+ 供应商错误文案
- ✅ 5 个内建 Transformer（tool-pairing / state-snapshot / truncation / token-budget / system-message-cleaner）
- ✅ 20 个测试文件，含专门的 session-lock 并发测试
- ✅ 运行时依赖仅 2 个（@sinclair/typebox、partial-json）

评估时发现以下问题，截至 2026-08-16（三）已全部修复。

---

## 一、缺陷（按严重程度）

### 🔴 严重

#### 1. 陈旧锁回收可导致双写（数据竞争）— ✅ 已修复（2026-08-16）

**位置**：`packages/agent/session/file.ts`（修复前 L194-203，现 L192-254）

锁持有超过 `lockStaleMs`（默认 300s）就被其他进程回收。但 Runtime 的一次 run 完全可能超过 5 分钟：

- `maxTurns` 默认 50 轮
- `toolTimeoutMs` 默认 120s/工具

长任务执行中锁被回收 → 第二个进程获得锁 → **两进程同时写同一会话文件**。

**修复**：陈旧锁回收前读取锁文件首行 pid，用 `process.kill(pid, 0)` 探测持有进程存活（EPERM 视为存活、ESRCH/EINVAL 视为死亡）——已死才回收接管，存活则继续指数退避等待直至 `lockWaitMs` 超时报错。长任务持有的活跃锁不再被误夺，根治双写；pid 被操作系统复用时误判为存活仅导致等待超时（安全方向，不冒数据风险）。

**验证**：`session-lock.test.ts` 新增「陈旧锁不回收：持有进程仍存活时等待而非接管」；原「陈旧锁回收」测试改用真实死亡 pid（spawn 子进程等待退出），全量 441 测试通过。

#### 2. `maxTurns` 耗尽无任何标记 — ✅ 已修复（2026-08-16）

**位置**：`packages/agent/runtime/index.ts`（runLoop / runLoopStream / buildResult）

`while (maxTurns-- > 0)` 自然耗尽后，`buildResult` 的 `stopReason` 取自最后一条 assistant 消息（通常是 `tool_use`），没有 `max_turns` 标记。`terminateReason` 有专门处理，但回合上限截断没有：

- 调用方无法区分"正常完成"和"被截断"
- 模型可能还有未完成的工具调用意图
- 遥测上看不到截断事件

**修复**：

- `Compilation` 新增 `maxTurnsExhausted` 字段（`core/runtime.ts`）
- `runLoop` / `runLoopStream` 在循环条件失效退出（`maxTurns < 0`，区别于 break 退出）时设置该标记
- `buildResult` 据此输出 `stopReason: 'max_turns'` + `metadata.maxTurns: true`，与 hook 终止的 `'terminated'` 明确区分

**验证**：`runtime.test.ts` 新增「达到上限时 stopReason 标记为 max_turns」及正常完成的反向断言。

**行为变化**：此前 maxTurns 截断的 run 返回最后一条 assistant 的 stopReason（通常 `toolUse`），现返回 `max_turns`——可观测性改进。

---

### 🟡 中等

#### 3. 损坏会话被静默清零 — ✅ 已修复（2026-08-16）

**位置**：`packages/agent/session/file.ts` load()

`JSON.parse` 失败返回 `null`（注释自述"损坏视为无会话"），下次 `save` 直接覆盖 → **整段历史无告警丢失**。

**修复**：load 区分「读取失败」（无会话）与「解析失败」（损坏）——损坏时将原文件改名 `.json.corrupt` 保留待人工抢救，且 `.corrupt` 不会出现在 `list()` 结果中。

**验证**：`session.test.ts` 新增「损坏的会话文件 load 返回 null 并改名 .corrupt 保留」。

#### 4. `release()` 与注释不符 — ✅ 已修复（2026-08-16，随缺陷 1 一并修复）

**位置**：`packages/agent/session/file.ts`（修复前 L183-188）

注释说"仅删除自己创建的锁文件"，实现却无条件 `unlink`。结合缺陷 1，可能删掉别人的锁。

**修复**：锁文件写入时附带唯一 token（`pid\n时间戳\nuuid\n`），`release` 时读取内容完全匹配才 `unlink`——即使自己的锁被陈旧回收且被他人接管，也不会误删他人的锁。

**验证**：`session-lock.test.ts` 新增「release 归属校验：锁被他人接管后不误删」。

#### 5. `list()` 串行 N+1 全量读取 — ✅ 已修复（2026-08-16）

**位置**：`packages/agent/session/file.ts` list()

为判断过期逐个串行读取并解析完整 JSON。会话多时列举很慢。

**修复**：改为 `Promise.all` 并发读取判断过期，行为不变（过期清理、损坏跳过、无法解码跳过）。

---

### 🟢 轻微

| #   | 状态 | 问题                                 | 位置                                   | 说明与修复                                                                                                          |
| --- | ---- | ------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 6   | ✅   | 429 重试忽略 `Retry-After`           | `ai/retry.ts`                          | 已修复：新增 `extractRetryAfterMs`（秒数/HTTP-date），延迟取 `max(退避, Retry-After)` 并以 `maxDelayMs` 封顶        |
| 7   | ✅   | `waitForIdle` 无超时参数             | `core/runtime.ts` / `runtime/index.ts` | 已修复：`waitForIdle(sessionKey?, timeoutMs?)`，超时 reject 并从等待队列移除自己（无残留）；SessionManager 同步转发 |
| 8   | ✅   | `tmp` 残留无清理                     | `session/file.ts`                      | 已修复：`list()` 顺带清理 mtime 早于 `lockStaleMs` 的 `.tmp`（不误删正在写入的）                                    |
| 9   | ✅   | 溢出检测依赖调用方传 `contextWindow` | `ai/overflow.ts`                       | 已修复（2026-08-16）：runtime 接线统一传 `model.contextWindow`（见下方"溢出自动恢复闭环"），检测不再依赖调用方      |
| 10  | ✅   | 网络错误重试靠字符串匹配             | `ai/retry.ts`                          | 已缓解：优先检查 cause 链系统错误码（ECONNRESET 等，最多 3 层），字符串匹配降级为兜底                               |

#### 11. 溢出自动恢复闭环（含缺陷 9）— ✅ 已完成（2026-08-16）

**位置**：`runtime/index.ts`（modelTurnWithRecovery / truncateForOverflow）、`ai/overflow.ts`

检测代码此前已写好但从未接入 runtime，恢复完全靠人工配 transformer。现形成闭环：

- **接线**：runtime 在每回合模型调用后用 `isContextOverflow(message, model.contextWindow)` 统一检测（解决缺陷 9：不再依赖调用方传 contextWindow），覆盖显式错误 / 静默溢出 / 截断溢出三模式
- **恢复**：显式错误或零产出截断溢出 → 丢弃错误消息 → `truncateForOverflow` 按 token 预算从最旧开始截断（预算随次数指数收紧 `window × ratio × 0.5^n`，且至少丢弃可丢部分一半，保证重试规模必然缩小）→ 经 `ensureToolPairing` 修复配对 → 同回合重试（不消耗回合数，单回合上限 2 次）
- **静默溢出**（stop + 有完整产出）：回复保留，仅压缩旧上下文供后续轮次
- **兜底**：恢复耗尽或单请求超窗（无可丢弃）时维持旧行为（错误消息落库、返回失败）
- **可观测**：恢复重试上报 `onRetry` 遥测（errorClass='context-overflow'）；流式路径吞掉可恢复的 error chunk（消费者看不到瞬态错误），不可恢复时补发
- **检测增强**：`OVERFLOW_PATTERNS` 新增 `[context-overflow]` 分类前缀模式（覆盖消息体不含已知关键词但已带框架分类前缀的场景）；`isContextOverflow` 参数放宽为最小形状 `OverflowProbeMessage`（兼容 core 的可选 stopReason/usage）

**验证**：`runtime-extended.test.ts` 新增 7 个测试（恢复成功 / 重试耗尽 / 单请求超窗 / 静默溢出压缩 / 流式 chunk 吞与补 / onRetry 遥测），agent 包 457 测试、monorepo 6 包 661 测试全部通过。

---

## 二、可优化

| 项                      | 位置                           | 建议                                                                                                                        |
| ----------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 会话列举性能            | `session/file.ts` list()       | 并发读取 + 侧车元数据                                                                                                       |
| 429 退避策略            | `ai/retry.ts`                  | 解析 `Retry-After`（秒数或 HTTP-date），取 `max(退避, Retry-After)`                                                         |
| 溢出检测自动接入        | `runtime/index.ts`             | ~~检测到 `isContextOverflow` 后自动触发 `truncation` transformer 重试~~ ✅ 已完成（2026-08-16，见缺陷 11 溢出自动恢复闭环） |
| 实现文件过大            | `runtime/index.ts`（1583 行）  | runLoop / 持久化 / 埋点 / 锁逻辑可拆分为独立模块                                                                            |
| Gemini 走 OpenAI 兼容层 | `ai/catalog.ts:44-46`          | 原生 API 的 thinking config、并行工具调用能力受限，值得原生适配                                                             |
| 流式错误传播            | `runtime/index.ts` stream 路径 | error 事件既写入 assistantMessage 又作为 chunk 产出，调用方可能收到双重信号，文档需明确约定                                 |

---

## 三、可扩展

### 模型层

- **原生供应商适配**：Google Gemini（原生 API）、Azure OpenAI（deployment 路径）、Bedrock / Vertex、Ollama 本地推理
- **结构化输出**：JSON Schema 强约束生成（目前只有 `partial-json` 容错解析）
- **成本核算**：`usage` 已采集，缺价格表换算出金额（遥测事件直接带 cost）
- **多模型 fallback / 路由**：主模型 429 / 溢出自动切换备用模型

### Agent 层（对比 Vercel AI SDK / Mastra）

- **子代理 / 嵌套 Runtime**：目前单层循环，无 spawn 子 agent 能力
- ~~**自动上下文压缩**：`compaction_summary` 资源类型已定义（`core/context-resource.ts:17`）但无内建压缩 transformer，长会话只能硬截断~~ ✅ 已完成（2026-08-16，见下方"内置摘要压缩"）
- **Human-in-the-loop 深化**：permission 模块已有，可加异步审批（挂起等待外部批准后继续）
- **工具生态**：`registerTools` 之外支持从 npm 包自动发现工具

### 存储层

- **多后端**：Redis / SQLite SessionStorage 实现（接口已抽象好，加后端成本低）
- **会话导出 / 导入**：`export() / import()`，备份与迁移场景

### 内置摘要压缩 — ✅ 已完成（2026-08-16）

**位置**：`runtime/index.ts`（maybeCompactByThreshold / compactOrTruncate / recoverFromOverflow / summarizeMessages）、`core/runtime.ts`（CompactionOptions）、`telemetry/index.ts`（onCompaction）、`context-resource/index.ts`（pinned）

三级降级链：用户自定义压缩 transformer → 内置摘要压缩 → 硬截断。`RuntimeOptions.compaction` 配置后启用（未配置保持旧行为，向后兼容）：

- **阈值触发**（主路径，低频）：runLoop 每轮模型调用前检查，估算 token 超 `contextWindow × triggerRatio`（默认 0.8）时压缩到 `targetRatio`（默认 0.5）——最新消息保留目标一半，其余序列化后经模型通道生成摘要，替换为单条 `compactionSummary` 消息
- **溢出恢复联动**：`truncateForOverflow` 升级为 `recoverFromOverflow`（摘要优先、截断兜底）；被压缩段序列化超摘要预算（窗口 0.6）时不发 doomed 请求，直接降级截断；`onOverflow: false` 可关闭溢出路径摘要（仅快速截断重试）
- **失败安全**：摘要调用失败（错误/中止/空产出）降级纯丢弃（旧行为），不影响主流程；压缩后经 `ensureToolPairing` 修复保留段配对
- **资源层**：`compactionSummary` 消息 ↔ `compaction_summary` 资源（`pinned: true`，截断类转换器不可移除）；发出前经 `buildContext` 转为带标注的 user 消息（provider 适配层仅支持 user/assistant/toolResult）；旧摘要/状态快照在再压缩时融入新摘要
- **可观测**：新增 `onCompaction` 遥测（mode=summary/truncate、trigger=threshold/overflow、tokensBefore/After、droppedMessages）；摘要调用计入 `onModelCall`（成本对账）

**配置**：`compaction: { enabled?, triggerRatio?, targetRatio?, onOverflow?, prompt? }`

**验证**：`compaction.test.ts` 新增 8 个测试（阈值摘要 / 摘要失败降级 / enabled false / 未配置旧行为 / 溢出恢复摘要 / 资源 pinned × 3），agent 包 465 测试、monorepo 6 包 669 测试全部通过。

---

## 优先级建议

1. ~~**先修**：缺陷 1（锁竞态）+ 缺陷 2（maxTurns 标记）—— 正确性问题~~ ✅ 已修复（2026-08-16，含附带的缺陷 4）
2. ~~**次修**：缺陷 3（损坏会话保护）+ 429 Retry-After~~ ✅ 已修复（2026-08-16，同批完成缺陷 5、7、8、10）
3. ~~**高收益优化**：溢出自动恢复闭环 —— 检测代码已写好，只差接线（顺带解决缺陷 9）~~ ✅ 已完成（2026-08-16，见缺陷 11）
4. ~~**规划扩展**：自动上下文压缩 > 子代理 > 多模型 fallback~~ 「自动上下文压缩」✅ 已完成（2026-08-16），下一项：子代理 > 多模型 fallback
