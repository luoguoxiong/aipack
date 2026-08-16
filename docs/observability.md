# @aipack-ai/agent 生产可观测性设计

> 目标：让 Agent 生产运行可量化、可诊断。覆盖指标采集、Trace 关联、成本核算、
> 存储导出、Dashboard 展示。
>
> 设计原则：
>
> - **复用现有 Telemetry 钩子**，保持"全可选、失败不阻断主流程"的既有约定；
> - **指标口径先行**，避免"数据有了但没法对账"；
> - **Trace 即 run**，模型/工具调用即 span，一次 run 的完整链路可回放；
> - 分档落地：自建轻量（默认）↔ OTLP 标准协议 ↔ LLM 专用平台（零代码）。

---

## 1. 现状盘点

已有 [telemetry/index.ts](../../packages/agent/telemetry/index.ts) 定义 4 个可选事件：

| 事件                 | 载荷                                                   | 触发点                                                            |
| -------------------- | ------------------------------------------------------ | ----------------------------------------------------------------- |
| `onRunEnd`           | sessionKey / request / durationMs / result             | [runtime/index.ts](../../packages/agent/runtime/index.ts) `run()` |
| `onToolCall`         | sessionKey / toolName / args / durationMs / result     | 工具执行完成后                                                    |
| `onModelCall`        | sessionKey / modelId / input/outputTokens / durationMs | `streamModel()` 收尾                                              |
| `onPermissionDenied` | sessionKey / toolName / permissions / args / reason    | 权限策略拒绝                                                      |

埋点经 `emitTelemetry()` 统一收口：全可选、异步等待、异常吞掉（`console.warn`）。

### 1.1 与生产可观测之间的缺口

| 缺口                          | 现状                                                                                                       | 影响                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 无 runId/traceId              | 只有 `sessionKey` 关联                                                                                     | 无法串联一次 run 内的模型/工具调用，无法做 Trace 时间线 |
| step 长度不可见               | `runLoop` 的 `maxTurns` 循环计数未上报                                                                     | 无法评估 agent 循环收敛性、防失控                       |
| 重试次数不可见                | 重试在 provider 内部 `ai/stream-openai.ts` / `ai/stream-anthropic.ts` 的 `retry()`，telemetry 只拿最终结果 | 429/5xx 重试率、退避行为无法统计                        |
| token 消耗量未上报            | provider 已还原 `usage`（input/output/cacheRead/cacheWrite，见 §2.5），telemetry 载荷未携带                | 指标与用量对不上                                        |
| `onToolCall` 无成功标志       | 只给 `ToolResult`，需接收方自行 `isErrorResult`；blocked/skipped 混入                                      | 工具成功率口径不清晰                                    |
| `stream()` 路径无 run 级事件  | 仅 `run()` 触发                                                                                            | 流式请求端到端指标缺失                                  |
| `stream()` 路径无模型调用事件 | `runLoopStream` 直接调 `_streamFn`（`runtime/index.ts` L681），不走 `streamModel()`                        | 流式请求的 token/耗时/重试全部缺失                      |
| 校验失败直接 return           | 不触发 telemetry                                                                                           | 无效请求占比统计不到                                    |
| 无入队等待时长                | 会话串行队列，`durationMs` 只含执行段                                                                      | 排队导致的延迟无法区分                                  |

---

## 2. 采集层设计（Telemetry 扩展）

核心模型：**一次 run = 一条 Trace，一次模型/工具调用 = 一个 Span**。

### 2.1 新增通用字段

```ts
// telemetry/index.ts 新增
interface TraceSpanInfo {
  /** 一次 run() 生成的全局唯一 id（ULID，含时间序） */
  traceId: string;
  /** 本次 model/tool 调用的 span id（随机 16 字节 hex） */
  spanId: string;
  /** 并行工具调用时的父 span；无则省略 */
  parentId?: string;
  /** 事件发生时间（epoch ms） */
  timestamp: number;
}

/** 统一错误分类：直接复用 ai 层已有的 AgentErrorCategory，不另造一套
 *  'retryable' | 'timeout' | 'auth' | 'context-overflow' | 'rate-limit' | 'invalid-request' | 'unknown'
 *  另加非模型错误：'tool_error' | 'terminated' | 'validation' */
type ErrorClass =
  | AgentErrorCategory
  | 'tool_error'
  | 'terminated'
  | 'validation';
```

### 2.2 事件载荷扩展

```ts
/** run() 完成事件（run() 与 stream() 均触发） */
export interface RunTelemetryInfo {
  traceId: string;
  sessionKey: string;
  request: Request;
  /** 端到端耗时（含排队 + 执行） */
  durationMs: number;
  /** 纯执行耗时（排队外） */
  activeMs: number;
  /** 入队等待时长（会话串行队列） */
  queuedMs: number;
  /** 对话轮数 = step 长度 */
  turnCount: number;
  result: Result;
  /** 直接布尔，避免接收方解析 Result */
  success: boolean;
  errorClass?: ErrorClass;
  /** 汇总后的 token 用量（input/output/cacheRead/cacheWrite） */
  tokens: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /** 流式请求首 token 延迟 */
  ttftMs?: number;
}

/** 单次工具执行事件 */
export interface ToolTelemetryInfo {
  traceId: string;
  spanId: string;
  sessionKey: string;
  toolName: string;
  args: unknown;
  durationMs: number;
  result: ToolResult;
  success: boolean;
  /** ok / error / blocked(权限拒) / skipped(前序终止) */
  status: 'ok' | 'error' | 'blocked' | 'skipped';
  errorClass?: ErrorClass;
}

/** 单次模型调用事件（含流式正常结束与错误路径） */
export interface ModelTelemetryInfo {
  traceId: string;
  spanId: string;
  sessionKey: string;
  modelId: string;
  /** 含首次调用：1 = 无重试 */
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
  durationMs: number;
  stream: boolean;
  errorClass?: ErrorClass;
}

/** run() 开始事件（配合 onRunEnd 求排队时长） */
export interface RunStartTelemetryInfo {
  traceId: string;
  sessionKey: string;
  request: Request;
  /** 进入会话队列的时刻 */
  queuedAt: number;
}

/** 单次重试事件（provider 内部 retry() 上报，per-attempt 粒度） */
export interface RetryTelemetryInfo {
  traceId: string;
  provider: string;
  modelId: string;
  /** 第几次重试（从 1 开始） */
  attempt: number;
  errorClass: ErrorClass;
  status?: number;
  /** 本次退避延迟（ms） */
  delayMs: number;
  /** false = 重试耗尽 */
  willRetry: boolean;
}

export interface Telemetry {
  onRunStart?(info: RunStartTelemetryInfo): void | Promise<void>;
  onRunEnd?(info: RunTelemetryInfo): void | Promise<void>;
  onToolCall?(info: ToolTelemetryInfo): void | Promise<void>;
  onModelCall?(info: ModelTelemetryInfo): void | Promise<void>;
  onRetry?(info: RetryTelemetryInfo): void | Promise<void>;
  onPermissionDenied?(
    info: PermissionDeniedTelemetryInfo,
  ): void | Promise<void>;
}
```

### 2.3 traceId 生成与传播

- `run()` / `stream()` 入口生成 traceId（`Date.now().toString(36) + '-' + randomUUID()`，零依赖），经参数传入 `_run`/`_stream`，挂在 `Compilation.traceId` 贯穿全程，并挂到：
  - 每个 telemetry 事件的 `traceId`；
  - `Result.metadata.traceId`（`buildResult` 时写入）；
  - assistant / toolResult message 的 `metadata`（随会话持久化）。
- 意义：**历史会话可复盘**——同一 traceId 既出现在实时指标里，也出现在持久化会话中，前端回放与诊断共用。

### 2.4 框架改动点清单（全部为增量，不破坏现有 API）

| #   | 文件                                             | 改动                                                                                                 |
| --- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 1   | `core/runtime.ts` `Compilation`                  | 新增 `traceId: string`；`RuntimeOptions` 增加可选 `traceIdGenerator?`（测试可注入）                  |
| 2   | `runtime/index.ts` `run()`/`stream()`            | 入口生成 traceId；`onRunStart`（入队前，携带 queuedAt）+ 排队时长统计；校验失败分支补 `onRunEnd`     |
| 3   | `runtime/index.ts` `runLoop`/`runLoopStream`     | 累计 `turnCount` 传给 `onRunEnd`；`buildResult` 写 `metadata.traceId`                                |
| 4   | `runtime/index.ts` 模型调用                      | 抽公共 `streamModelEvents()` 生成器：run/stream 两路径共用，统一埋 `onModelCall` + 计时 + retry 回调 |
| 5   | `runtime/index.ts` 工具执行处                    | `onToolCall` 增补 success/status（`isErrorResult` + blocked/skipped 判定，§9.5）                     |
| 6   | `ai/retry.ts` `retry()`                          | 新增可选参数 `onRetryAttempt?(info)`，仅在真正退避重试时调用                                         |
| 7   | `ai/types.ts` `SimpleStreamOptions`              | 新增 `onRetryAttempt?`，供 runtime 注入                                                              |
| 8   | `ai/stream-openai.ts` / `ai/stream-anthropic.ts` | 把 `options.onRetryAttempt` 透传给 `retry()`                                                         |
| 9   | `telemetry/index.ts`                             | 事件类型扩展（§2.2 接口）+ 导出 `ErrorClass`                                                         |
| 10  | `test/telemetry.test.ts`                         | 增补 traceId/turnCount/attempts/status/token 透传用例（§9.7）                                        |

> 变更后 `telemetry/pricing.ts` **无需新建**——token 口径由 provider 层还原，见 §2.5。

### 2.5 token 消耗量：已内建，S1 只做透传

token 消耗量**已经存在于 provider 层，S1 不需要新建 pricing 模块**：

- `Usage` 携带 `input / output / cacheRead / cacheWrite` 四类 token（[ai/types.ts](../../packages/agent/ai/types.ts)），OpenAI/Anthropic 的流式响应由 provider 还原（`prompt_tokens_details.cached_tokens` / `cache_read_input_tokens` 等）；
- `runtime.sumUsage()`（[runtime/index.ts](../../packages/agent/runtime/index.ts)）把各轮 token 汇总到会话 usage；
- 全链路成本口径统一为 **token 消耗量**：`totalTokens = input + output + cacheRead + cacheWrite`（在模型 span 累计，避免重复计数），不再按美元计价。

**S1 的工作**：`onModelCall` / `onRunEnd` 直接读取 `assistantMessage.usage` 填 `tokens` 字段即可；聚合端按上述公式累加。

---

## 3. 指标口径定义（SLO 对账基准）

> 口径必须固定，否则 Dashboard 数字与财务对不上。

| 指标         | 定义                                                                                       | 聚合维度                            | 告警建议            |
| ------------ | ------------------------------------------------------------------------------------------ | ----------------------------------- | ------------------- |
| 请求量       | `onRunEnd` 计数（含 stream）                                                               | 时间 / model / channel / sessionKey | —                   |
| 成功率       | `success=true` 且 `stopReason='completed'` 占比                                            | 同上                                | < 95%               |
| 稳定性       | 错误率按 errorClass 拆分（429 / 超时 / 上下文溢出 / 工具失败 / 未知）                      | 时间序列                            | errorClass=429 突增 |
| 响应耗时     | `durationMs`（端到端）、`activeMs`（执行）、`queuedMs`（排队）、`ttftMs`（首 token）       | p50 / p95 / p99 + 直方图            | P95 > 30s           |
| step 长度    | `turnCount` 分布；>10 步视为"循环风险"                                                     | 均值 + P95 + 直方图                 | 均值 > 8            |
| token 消耗量 | `Σ (input + output + cacheRead + cacheWrite)`（模型 span 累计，provider 已还原四类 token） | 按模型 / 天                         | 日消耗超预算        |
| 重试次数     | `onModelCall.attempts-1` 分布；重试率 = 有重试调用 / 总调用                                | 按 provider / 错误类型              | 重试率 > 20%        |
| 工具成功率   | `status='ok' / (ok + error)`，**blocked/skipped 不计入分母**                               | 按工具名                            | 某工具成功率 < 80%  |
| 权限拦截     | `onPermissionDenied` 计数                                                                  | 按工具 / reason                     | 拦截激增            |

**关键坑**：

- blocked/skipped 若计入工具分母，会稀释真实失败率 → 必须用 `status` 区分；
- 校验失败请求要单独一类，不能混进"模型失败"；
- `queuedMs` 单独统计，避免把排队延迟算进模型耗时。

---

## 4. Trace 设计

```
Trace (runId=traceId)
├── span: onRunStart ──► onRunEnd          (run 级，含 turnCount/耗时/tokens)
├── span: model call #1  (attempts=2)      (model span，带重试徽标)
├── span: tool call A    (ok, 1.2s)        (tool span)
├── span: tool call B    (error)           (并行时 parentId 指向 model span)
├── span: model call #2                    (继续下一轮)
└── span: permission denied (tool C)       (权限拦截单独成 span)
```

- **span 命名**：`model:<modelId>` / `tool:<toolName>` / `run`。
- **状态码**：`ok` / `error`，error 附带 `errorClass` 与错误消息摘要（脱敏）。
- **多进程注意**：traceId/spanId 在 runtime 内生成即可；跨进程（多实例负载均衡）场景用"进程 id + 请求头注入"扩展，单机部署无需处理。
- **回放**：traceId 持久化到会话消息，历史会话回放时同 id 从 Trace 存储拉取指标，双视角对照。

---

## 5. 存储与导出（分档落地）

### 档位 A · 自建轻量（推荐起步，零外部依赖）

```
Telemetry 实现 → 内存聚合器（滑动窗口 + 直方图） → 定时批量落盘 SQLite
                → REST API：/metrics /traces
```

- 聚合器持有最近 N 分钟的滑动窗口与 p50/p95/p99 直方图（在线维护，无需明细）；
- 明细 trace 落 SQLite（`runs` / `spans` / `tool_calls` 三张表，见附录）；
- 落盘批量异步执行，聚合器本身不阻塞 run()。

### 档位 B · 标准协议（已有观测基础设施时）

- 写可选 adapter：把 span 按 OTLP 推 OpenTelemetry Collector；
- 指标走 Prometheus，trace 走 Tempo，Grafana 统一接住；
- 仅增加一个可选依赖（`@opentelemetry/exporter-trace-otlp-http`），不强制。

### LLM 专用平台（零代码备选）

- Langfuse / Helicone：原生支持 token 成本、trace、评估；
- 只需把 `traceId` 传入，适合不想自研面板的团队。

---

## 6. 聚合器与 REST API 设计

```
GET /metrics/summary?since=&until=&groupBy=model|tool|session
  → { requests, successRate, totalTokens, p50Ms, p95Ms, p99Ms, avgTurns, retryRate }

GET /metrics/timeseries?since=&until=&step=5m&metric=successRate|tokensTotal|requests
GET /metrics/tools?since=&until=
  → [{ tool, calls, successRate, avgMs, errors }]        // 按成功率升序

GET /traces?since=&until=&status=&model=&tool=&page=
  → [{ traceId, startedAt, durationMs, status, turns, tokens, retries, sessionKey }]

GET /traces/:traceId
  → { traceId, spans: [{ kind, name, startedAt, durationMs, status, errorClass, attempts, tokens }] }
```

---

## 7. Dashboard 设计

### 7.1 布局（单页，总览 → 拆解 → 下钻）

```
┌────────────────────────────────────────────────────────────┐
│ KPI 卡片行：请求量 │ 成功率 │ Token 消耗量 │ P95 耗时 │ 平均步数 │ 重试率 │
├──────────────────────────────┬─────────────────────────────┤
│ 时间序列：请求量/成功率/Token │ 模型排行：调用量/Token/延迟 │
│ （可切 5m/1h/1d 粒度）       │ 错误率（bar）               │
├──────────────────────────────┼─────────────────────────────┤
│ 延迟分布：p50/p95/p99 分模型  │ 工具分析：次数/成功率/耗时   │
│ 对比（line）                 │ （table，标红低成功率工具）  │
├──────────────────────────────┴─────────────────────────────┤
│ 错误分析：errorClass 占比（pie）+ 429/5xx/超时趋势          │
├────────────────────────────────────────────────────────────┤
│ Trace 列表：时间/runId/session/耗时/tokens/状态/重试         │
│   └─ 点击 → Trace 详情：时间线（模型 span + 工具 span），    │
│      每步 tokens、耗时、重试标记，成功/失败 trace 并排对比   │
└────────────────────────────────────────────────────────────┘
全局筛选器：时间范围 | model | tool | sessionKey | channel | 状态
```

### 7.2 关键设计决策

1. **KPI 可下钻**：点成功率跳到错误分析区、点 P95 跳到延迟图，避免堆砌 20 张图；
2. **工具分析用 table 不用图**：工具名离散，table 一眼找出"调用少但失败率高"的工具（3 次全失败比 100 次 2% 失败更值得修）；
3. **Trace 详情是诊断核心**：span 按类型着色（模型=蓝 / 工具=绿 / 错误=红 / 权限=灰），每步标注 attempt 徽标（`×2`），失败 trace 直接标 errorClass；
4. **成功/失败 trace 并排对比**：同 session 相邻的成功/失败 trace 对照，快速定位回归点。

### 7.3 技术选型

- 自研：React/Vue + ECharts（时间序列、直方图、桑基图工具链）；
- 档位 B：Grafana（指标）+ Tempo（trace）即可，无需自研面板；
- LLM 平台：Langfuse 自带面板，本项目只需埋点。

---

## 8. 落地路径（三步，各自可独立验收）

| 步骤             | 内容                                                                            | 验收                                                                  |
| ---------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **S1 采集层**    | Telemetry 扩展 + traceId + turnCount + retry 回调 + token 透传（详细设计见 §9） | `pnpm --filter @aipack-ai/agent test` 全绿；`telemetry.test.ts` 增补用例 |
| **S2 聚合存储**  | Telemetry 实现（内存聚合 + SQLite 落盘 + REST API）                             | 跑一次 run 后 `/metrics/summary`、`/traces/:id` 返回正确数据          |
| **S3 Dashboard** | 单页面板 + Trace 详情页，接聚合 API                                             | 端到端：run → 面板图表 → trace 下钻                                   |

---

## 9. S1 采集层详细设计

> 目标：让上述 8 项指标以结构化事件从框架流出，全部为**增量改动**，现有 `Telemetry` 接口
> 实现方（onRunEnd/onToolCall/onModelCall）不受影响——新增字段只增不删。
>
> **✅ 状态：S1 已实现（2026-08-11）**，`pnpm --filter @aipack-ai/agent test` 435 用例全绿、
> workspace 10 包 typecheck 通过。实现与设计的两处偏差：
>
> 1. `onRunEnd` 在 `_run`/`_stream` 内部上报（而非 §9.2 草图的 run()/stream()），
>    因为需要访问 `compilation.turnCount` / `tokens`；
> 2. blocked/skipped 结果**不触发** `onToolCall`（权限拒绝走 `onPermissionDenied`、
>    beforeToolCall block 直接 return），因此工具成功率分母 = 实际执行的工具。
>    与既有行为一致，避免统计口径变化。

### 9.1 traceId 生命周期

```ts
// core/runtime.ts
export interface Compilation {
  /** 本次运行的全局唯一 id（run()/stream() 入口生成） */
  readonly traceId: string;
  // ...原有字段
}

// RuntimeOptions 新增（可选，测试可注入确定性 id）
traceIdGenerator?: () => string;

// runtime/index.ts
function newTraceId(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`; // 零新依赖
}
```

- `run()` / `stream()` 入口 `const traceId = (this._traceIdGenerator ?? newTraceId)()`；
- 经参数透传 `_run` → `createCompilation` → 挂到 `Compilation.traceId`；
- `runLoop` / `streamModel` 从 `compilation.traceId` 读取，不再额外传参；
- `buildResult` 写入 `metadata.traceId`；assistant message 的 `metadata.traceId` 随会话持久化。

### 9.2 run() / stream() 埋点位置

```ts
// runtime/index.ts
async run(request: Request): Promise<Result> {
  // 0. 校验请求
  const validation = validateRequest(request);
  if (!validation.valid) {
    // 校验失败也要可观测（新增）
    await this.emitTelemetry('onRunEnd', {
      traceId: newTraceId(),
      sessionKey: this.resolveSessionKey(request),
      request, durationMs: 0, activeMs: 0, queuedMs: 0, turnCount: 0,
      result: <校验失败 Result>, success: false,
      errorClass: 'validation', tokens: { input: 0, output: 0 },
    });
    return ...;
  }
  const finalRequest = normalizeRequest(request);
  const sessionKey = this.resolveSessionKey(finalRequest);
  const traceId = newTraceId();
  const queuedAt = Date.now();

  // 1. 入队前：onRunStart
  await this.emitTelemetry('onRunStart', { traceId, sessionKey, request: finalRequest, queuedAt });

  // 2. 串行化（acquire 内等待 = 排队）
  const session = this.getSession(sessionKey);
  const release = await this.acquire(session);
  const queuedMs = Date.now() - queuedAt;

  try {
    const startedAt = Date.now();
    const result = await this.runWithStorageLock(finalRequest, sessionKey, () =>
      this._run(finalRequest, sessionKey, session, traceId));
    await this.emitTelemetry('onRunEnd', {
      traceId, sessionKey, request: finalRequest,
      durationMs: Date.now() - startedAt + queuedMs,
      activeMs: Date.now() - startedAt, queuedMs, turnCount: <见 9.3>, result,
      success: result.success,
      errorClass: <见 9.6>, tokens: <汇总>,
    });
    return result;
  } finally { release(); }
}
```

`stream()` 完全对称：`onRunStart` 在 `acquire` 前、`onRunEnd` 在 `release` 前各补一次。

### 9.3 turnCount（step 长度）

`runLoop` / `runLoopStream` 的 while 每迭代一轮记一步：

```ts
// runtime/index.ts runLoop 内
let turnCount = 0;
while (maxTurns-- > 0) {
  turnCount += 1;
  // ...原有逻辑
}
return turnCount; // 或写回 compilation，供 onRunEnd 读取
```

> 步数与 `maxTurns` 上限解耦：`maxTurns` 归零但仍有工具调用时，循环自然结束，`turnCount` 如实反映实际轮数（可据此发现"撞上限"的失控 run）。

### 9.4 模型调用统一埋点（修复 stream() 路径缺口）

现状 `runLoop` 走 `streamModel()`（有 onModelCall），`runLoopStream` 直接调 `_streamFn`（无 onModelCall）。
**抽公共生成器，两条路径共用**：

```ts
// runtime/index.ts
private async *streamModelEvents(
  compilation: Compilation,
  signal: AbortSignal,
  stream: boolean,
): AsyncGenerator<StreamEvent> {
  const modelStartedAt = Date.now();
  const spanId = newSpanId();        // 每次模型调用一个 span
  let attempts = 1;                  // 含首次
  let ttftAt: number | undefined;    // 首 token 时刻（stream 用）

  const gen = this._streamFn(this._model, this.buildContext(compilation.messages), {
    signal,
    reasoning: this._thinkingLevel !== 'off' ? this._thinkingLevel : undefined,
    // 重试回调：provider 内 retry() 退避前调用（§9.7）
    onRetryAttempt: () => { attempts += 1; },
  });

  for await (const event of gen) {
    if (stream && event.type === 'text_delta' && ttftAt === undefined) ttftAt = Date.now();
    yield event;
  }
  // ...生成器收尾时按 event 结果 emit onModelCall（含 tokens/errorClass/attempts）
}
```

- `streamModel()` = `for await (event of streamModelEvents(...))` 聚合出 assistantMessage（原逻辑不变）；
- `runLoopStream` = `for await (event of streamModelEvents(..., true))` 逐块 yield；
- `onModelCall` 载荷：
  - `tokens = assistantMessage.usage`（input/output/cacheRead/cacheWrite）
  - `errorClass`：error 事件从 `errorMessage` 前缀解析（见 9.6）
  - `attempts`：本地累计值
  - `ttftMs`：`ttftAt - modelStartedAt`

### 9.5 工具 status 判定

```ts
// runtime/index.ts（新增辅助函数）
function toolCallStatus(result: ToolResult): ToolTelemetryInfo['status'] {
  if (isErrorResult(result)) return 'error'; // details.error 存在
  const d = result.details as
    | { blocked?: boolean; skipped?: boolean }
    | undefined;
  if (d?.blocked) return 'blocked'; // makeBlockedResult
  if (d?.skipped) return 'skipped'; // makeSkippedResult
  return 'ok';
}
// executeToolCall 的 emitTelemetry('onToolCall', ...) 处：
//   success: status === 'ok'，status: toolCallStatus(result)，errorClass: 同上
```

- `blocked` 与 `skipped` 也照常触发 `onToolCall`（维持现状），但接收方用 `status` 区分，**成功率只认 `ok`**。

### 9.6 errorClass 提取（统一映射）

```ts
// 模型调用异常
import { isAgentError, classifyError, AgentErrorCategory } from '../ai';

function modelErrorClass(err: unknown, message?: string): ErrorClass {
  if (isAgentError(err)) return err.category;
  if (typeof message === 'string') {
    // 流式 error 事件：errorMessage 带 "[category]" 前缀（formatCategoryError 产出）
    const m = message.match(/^\[([^\]]+)\]/);
    if (m) return m[1] as ErrorClass;
  }
  return classifyError(err) ?? 'unknown';
}

// run 级：优先取最后一次模型调用的 errorClass
//   无模型调用 → result.error 分类；terminateReason → 'terminated'；工具错误 → 'tool_error'
```

### 9.7 retry() 回调（重试次数）

```ts
// ai/retry.ts
export interface RetryOptions {
  // ...
  /** 仅在真正退避重试时调用（重试耗尽场景由 onModelCall.attempts 兜底） */
  onRetryAttempt?: (info: {
    attempt: number;
    error: unknown;
    delayMs: number;
  }) => void;
}

// retry() 循环内：
if (attempt < maxRetries && isRetryableError(err)) {
  const delay = calculateDelay(attempt, baseDelayMs, maxDelayMs);
  options?.onRetryAttempt?.({
    attempt: attempt + 1,
    error: err,
    delayMs: delay,
  });
  await new Promise((r) => setTimeout(r, delay));
  continue;
}

// ai/types.ts SimpleStreamOptions 新增 onRetryAttempt?，runtime 在 streamModelEvents 注入；
// stream-openai.ts L430 / stream-anthropic.ts L185 的 retry() 调用处透传 options.onRetryAttempt。
```

> runtime 收到 `onRetryAttempt` 回调后：自增 attempts 计数，并 `emitTelemetry('onRetry', {...})`
> 其中 `errorClass` 由 `classifyError`/`isAgentError` 判定、`delayMs` 来自回调、`willRetry: true`。
> 统一由 runtime 转发，provider 层不感知 telemetry（保持分层干净）。

### 9.8 兼容性与测试

**向后兼容**：载荷接口只增字段（traceId/turnCount/attempts/status/…），现有测试全部是字段级断言
（[telemetry.test.ts](../../packages/agent/test/telemetry.test.ts)），不会破坏。

**新增用例**（`test/telemetry.test.ts`）：

| 用例           | 断言                                                                          |
| -------------- | ----------------------------------------------------------------------------- |
| run 成功       | onRunStart→onRunEnd 的 traceId 一致；turnCount=1；success=true                |
| 工具循环 2 轮  | turnCount=2；onToolCall 触发 1 次、status='ok'                                |
| 工具抛错       | onToolCall status='error'、success=false                                      |
| 权限拒绝       | onToolCall status='blocked'（或 onPermissionDenied 触发）                     |
| 模型调用带重试 | mock streamFn 第 1 次抛可重试错误 → attempts=2、onRetry 触发 1 次             |
| 流式请求       | onRunStart/onRunEnd/onModelCall 均触发；onModelCall.stream=true               |
| 校验失败请求   | onRunEnd success=false、errorClass='validation'                               |
| token 透传     | usage.input/output/cacheRead/cacheWrite 出现在 onModelCall 与 onRunEnd.tokens |

**验证命令**：`pnpm --filter @aipack-ai/agent test && pnpm --filter @aipack-ai/agent typecheck`

---

## 附录

### A. SQLite 表结构（档位 A 参考）

```sql
CREATE TABLE runs (
  trace_id     TEXT PRIMARY KEY,
  started_at   INTEGER,           -- epoch ms
  ended_at     INTEGER,
  session_key  TEXT,
  channel      TEXT,
  model        TEXT,              -- 首个模型
  status       TEXT,              -- success / error / validation
  error_class  TEXT,
  turns        INTEGER,
  duration_ms  INTEGER,
  active_ms    INTEGER,
  queued_ms    INTEGER,
  ttft_ms      INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read   INTEGER,
  cache_write  INTEGER
);
CREATE INDEX idx_runs_started ON runs(started_at);

CREATE TABLE spans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id     TEXT NOT NULL,
  span_id      TEXT,
  kind         TEXT,              -- run / model / tool
  name         TEXT,              -- model:<id> / tool:<name>
  started_at   INTEGER,
  duration_ms  INTEGER,
  status       TEXT,              -- ok / error
  error_class  TEXT,
  attempts     INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER
);
CREATE INDEX idx_spans_trace ON spans(trace_id);

CREATE TABLE tool_calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id     TEXT NOT NULL,
  span_id      TEXT,
  tool_name    TEXT,
  status       TEXT,              -- ok / error / blocked / skipped
  duration_ms  INTEGER,
  error_class  TEXT
);
CREATE INDEX idx_tool_calls_trace ON tool_calls(trace_id);
```

### B. 事件时序图

```
run(request)
 ├─ onRunStart  { traceId, queuedAt }                 ← 入队
 │    会话串行队列等待
 ├─ onModelCall { span, attempts, tokens }            ← 第 1 轮（可多次）
 ├─ onRetry     { attempt, status, delayMs }          ← 429/5xx 时
 ├─ onToolCall  { span, status: ok|error|blocked }    ← 每工具
 ├─ onModelCall { span }                              ← 第 2 轮 …
 └─ onRunEnd    { traceId, turns, success, tokens }  ← 结束
```
