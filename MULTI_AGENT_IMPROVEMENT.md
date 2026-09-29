# @aipack-ai/multi-agent 改进文档

> 评审范围：`packages/multi-agent`（v1.1.6）
> 评审日期：2026-09-29
> 总体评价：**7/10** —— 架构设计工业级（分层清晰、五种编排模式可组合、类型完整、MCP 集成有前瞻性），但存在 4 个"API 承诺了但未实现"的契约性 Bug，以及若干一致性与健壮性问题。

---

## 一、P0：契约性 Bug（API 承诺但未兑现，建议立即修复）✅ 已修复（2026-09-29）

> 修复记录见 `.changeset/multi-agent-p0-fixes.md`；回归测试见 `test/multi-agent.test.ts`（共 76 个用例全部通过）。

### 1.1 Router 的 `passOriginalInput` 实际不生效 ⚠️ 最严重 ✅ 已修复

**位置**：`packages/multi-agent/patterns/router.ts:58`

**问题**：Router 的边 `transform` 从 blackboard 读取 `__original_input__`，但只有 `SupervisorExecutor` 会写入该键（`core/supervisor-executor.ts:66,84`），`GraphExecutor` 从不写入。因此默认 `passOriginalInput: true` 时，目标 Agent 永远收到的是路由 Agent 自己的输出，而非用户原始输入。

测试注释已承认该问题（`test/multi-agent.test.ts:378`）。

**修复建议**：在 `GraphExecutor.run()/stream()` 创建 ctx 后统一写入：

```ts
// core/executor.ts - executeGraph 入口处
const inputText = typeof input === 'string' ? input : input.message;
ctx.blackboard.set('__original_input__', inputText);
```

> 注意：对 `Request` 类型只取 `message` 会丢失其余字段，可考虑存原始 `input`，并在 Router transform 中按类型还原。

**测试建议**：新增"Router 传递原始输入"断言，删除现有测试中"不可用"的规避注释。

---

### 1.2 `on()` 注册的事件监听器是死代码 ✅ 已修复

**位置**：`packages/multi-agent/core/graph.ts:54-62`、`patterns/supervisor.ts:52-60`

**问题**：`AgentGraphImpl.on()` 把 listener 存入 `eventListeners`，但**没有任何代码路径触发它们**——事件实际通过 `emit` 回调流向 `stream()`。用户调用 `graph.on('agent_start', fn)` 会静默无效，属于严重的 API 契约违背。

**修复建议**（二选一）：
1. **接线**：`AgentGraphImpl` 在 `run()/stream()` 内把 `emit` 包装为同时分发到 `eventListeners`；
2. **移除**：从 `AgentGraph` 接口删除 `on()`，引导用户统一使用 `stream()`（属破坏性变更，需 major 版本）。

推荐方案 1，并在各 Executor 的 `emit` 函数处挂接。

---

### 1.3 `abort()` 是空操作 ✅ 已修复

**位置**：`packages/multi-agent/core/executor.ts:146-148`、`patterns/supervisor.ts:48-50`

**问题**：
- `GraphExecutor.abort()` 调用了 `abortController.abort()`，但 `executeGraph` 主循环**从未检查 `abortController.signal`**，中止不会生效；
- `SupervisorExecutor.abort()` 方法体为空（注释已承认）；
- `DebateExecutor` / `MapReduceExecutor` 未暴露 abort。

**修复建议**：
- 在 `executeGraph` 的 `while` 循环、每次 `executeNode` 前检查 `signal.aborted`，抛出 `AbortError` 并以 `stopReason: 'aborted'` 收尾；
- 每次 `run()` 前重建 `AbortController`（当前复用同一实例，第二次 run 前 abort 过会永久失效）；
- 各模式 Executor 补齐 abort 传递（可透传给底层 `Runtime.abort()`）。

---

### 1.4 Supervisor/MapReduce 并行分支静默吞错 ✅ 已修复

**位置**：`packages/multi-agent/core/supervisor-executor.ts:196-203`、`core/map-reduce-executor.ts:160-165`

**问题**：并行无限制分支用 `Promise.allSettled`，rejected 结果被直接丢弃（注释称"已在 executeWorker 中处理"，但 `executeWorker` 是 `throw` 的），最终 `run()` 仍返回 `success: true`。只能通过 `nodeStates` 发现失败。

**附带不一致**：MapReduce 在**限制并发**分支中，任一 mapper 失败会使 `Promise.race` 立即 reject → 整体快速失败；而**无限制并发**分支静默吞错。同一模式两种失败语义。

**修复建议**：
- 引入显式失败策略选项（如 `onWorkerError?: 'fail-fast' | 'skip' | 'retry'`，默认 `fail-fast` 与顺序模式对齐）；
- 若选择保留容错语义，至少在 `MultiAgentResult` 中暴露失败列表（如 `failedAgents: string[]`）并让 `stopReason` 反映 `partial_failure`。

---

## 二、P1：一致性与正确性问题 ✅ 已修复（2026-09-29）

> 修复记录见 `.changeset/multi-agent-p1-fixes.md`；回归测试见 `test/multi-agent.test.ts`（共 89 个用例全部通过）。

### 2.1 图状态不重置，二次 run 残留旧状态 ✅ 已修复

**位置**：`core/executor.ts:114-119`（及各模式 Executor 同款）

**问题**：`GraphExecutionState` 是实例字段，`run()` 前不重置；同一 graph 对象第二次 `run()` 时 `nodeStates` 仍是上次的 `completed/failed`，`stepsCompleted` 也从旧值累加。

**修复建议**：在每次 `run()/stream()` 入口处重置 state：

```ts
private resetState(): void {
  this.state = { nodeStates: new Map(), nodeResults: new Map(), stepsCompleted: 0, finished: false };
  for (const id of this.nodes.keys()) this.state.nodeStates.set(id, 'pending');
}
```

### 2.2 `getState()` 浅拷贝导致内部状态可被外部篡改 ✅ 已修复

**位置**：`core/executor.ts:142-144` 等

**问题**：`{ ...this.state }` 只拷贝一层，`nodeStates`/`nodeResults` 仍是同一 Map 引用，外部修改会直接影响内部状态。

**修复建议**：深拷贝两个 Map，或改为返回只读快照类型。

### 2.3 `split()` 被调用两次（副作用放大） ✅ 已修复

**位置**：`core/map-reduce-executor.ts:62` 与 `:130`

**问题**：`run()` 先调 `split()` 校验，`executeMapReduce()` 内再调一次。若用户 `split` 含副作用（如打日志、消耗配额），会执行两次；且极端情况下两次结果不同会导致校验失效。

**修复建议**：split 一次后传递结果。

### 2.4 MapReduce 虚拟节点 ID 与 nodeStates 键不一致 ✅ 已修复

**位置**：`core/map-reduce-executor.ts:138-147`

**问题**：`nodeResults` 用虚拟 ID（`mapper_0`、`mapper_1`…），但 `nodeStates` 只登记 `mapper` 原始 ID，运行中状态查询不完整。

**修复建议**：为每个虚拟 ID 同步登记 `nodeStates`。

### 2.5 Debugger 的 `trace()` 结果字段失真 ✅ 已修复

**位置**：`extensions/debug.ts:151-163`

**问题**：
- `result.content` 取 `state.error ?? ''`，但 `GraphExecutor` **从不设置 `state.error`**，因此 trace 永远报告 `success: true`；
- `TraceStep.input` 永远为空串（`agent_start` 事件不含输入信息）。

**修复建议**：
- 在 `GraphExecutor` 的 catch 分支补写 `this.state.error = errorMsg`；
- 给 `agent_start` 事件增加 `input` 摘要字段（或在事件中带上 truncated input）。

### 2.6 环图超限静默截断 ✅ 已修复

**位置**：`core/executor.ts:277-301`

**问题**：`MAX_VISITS_PER_NODE = 10` 硬编码防死循环，超限时直接 `break`，`stopReason` 仍是 `'completed'`，调用方无法区分正常完成与安全截断。

**修复建议**：超限时设置 `stopReason: 'max_visits_exceeded'`，并考虑将阈值提为 `GraphOpts.maxVisitsPerNode` 可配置项。

### 2.7 Router 的 `defaultTarget` 是摆设 ✅ 已修复

**位置**：`patterns/router.ts:68-72`

**问题**：代码块为空，注释把责任转嫁给用户的 `resolve` 函数。

**修复建议**：在 Router 构建时为 `defaultTarget` 追加一条兜底无条件边（`condition: () => resolvedId 不匹配任何 target 时命中`），或在 `resolve` 返回未知 ID 时显式抛出带指引的错误。

---

## 三、P2：能力增强建议（中期）✅ 已完成（2026-09-29，除 3.5 缓做）

> 变更记录见 `.changeset/multi-agent-p2-features.md`；回归测试见 `test/multi-agent.test.ts`（共 104 个用例全部通过）。

### 3.1 核心图支持并行分支 ✅ 已实现

`executor.ts:289` 目前"多条边匹配时只取第一条"（P0 注释已说明）。`MultiAgentEvent` 中 `parallel_start/parallel_done` 已定义但核心图不会触发。建议实现 fan-out/fan-in：

- 多条条件边匹配 → `Promise.all` 并行执行，`parallel_done` 后合并结果再沿下游汇聚边传递；
- 与 `concurrency` 选项打通，复用 Supervisor 已有的限流实现。

### 3.2 Supervisor `auto` 调度升级为真依赖分析 ✅ 已实现

当前 `executeWorkersAuto` 只按"有无 `inputMapping`"粗暴分两批。建议：

- 允许 worker 声明显式依赖（如 `dependsOn: string[]`）；
- 或对 `inputMapping` 源码做静态分析（检测读取了哪些 `${id}_result` 键）构建 DAG，按拓扑分层并行。

### 3.3 统一 stream 的 push-pull 队列实现 ✅ 已实现

`GraphExecutor` / `SupervisorExecutor` / `DebateExecutor` / `MapReduceExecutor` 四处复制了几乎相同的 eventQueue + resolveEvent 逻辑（各约 30 行）。建议抽为公共工具：

```ts
function createEventStream(execute: (emit: (e: MultiAgentEvent) => void) => Promise<void>): AsyncGenerator<MultiAgentEvent>
```

### 3.4 重试与超时机制 ✅ 已实现

各 Executor 均无节点级重试/超时。建议在 `AgentNode` 层增加：

```ts
retry?: { maxAttempts: number; backoffMs?: number };
timeoutMs?: number;
```

在 `executeNode` 中统一实现（`Promise.race` + 重试循环），对 LLM 调用的网络抖动场景价值很高。

### 3.5 blackboard 命名空间化 ⏸️ 暂缓（breaking，待 major）

目前混合了框架键（`__original_input__`、`tasks`、`mapper_results`、`${id}_result`）与用户键，存在撞名风险（用户 Agent 名恰好叫 `mapper` 等）。建议：

- 框架保留键统一加前缀 `__ma__:original_input`；
- worker 结果写入键可配置，避免用户数据被覆盖。

### 3.6 测试补强 ✅ 已完成

- 修复 1.1 后移除 `test/multi-agent.test.ts:378` 附近的规避注释，补原始输入传递断言；
- 补充：二次 `run()` 状态隔离、abort 生效、并行分支失败传播、`split` 副作用只执行一次；
- Mock Runtime 已很好，建议再加一个"慢 Runtime"（延迟 resolve）用于验证并发与 abort 时序。

---

## 四、修复优先级路线图

| 优先级 | 事项 | 预估工作量 | 风险 | 状态 |
|---|---|---|---|---|
| P0-1 | Router `__original_input__` 写入时机（1.1） | 0.5h | 低 | ✅ 已修复 |
| P0-2 | `on()` 事件接线（1.2） | 1h | 低 | ✅ 已修复 |
| P0-3 | abort 生效 + Controller 重建（1.3） | 2h | 中 | ✅ 已修复 |
| P0-4 | 并行失败策略统一（1.4） | 3h | 中 | ✅ 已修复 |
| P1 | 状态重置 + getState 深拷贝（2.1/2.2） | 1h | 低 | ✅ 已修复 |
| P1 | split 单次调用、虚拟 ID 对齐、trace 失真（2.3–2.5） | 2h | 低 | ✅ 已修复 |
| P1 | 环图 stopReason、defaultTarget 落地（2.6/2.7） | 2h | 低 | ✅ 已修复 |
| P2 | 并行分支、依赖调度、stream 去重、重试（3.1–3.4） | 按项排期 | 中高 | ✅ 已实现 |

### P0 修复实现摘要

- **P0-1**：新增 `storeOriginalInput()`（`core/context.ts`），四个执行器在 run/stream 入口统一写入 `__original_input__`。
- **P0-2**：执行器新增 `setEventSink()`；各模式 Impl 用 `SimpleEventBus` 按 `MultiAgentEvent.type` 分发 `on()` 监听器；`run()` 也补发 `graph_done`/`graph_error`（原先仅 stream 有）。导出 `GraphAbortedError`。
- **P0-3**：各执行器 run/stream 前重建 `AbortController`，在节点边界（图遍历循环/Debate 轮次/worker 与 mapper 执行前）检查中止信号；中止结果 `stopReason: 'aborted'` 并保留最后完成节点输出；`Supervisor`/`Debate`/`MapReduce` 的 `abort()` 透传到底层执行器。
- **P0-4**：`SupervisorOpts.onWorkerError` / `MapReduceOpts.onMapperError` 新增 `'fail-fast'`（默认）| `'skip'`；两条并发路径（限流/非限流）语义一致；`skip` 模式暴露 `MultiAgentResult.failedAgents` + `stopReason: 'partial_failure'`；全部 mapper 失败时报错。
- ⚠️ **默认行为变更**：原先被静默吞掉的并行失败现在默认 fail-fast；需要旧行为显式配置 `onWorkerError/onMapperError: 'skip'`。

### P1 修复实现摘要

- **2.1/2.2**：四个执行器新增 `resetState`（Supervisor 融入 `resetRun`，Debate/MapReduce 融入 `resetAbortController`），run/stream 前重置 `nodeStates/nodeResults/stepsCompleted`；`getState()` 深拷贝两个 Map；`run()` 错误路径 `agentResults` 改为 Map 拷贝。
- **2.3**：MapReduce 抽取 `splitInput()`，split 每次 run/stream 只调用一次。
- **2.4**：`nodeStates` 为每个子任务登记虚拟 ID（`mapper_0`…），随执行流转 pending→running→completed/failed，与 `nodeResults` 键一致。
- **2.5**：`agent_start` 事件新增 `input` 摘要字段（`toInputText` 工具函数，各执行器填充）；Debugger `trace()` 从 `graph_done` 捕获真实最终结果（success/content/stopReason），各执行器失败时写 `state.error`。
- **2.6**：环图节点访问超限时 `stopReason: 'max_visits_exceeded'`（原为 `'completed'`）。
- **2.7**：Router 的 `resolve` 返回未知目标 ID 时自动回退 `defaultTarget`（`resolveTarget` 包装）。
- ⚠️ **行为变更**：环图截断的 `stopReason` 值由 `'completed'` 改为 `'max_visits_exceeded'`。

### P2 实现摘要

- **3.1 并行分支**：`GraphExecutor.executeGraph` 遍历升级为 wave 模式——frontier 节点的多条匹配出边并行执行（`executeWave`，fail-fast + `concurrency` 限流池），发出 `parallel_start`/`parallel_done`；同目标节点去重（取首条入边）；`createAgentGraph(opts)` 支持 `concurrency`/`maxVisitsPerNode`。
- **3.2 依赖 DAG**：`AgentNode.dependsOn` 显式声明依赖；`executeWorkersAuto` 构建依赖表（显式 dependsOn 优先；无 dependsOn 但有 inputMapping 隐式依赖第 0 层，保持向后兼容），Kahn 拓扑分层，同层并行（限流）、层间顺序；引用不存在 Worker 或成环时报错。
- **3.3 stream 去重**：新增 `core/event-stream.ts` 的 `createEventStream(emit => promise, sink)`，四个执行器各约 30 行的重复 push-pull 队列统一收敛。
- **3.4 重试/超时**：`executeNode` 内实现（`executeNodeOnce` + 重试循环）；`timeoutMs` 用 `Promise.race` 实现，超时抛 `NodeTimeoutError`（已导出）；超时与失败均计入重试。
- **3.5 blackboard 命名空间化**：暂缓——框架保留键（`__original_input__`、`tasks`、`${id}_result`、`mapper_results`）已被文档化，统一加 `__ma__:` 前缀属破坏性变更，待 major 版本处理。
- **3.6 测试**：新增 15 个用例（并行分支/汇聚/失败传播/限流/可配置上限、dependsOn 分层/错误/成环/隐式兼容、retry 成功/超限/backoff、timeout/timeout+retry、异步 mock Runtime `createAsyncMockRuntime`），共 104 个用例。

---

## 五、值得保留的优点

修复问题的同时，以下设计决策值得保持：

1. **模式统一返回 `AgentGraph` 接口**——Pipeline 可作为 Supervisor 的 worker，组合性强；
2. **`AgentNode.runtime` 双形态（实例或创建选项）+ WeakMap 缓存**——使用体验好；
3. **`MultiAgentEvent` 事件模型**——粒度到 agent 级，Debugger/MCPBridge 均可复用；
4. **MCPBridge 双向集成**（`asTools()` / `toMcpServerHost()`）——直接对接 Claude Desktop 生态；
5. **中文注释与 P0–P3 演进路线标注**——可维护性好；
6. **测试不依赖真实 LLM API**——CI 友好。
