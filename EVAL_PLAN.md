# @aipack-ai/eval 设计方案（Agent 评测体系）

> 状态：待评审
> 范围：`packages/eval`（新增包，可选附带 `packages/cli` 命令接线）
> 参考：`packages/agent` 的 Extension / RuntimeHooks / Result / StreamFn 契约、`packages/multi-agent` 的 GraphTrace、业界 Eval 实践（trajectory eval / LLM-as-judge / baseline 回归门禁）

---

## 1. 目标与原则

- **零侵入**：不改动 `packages/agent` 一行代码，全部通过 `Extension` + `streamFn` 替换 + 工具包装实现（对齐 MCP / Skills 两个方案的接入范式）
- **零外部依赖**：纯 TypeScript + `node:test` 断言，不引入 promptfoo / braintrust / langsmith 等评测框架（对齐仓库"零运行时依赖"约定）
- **可重复优先**：Agent 评测最大的敌人是**不确定性与费用**。本方案以 **record / replay** 为支点——CI 中绝大多数 case 不调用真实模型，却仍跑真实代码路径
- **轨迹重于答案**：Agent 的价值在过程。判分器接收完整 `RunTrace`（模型调用 + 工具调用 + 最终结果），而不仅是 `Result.content`，"答案对但绕了 8 次工具调用"必须被判罚
- **门禁卡回归不卡绝对值**：LLM 输出天然波动，CI 只拦截"相对基线变差"，且不把 flaky case 放进门禁
- **评测集可自增长**：从 `observability-server` 落盘的线上 trace 反哺生成 case（第 9 节）

## 2. 现状分析

| 现状 | 说明 | 缺口 |
|---|---|---|
| `packages/agent/core/extension.ts` | `RuntimeHooks` 提供 `beforeRun / beforeTransform / afterTransform / beforeModelCall / beforeEmit / afterEmit / done / failed / beforeToolCall / afterToolCall` | **轨迹采集所需的钩子已完备**，缺一个把它们汇总成 `RunTrace` 的消费者 |
| `packages/agent/core/tool-hooks.ts` | `ToolCallContext`（toolCall / tool / args / signal）、`AfterToolCallContext`（result / isError）、`isErrorToolResult()` | 工具级判分数据源现成 |
| `packages/agent/core/types.ts` | `StreamFn = (model, context, options) => AsyncIterable<StreamEvent>`，是模型唯一入口 | **模型可整体替换**，mock / replay / live 三态的基础 |
| `packages/agent/test/*.ts` | 已有 `mockStreamFn` / `mockToolStreamFn` 手写 `StreamEvent` 序列的测试风格 | 仅服务于单测，未抽象为可复用的录制回放设施 |
| `packages/multi-agent/core/types.ts` | 已定义 `TraceStep` / `GraphTrace`（每节点 input/output/duration/state）、`MultiAgentEvent`（含 `edge_traversed` / `converged` / `round_start`） | 多 Agent 评测的 trace 源已存在，仅缺判分层 |
| `packages/observability-server` | SQLite 落盘线上 trace、REST 查询、Dashboard | 线上数据未回流为评测集 |
| 全仓 | 无 eval / benchmark 目录，无基线对比机制 | Prompt / 模型 / 工具的改动无回归护栏 |

**结论**：底座（钩子、trace、可替换模型层）几乎齐全，缺的是一个薄薄的**判分 + 编排 + 报告层**。这正是 `packages/eval` 的定位。

## 3. 评测分层

| 层 | 评测对象 | 判定依据 | 成本 | 执行时机 |
|---|---|---|---|---|
| **L0 契约单测** | 纯函数 / Transformer / 工具 | 断言 | 0 | 每次 commit（现状已有） |
| **L1 轨迹评测 Trajectory** | 工具调用序列、参数、调用次数、模型调用轮次 | 确定性比对 | 低（mock/replay） | 每次 PR |
| **L2 结果评测 Outcome** | 最终 `Result.content` / 结构化输出 | 匹配 / schema / LLM 判分 | 中 | PR（replay）+ nightly（live） |
| **L3 多 Agent 评测** | 图路径、收敛轮次、各节点产出、总 token | 节点级 + 图级 grader | 中高 | nightly |
| **L4 线上回归** | 真实流量回放 | 人工抽检 + 指标 | 高 | 周级 |

L1/L2/L3 共用同一套 case 与 grader 定义，只是**模型源与工具源不同**。

## 4. 总体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                        @aipack-ai/eval                            │
│                                                                  │
│  ┌─ 数据集 ────────────┐   ┌─ 执行器 ───────────┐  ┌─ 报告 ────┐ │
│  │ EvalCase            │   │ Runner             │  │ Report    │ │
│  │  input / expect     │──▶│  并发/超时/重试    │─▶│  passRate │ │
│  │  graders[] / tags   │   │  repeats / seed    │  │  variance │ │
│  │  setup() → Runtime  │   │  costCap           │  │  baseline │ │
│  └─────────────────────┘   └─────────┬──────────┘  │  diff     │ │
│                                      │             └───────────┘ │
│  ┌─ 采集 ────────────────────────────┼─────────────────────────┐ │
│  │ TraceExtension(Extension) ──▶ RunTrace                      │ │
│  │   beforeModelCall → Context 快照                            │ │
│  │   afterToolCall   → args / result / isError                 │ │
│  │   done / failed   → Result                                  │ │
│  └─────────────────────────────────────────────────────────────┘ │
│  ┌─ 模型源三态 ─────────┐  ┌─ 工具源 ──────────┐  ┌─ 判分 ─────┐ │
│  │ mock / replay / live │  │ spy / mock / sand │  │ Grader[]  │ │
│  │ (替换 streamFn)      │  │ (包装 Tool.execute)│ │ 确定性+judge│ │
│  └─────────────────────┘  └───────────────────┘  └────────────┘ │
└──────────────────────────────────────────────────────────────────┘
          │                          │                    │
          ▼                          ▼                    ▼
   AgentRuntime（零改动）      Tool（零改动）      MultiAgentResult
                                                   / GraphTrace
```

## 5. 核心类型设计

### 5.1 轨迹（`src/trace.ts`）

```ts
/** 一次运行的完整轨迹：判分的唯一数据源 */
export interface RunTrace {
  caseId: string;
  /** 每次模型调用的入参与耗时 */
  modelCalls: Array<{ seq: number; context: Context; latencyMs: number; usage?: Usage }>;
  /** 每次工具调用的名称/参数/结果/是否错误/耗时 */
  toolCalls: Array<{
    seq: number; name: string; args: unknown;
    result: ToolResult; isError: boolean; latencyMs: number;
  }>;
  /** 最终结果（content / toolsUsed / usage / success / stopReason / resources） */
  result: Result;
  startedAt: number;
  durationMs: number;
}

/** 零侵入采集：作为普通 Extension 挂进 Runtime */
export function createTraceExtension(sink: RunTrace): Extension;
export function createTrace(): { extension: Extension; trace: RunTrace };
```

采集点映射（全部为现有钩子）：

| Trace 字段 | 钩子 | 上下文 |
|---|---|---|
| `modelCalls[].context` | `beforeModelCall`（waterfall，可拿到最终 `Context`：systemPrompt/messages/tools） | 每次模型调用触发一次 |
| `toolCalls[]` | `afterToolCall` | `ToolCallContext.tool.name` / `.args` + `AfterToolCallContext.result` / `.isError` |
| `result` | `done` / `failed` | `Result` / `Error` |
| `durationMs` | Runner 侧计时 | — |

多 Agent 场景直接复用 `packages/multi-agent` 已有的 `GraphTrace`（`steps: TraceStep[]` 含每节点 `input/output/duration/state`），再叠加 `MultiAgentEvent` 收集 `edge_traversed` / `round_start` / `converged` 形成 `GraphRunTrace`，与单 Agent 的 `RunTrace` 共享 grader 协议。

### 5.2 判分器（`src/graders/*`）

```ts
export interface GradeContext {
  trace: RunTrace;
  case: EvalCase;
  expect: unknown;
  /** 多 Agent 场景额外提供 */
  graphTrace?: GraphTrace;
}

export interface Grader {
  name: string;
  /** 权重，默认 1；case 分数 = Σ(score×weight)/Σweight */
  weight?: number;
  grade(ctx: GradeContext): GradeResult | Promise<GradeResult>;
}

export interface GradeResult {
  /** 0..1 */
  score: number;
  pass: boolean;
  /** 失败原因，进报告 */
  reason?: string;
}
```

内置 grader（**纯函数，零 Node API**）：

| 类别 | grader | 说明 |
|---|---|---|
| 确定性 | `exactMatch` / `contains` / `regex` / `jsonSchema` / `equalsSnapshot` | 结果文本与结构化输出比对 |
| 轨迹 | `toolCalled(name)` / `toolCallCount(n)` / `toolSequence([...])` / `toolArgs(schema)` | 工具使用正确性 |
| 效率 | `noRedundantCalls` / `maxModelCalls(n)` / `maxToolCalls(n)` | **惩罚绕路**，L1 的核心价值 |
| 预算 | `tokenBudget` / `latencyBudget` / `costBudget` | 成本护栏 |
| 判分 | `llmRubric(rubric, { model })` | 唯一非确定性 grader，见 6.3 |
| 自定义 | `fn((ctx) => GradeResult)` | 逃生舱 |

### 5.3 用例与套件（`src/types.ts` / `src/runner.ts`）

```ts
export interface EvalCase {
  id: string;
  input: string | Request;
  /** 期望值，供 grader 消费 */
  expect?: unknown;
  graders: Grader[];
  /** 'smoke' | 'tools' | 'regression' | 'slow'，用于分层执行 */
  tags?: string[];
  /** 通过线，默认 1.0（所有 grader 全 pass） */
  threshold?: number;
  /** 非确定性 case 重复运行次数，用于统计 pass@k / 方差 */
  repeats?: number;
  timeoutMs?: number;
  /** 被评测对象：工厂返回 Runtime 或 RuntimeOptions */
  setup: () => Runtime | RuntimeOptions;
}

export interface SuiteOptions {
  /** 模型源 */
  model: 'mock' | 'replay' | 'live';
  fixtureDir?: string;          // replay/live 录制件目录
  concurrency?: number;         // 默认 4
  seed?: number;
  /** 成本硬上限，超出即中止（live 模式必填） */
  costCapUsd?: number;
  baseline?: string;            // 基线报告路径，用于回归 diff
  filter?: { tags?: string[]; ids?: string[] };
}

export function createEvalSuite(options: SuiteOptions): {
  run(cases: EvalCase[]): Promise<EvalReport>;
};
```

## 6. 关键设计点

### 6.1 模型源三态（CI 能否落地的关键）

`StreamFn` 是模型唯一入口，因此可整体替换：

| 模式 | 实现 | 用途 |
|---|---|---|
| **mock** | 手写 `StreamEvent[]` 序列（复用 `packages/agent/test` 现有风格） | L1 轨迹评测、工具编排逻辑，零费用零网络 |
| **replay** | `createReplayStreamFn(fixture.jsonl)`：按「messages 指纹 + 工具结果指纹」查录制响应，未命中即报错（**不静默回退**，避免假绿） | CI 主力：确定性、零费用、跑真实代码路径 |
| **live** | `createStreamFnFromAi(aiModel)` + `record: true` 落盘 JSONL | 生成/更新 fixture；nightly 真实能力回归 |

**归一化器（必须）**：快照/对比前剔除 `timestamp`、随机 `toolCall.id`、`latencyMs`、模型返回的 `responseId`，否则 diff 全是噪声。

**录制件评审**：模型或 Prompt 变更时整体重录，录制件的 diff 本身就是一次能力审查（哪些回答变了、哪些工具调用多了）。

### 6.2 工具与副作用隔离

- **spy**：`spyTool(tool, sink)` 装饰 `execute`，不改工具实现即可记录调用与耗时。
- **mock**：评测用 `tools: [...mockTools]` 覆盖真实 `read/write/bash`，断言"是否调用了正确工具与参数"。
- **sandbox**：确有副作用时用临时目录 + `PermissionPolicy` deny 危险权限，跑完销毁。MCP 包装工具默认 `permissions: ['mcp:<server>']`，eval 中需显式放行目标 server，否则 deny-by-default 下全部被拒（fail-closed，方向安全）。

### 6.3 LLM-as-judge 及其校准

`llmRubric` 用一个**独立 Runtime**（temperature 0 + 固定 rubric + 结构化 JSON 输出 `{ score, reason }`）判分：

- **judge 模型应与被测模型不同族**，避免自证偏差
- judge 自身需被校准：抽 ≥30 条人工标注样本计算 agreement，**≥0.8 才允许进入 CI 门禁**
- judge 判分必须输出 `reason`，失败时可人工复核，避免黑箱

### 6.4 统计可靠性（最易被忽略）

非确定性输出的单次通过率无意义。Runner 对 `repeats > 1` 的 case 输出：

```ts
{ id, scores: number[], mean, min, max, passAt1, passAtK, variance }
```

- 方差大的 case 标记 `flaky`，**默认排除出 CI 门禁**（但仍进报告供观察）
- 报告同时给出 `passRate` 与 `variance`，避免"调 Prompt 调绿了其实是抖动"

## 7. 报告与 CI 门禁

```ts
export interface EvalReport {
  summary: {
    total: number; passed: number; passRate: number;
    tokens: number; costUsd: number; durationMs: number;
  };
  cases: Array<{
    id: string; score: number; pass: boolean;
    grades: GradeResult[];
    repeats?: { mean: number; passAt1: number; variance: number };
    traceRef: string;               // 轨迹落盘路径，失败时可调阅
  }>;
  flaky: string[];
  /** 与 baseline 对比后的回归项 */
  regressions?: Array<{ id: string; from: number; to: number; delta: number }>;
}
```

- `baseline.json` 随版本归档：`aipack-eval run --baseline ./evals/baseline.json --fail-on-regression`
- 分层执行：`--tag smoke`（PR 必跑，全 mock/replay，<30s）→ `--tag full`（nightly，含 live，带 `costCapUsd` 硬上限）
- 轨迹落盘而非只留分数：失败 case 能回溯完整 `modelCalls` / `toolCalls`，这是调试 Prompt 的关键

## 8. 目录结构

对齐 skills / mcp 包的分层约定（契约层纯函数零 Node API，录制/CLI 层 Node only）：

```
packages/eval/
├── index.ts                  # 分层导出：case / grader / trace / replay / runner / report
├── package.json              # @aipack-ai/eval，peer: @aipack-ai/agent
├── tsup.config.ts            # 与 skills 一致（esm / dts / skipNodeModulesBundle）
├── src/
│   ├── types.ts              # EvalCase / Grader / GradeResult / RunTrace / EvalReport
│   ├── trace.ts              # createTraceExtension（零侵入采集）
│   ├── normalize.ts          # 快照归一化（timestamp / id / latency redact）
│   ├── replay.ts             # record / replay streamFn + JSONL fixture（Node only）
│   ├── spy.ts                # spyTool / mockTools / sandbox 工具包装
│   ├── graders/
│   │   ├── deterministic.ts  # exactMatch / contains / regex / jsonSchema
│   │   ├── trajectory.ts     # toolCalled / toolSequence / toolArgs / maxModelCalls
│   │   ├── budget.ts         # token / latency / cost
│   │   ├── rubric.ts         # llmRubric（judge）
│   │   └── index.ts
│   ├── runner.ts             # runCase / runSuite：并发 / 超时 / 重试 / repeats / costCap
│   ├── report.ts             # 汇总 + baseline diff + 落盘
│   └── cli.ts                # aipack-eval run | record | compare（Node only）
└── tests/
    ├── trace.test.ts         # Extension 采集完整性
    ├── replay.test.ts        # 录制/回放一致性 + 未命中报错
    ├── graders.test.ts       # 各 grader 纯函数单测
    ├── runner.test.ts        # 并发 / 超时 / repeats 统计
    └── report.test.ts        # baseline diff 与回归识别
```

**依赖关系**：`@aipack-ai/eval` → `@aipack-ai/agent`（peer）；多 Agent 评测可选依赖 `@aipack-ai/multi-agent`。零新外部依赖。

## 9. 闭环飞轮（差异化价值）

`observability-server` 已把线上 trace 落 SQLite。加一个导出器即可形成飞轮：

```
线上真实对话 ──(筛选失败/低分/高成本)──▶ 自动生成为 EvalCase
      ▲                                          │
      │                                          ▼
  改进 Prompt / 工具 / Skill  ◀── 评测暴露的高频失败模式
```

- 输入 = 用户请求，`expect` = 人工修正后的期望，`graders` = 当时的工具轨迹 + 预算约束
- 评测集随真实使用**自动增长**，而非靠拍脑袋写 case
- 与 L1/L2/L3 共用同一套执行器，无新增概念

## 10. 测试策略（eval 框架自身的测试）

- **纯函数单测**（零 Node API）：grader 判定逻辑、归一化器、报告汇总与 baseline diff
- **集成测试**：`mockStreamFn` 驱动完整 Runtime + TraceExtension，验证轨迹采集字段完整（modelCalls / toolCalls / result）
- **回放一致性**：同一 fixture 连续两次运行，`RunTrace` 归一化后逐字段相等
- **兼容性回归**：未挂 TraceExtension 时 Runtime 行为与现状完全一致（空 extensions 快照测试）
- **flaky 识别自测**：构造方差已知的 case，验证 Runner 的 flaky 标记正确

## 11. 实施计划

| 里程碑 | 内容 | 交付判据 |
|---|---|---|
| **M1 判分内核** | `types` + `trace`（TraceExtension）+ 确定性/轨迹/预算 grader + `runner` + `report` | 用 `mockStreamFn` 跑通 10 个内置 case；`pnpm --filter @aipack-ai/eval test` 全绿；打印出可读报告 |
| **M2 CI 可用** | `replay` 录制回放 + 归一化器 + `spy`/sandbox + CLI（`run`/`record`/`compare`）+ baseline diff | 真实模型录制一次后 CI 全程零 API 调用；`--fail-on-regression` 在人为劣化 Prompt 时正确拦截 |
| **M3 判分与多 Agent** | `llmRubric` + judge 校准脚本 + 多 Agent 图评测（吃 `GraphTrace` / `MultiAgentEvent`） | Debate 收敛轮次、Supervisor 任务分配可判分；judge agreement ≥0.8 |
| **M4 飞轮**（可选） | observability-server trace → case 导出器 | 从线上失败会话一键生成可运行的 EvalCase |

## 12. 备选方案与风险

| 决策点 | 选择 | 备选 | 理由 |
|---|---|---|---|
| 自研 vs 引入 promptfoo / braintrust | **自研薄层** | 引入外部评测框架 | 全仓零运行时依赖约定；评测核心（case+grader+runner+report）约千行；外部框架多为 Python / 重 YAML 配置，与 TS 类型优先的仓库风格冲突 |
| CI 是否跑真实模型 | **否（replay 为主，live 仅 nightly）** | 每次 PR 跑 live | 费用与抖动双重不可控；replay 已覆盖真实代码路径，能力变化通过重录录制件评审 |
| 判分粒度 | **轨迹 + 结果双判** | 仅判最终结果 | Agent 的核心风险是过程低效/错工具调用，只看结果会漏掉成本爆炸类回归 |
| replay 未命中时的行为 | **报错失败** | 静默回退 live 调用 | 静默回退会让 CI 产生"偶发联网"的假绿，且掩盖 fixture 过期 |
| judge 是否进门禁 | **校准后（agreement ≥0.8）才进** | 直接进 | 未校准的 judge 自身就是噪声源，会制造 flaky 门禁 |
| flaky case 处置 | **标记并排除出门禁** | 提高 repeats 硬压方差 | 压方差成本指数上升；先排除、再针对性治理（改 Prompt 或降 temperature） |
| 门禁判据 | **相对基线回归** | 绝对通过率阈值 | 绝对阈值会因模型/Prompt 升级而误报；回归 diff 才是"这次改动弄坏了什么" |
| 评测集过拟合 | train/dev/test 三分 + 定期人工抽检 | 单一测试集反复调 | 长期对着同一集调 Prompt 会过拟合，需留出未被优化的 dev/test |

## 13. 接线清单（实施时勾选）

- [ ] `packages/eval/package.json`：`@aipack-ai/eval`，peerDependencies `@aipack-ai/agent: workspace:*`，prebuild 先构建 agent（照抄 skills）
- [ ] `packages/eval/tsup.config.ts`：esm / dts / sourcemap / skipNodeModulesBundle
- [ ] 根 `tsconfig.json` paths 增加 `"@aipack-ai/eval": ["./packages/eval/index.ts"]`
- [ ] 根 `package.json` 增加 `eval` / `eval:record` 脚本
- [ ] 根 `README.md` 核心包表补充 `@aipack-ai/eval`
- [ ] `evals/` 目录：内置 case 集 + `baseline.json` 归档位置
- [ ] CI：PR 跑 `--tag smoke`（replay），nightly 跑 `--tag full`（live + costCap）
- [ ] changeset 初始化版本
- [ ] （M2）文档明示：replay 未命中即失败，需 `aipack-eval record` 重录
- [ ] （M4）observability-server trace 导出器接口对接
