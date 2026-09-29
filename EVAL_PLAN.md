# aipack Eval 体系方案

> 状态：待评审（M1 / M3 已落地，M2 取消）
> 范围：新增 `packages/eval`（接线 `packages/agent` / `packages/observability` / `packages/cli`）
> 参考：τ-bench / BFCL / OpenAI Evals / promptfoo 的分层思路，结合 aipack 三段式架构落地

---

## 1. 目标与原则

- **评什么先定清楚**：四层金字塔（单元 → 组件 → 端到端 → Provider 对比），越往上越贵越慢，用例数量递减
- **轨迹优先于文本**：agent 框架的 bug 大多体现为"调错工具 / 漏调工具 / 循环调用"，工具调用轨迹用规则就能断言，不依赖 LLM-as-judge
- **规则评分覆盖 70%**：先用确定性断言（工具调用、结构化输出、关键词）覆盖大多数场景，LLM-as-judge 只留给开放性回答
- **数据自增长**：线上 trace → EvalCase 回流管道，eval 集随真实问题自动长大，而不是靠人肉堆
- **CI 分级**：PR 触发 mock 模式（<1 分钟），每日 cron 触发真实 LLM 回归，发版前跑全量

## 2. 四层金字塔

| 层级 | 对象 | 确定性 | 频率 | 成本 |
|---|---|---|---|---|
| L1 单元测试 | 单函数 / 钩子（mock LLM） | 完全确定 | 每次 commit | 零 |
| L2 组件 eval | memory 检索、compression 保真、tool 参数 | 大部分确定 | 每次 commit / 每日 | 低 |
| L3 端到端场景 eval | agent 完整任务（真实 LLM） | 有随机性 | 每日 / 发版前 | 高 |
| L4 模型 / Provider 对比 | 13+ provider 效果与成本 | 统计意义 | 选型 / 调 prompt 时 | 高 |

大部分问题应在 L1/L2 拦截；L3/L4 只做抽样和回归。

## 3. 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│                     数据来源（第 6 节）                        │
│  trace 回流 · schema 合成 · 开源数据集 · 手工 golden · 单测迁移 │
└──────────────────────────────────────────────────────────────┘
                              │
┌──────────────────────────────────────────────────────────────┐
│                      packages/eval                           │
│                                                              │
│  EvalCase ──► Runner ──► Scorer ──► Report                   │
│  (格式)      (执行)     (评分)     (归档/基线/CI 门禁)          │
│       ▲          │                                          │
│       │          ▼                                          │
│  fixtures/    runtime.run() / stream()                      │
│  (LLM mock   + LLM 注入点（fixture replay / 真实 provider）   │
│   录制响应)                                                 │
└──────────────────────────────────────────────────────────────┘
```

四个核心模块：**EvalCase（格式）→ Runner（执行）→ Scorer（评分）→ Report（报告）**。

## 4. 核心模块设计

### 4.1 EvalCase（用例格式）

```ts
export interface EvalCase {
  /** 全局唯一，如 'memory-recall/multi-hop-003' */
  id: string;
  /** 套件名：'agent-e2e' | 'memory-recall' | 'compression' | 'tool-calling' | ... */
  suite: string;
  /** 用户消息 + 初始上下文（可含预注入记忆、预置文件系统 fixture） */
  input: AgentInput;
  /** 可选期望；没有期望时由 scorer 自行判定（如 rubric） */
  expected?: ExpectedResult;
  /** 该 case 用哪些评分器 */
  scorers: ScorerConfig[];
  /** 数据来源标识，报告按 origin 分组诊断分布漂移 */
  origin: 'handwritten' | 'trace' | 'synthetic' | 'dataset' | 'bugfix';
  metadata?: {
    tags?: string[];
    /** 允许的最大 token 花费 / 步数 / 耗时，防死循环烧钱 */
    maxCost?: number;
    maxSteps?: number;
    timeoutMs?: number;
  };
}

export type ExpectedResult =
  | { type: 'exact' | 'contains' | 'regex'; value: string }
  | { type: 'tool-call'; calls: ExpectedToolCall[] }
  | { type: 'rubric'; criteria: string[] };

export interface ExpectedToolCall {
  tool: string;
  /** 只断言关键字段（如 path、query），未列字段忽略 */
  args?: Record<string, unknown>;
}
```

### 4.2 Scorer（三类评分器）

| 类型 | 判定方式 | 成本 | 适用 |
|---|---|---|---|
| 规则评分器 | 字符串包含 / 正则 / JSON Schema 校验 / 工具调用名与参数匹配 | 零 | 工具轨迹、结构化输出、终态断言 |
| 语义评分器 | embedding 相似度 > 阈值 | 低 | 开放性回答的粗筛 |
| LLM-as-judge | rubric 结构化打分 | 高 | 开放性回答的终审 |

```ts
export interface ScorerConfig {
  type: 'rule' | 'semantic' | 'llm-judge';
  /** rule: 断言内容；semantic: 期望文本 + 阈值；llm-judge: rubric 条目 */
  params: Record<string, unknown>;
  weight?: number; // 多评分器加权合成总分，默认 1
}

export interface ScoreResult {
  scorer: string;
  score: number;        // 0~1
  passed: boolean;
  reason: string;       // judge 必须给出理由与证据引用
  evidence?: string;    // 命中的文本片段 / 工具调用序号
}
```

LLM-as-judge 硬性约束：

- **judge 模型与被测模型异源**（避免同源偏置）
- 输出强制 JSON（分数 + 理由 + 引用证据），解析失败视为 scorer 自身错误而非用例失败
- judge 的 prompt 版本纳入缓存 key，改 rubric 不 invalidate 全部历史结果

### 4.3 Runner（执行器）

```ts
export interface EvalRunner {
  run(cases: EvalCase[], config: RunConfig): Promise<EvalReport>;
}

export interface RunConfig {
  mode: 'mock' | 'live';          // mock = fixture replay，live = 真实 provider
  model?: string;                 // 被测模型（L4 对比时遍历多个）
  judgeModel?: string;            // LLM-as-judge 用的异源模型
  repeats?: number;               // 消随机性：每 case 跑 N 次
  concurrency?: number;           // 按 provider 分队列并发，复用现有重试逻辑
  cacheDir?: string;              // (caseId + prompt 版本 + 模型) 为 key 的响应缓存
  budget?: { maxTotalCost?: number; wallClockMs?: number };
  baselinePath?: string;          // 与上次结果对比，超阈值失败
  historyPath?: string;           // 历史趋势 JSONL（日环比可视化，M3）
  // live 模式：model / apiKey / baseUrl / temperature / streamFn / frameworkModel
}
```

实测取舍：适配层**不支持 seed**，因此 `repeats` 是唯一消噪手段 —— live 默认跑 3 次并按 pass@k 判定（详见 8.1）。

必须解决的工程问题：

1. **消除随机性**：`temperature: 0` + 固定 `seed`（支持的 provider 尽量传）；即便如此仍有噪声，每 case 跑 N 次取 `pass@k` 或平均分，不做单次 pass/fail
2. **LLM mock 注入点**：`Runtime` 需要支持 modelProvider 可替换（fixture replay 模式），这是 L1/L2 免费跑通的前提
3. **缓存**：`(caseId + prompt 版本 + 模型)` 为 key 缓存 LLM 响应，本地重复跑不烧钱
4. **超时与预算熔断**：`maxSteps` / `maxCost` / `wallClockTimeout`，触发即标记 failed 并截断
5. **并发与限流**：按 provider 分队列，复用 `packages/agent/ai` 适配层的重试逻辑

### 4.4 Report（报告与回归门禁）

指标最少包含：**通过率、平均分、总 token 成本、平均延迟、平均工具调用步数**。

- 输出 JSON + Markdown 双格式，存入 `eval-results/` 按时间归档（进 `.gitignore`，基线文件除外）
- `--baseline` 对比上次结果，通过率下降超过阈值（默认 2%）则 CI 失败；类似 snapshot 的 `--update-baseline` 机制
- 报告按 `origin` 与 `suite` 分组展示——**合成用例全过但 trace 用例大量挂 = eval 集未对齐真实分布**，这是最有诊断价值的信号

```ts
export interface EvalReport {
  runId: string;
  config: RunConfig;
  startedAt: string;
  durationMs: number;
  totals: { cases: number; passed: number; passRate: number; avgScore: number; costUsd: number };
  bySuite: Record<string, SuiteSummary>;
  byOrigin: Record<string, SuiteSummary>;   // 分布漂移诊断
  results: CaseResult[];                    // 每 case 每 repeat 的明细
}
```

## 5. aipack 特有能力

### 5.1 trace 回流管道（observability → eval）

现有 `packages/observability` 全链路 trace 是最大的数据资产：

```
线上/测试运行 trace
  ├── ✅ 好的会话 → 人工抽检 → 固化为 EvalCase（期望轨迹 = 实际轨迹）
  ├── ❌ 坏的会话 → 人工写修正后的期望 → 固化为回归用例
  └── 😐 不确定的 → LLM 辅助预筛 + 人工终审
```

- 在 `observability-server` 加 `POST /export-eval`：从 trace 提取 `(初始上下文, 用户消息, 工具调用序列, 最终输出)` 存为 JSON
- **脱敏**：trace 中的 API key、真实路径、隐私内容需 mask / 参数化（复用 `observability/src/redact` 既有能力，把真实路径替换为 fixture 路径）
- **纪律**：每个线上坏 case 修完 bug 后必须留下一个 `origin: 'bugfix'` 的 eval case

### 5.2 组件专属套件

| 包 | 套件 | 评分方式 |
|---|---|---|
| `memory` | 注入 N 条记忆 → 查询 → recall@k（BM25 / 向量两路分别评，验证混合检索增益） | 规则 |
| `compression` | 原文 → 压缩 → 关键事实保留率（L1–L5 每级分别评，LLM 抽取事实清单做 diff） | LLM-judge |
| `skills` | 技能触发 / 不触发的正反例（SKILL.md 描述生成） | 规则 |
| `mcp` | MCP 工具参数合规性 | 规则 + JSON Schema |
| `multi-agent` | Router 路由准确率（纯分类任务） | 规则 |
| `agent` | e2e 场景（核心工具组合、边界：maxSteps 用尽、上下文超限触发压缩、工具报错恢复、MCP 断连） | 混合 |

## 6. 数据从哪里来

按可持续性排序的五条渠道：

| 渠道 | 用途 | 成熟期占比 |
|---|---|---|
| trace 回流 | 坏 case 回归 + 好 case 固化 | ~50% |
| LLM 合成 | 冷启动起量（工具 schema / SKILL.md → 用例） | ~20% |
| 手工 golden | README / examples 承诺路径 + 作者踩坑 | ~20% |
| 开源数据集 | 借力社区打标工作 | ~10% |
| 单测迁移 | 现有"构造对话 → 断言输出"的 `*.test.ts` 迁为 mock 模式 EvalCase | 零成本过渡 |

### 6.1 LLM 合成（冷启动）

- **工具 schema → 用例**：每个 `Tool` 的 `parameters` JSON Schema 是天然题目生成器。LLM 读 schema 生成自然语言请求 + 期望工具调用（含参数边界值、必填缺失、歧义请求的反例）
- **SKILL.md → 用例**：技能描述生成"该触发 / 不该触发"正反例
- 防两个坑：**同源污染**（合成与被测异源）、**分布漂移**（只做种子，不当主数据源）

### 6.2 开源数据集适配

| 数据集 | 对应组件 |
|---|---|
| HotpotQA / MuSiQue（多跳检索） | memory 混合检索 recall@k |
| LongBench / ∞Bench（长文） | compression 各级保真率 |
| τ-bench / ToolBench / BFCL | agent 内核工具选择与参数 |
| GAIA / AgentBench | e2e 套件 |
| MMLU / GSM8K | L4 provider 对比通用底分 |

适配成本 = 每个数据集写一个转换器（`(question, answer)` → `EvalCase`），写一次长期受益。

### 6.3 手工种子集（第一周就该建，30~50 个）

1. **README / `examples/` 已有示例场景**——README 承诺的每个能力 = 至少一个 eval case，否则文档与代码悄悄脱节
2. 每个 bug fix 配一个（`origin: 'bugfix'`）
3. 设计边界场景：maxSteps 用尽、上下文超限触发压缩、工具报错恢复、MCP 断连

### 6.4 冷启动顺序

```
第 1 周      手工 golden + examples 覆盖（30~50 case，全 mock 可跑）
第 2~4 周    工具 schema 合成 + 数据集适配（memory / compression / tool-calling 套件）
持续         trace 回流管道 + bugfix 纪律
```

## 7. 目录结构

```
packages/eval/
  src/
    core/
      case.ts            # EvalCase / ExpectedResult 类型与校验
      scorer/
        rule.ts          # 规则评分器（字符串 / regex / JSON Schema / 工具轨迹）
        semantic.ts      # embedding 相似度
        llm-judge.ts     # 异源 judge + 强制 JSON 输出
      runner.ts          # 并发 / 缓存 / 预算熔断 / repeats（mock + live 两模式）
      report.ts          # JSON + Markdown 双格式 / baseline 对比
      live.ts            # live 模式：provider/model → model + streamFn 装配
      history.ts         # 历史趋势 JSONL + 日环比渲染（M3）
      cache.ts           # (caseId + prompt 版本 + 模型) 响应缓存
    datasets/            # 开源数据集下载器与转换器
    synth/               # 工具 schema / SKILL.md 合成器
    cli.ts               # aipack eval run --suite --mode --baseline
  eval/
    cases/               # 按套件组织的用例 JSON
      agent-e2e/         # mock（fixture replay）
      agent-e2e-live/    # live（真实 LLM，mode: 'live'）
      tool-calling/
      text-output/
    fixtures/            # 录制的 LLM 响应 / mock 文件系统
  package.json
```

`eval-results/`（运行产物，gitignore）与 `eval-baseline.json`（门禁基线，入库）放仓库根目录。

## 8. 落地里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 ✅ | `packages/eval` 骨架：类型 + Runner（复用 `runtime.run()`）+ 规则评分器；Runtime 加 LLM mock 注入点 | 手工 golden 34 case 全 mock 跑通（35/35 测试 272ms；CLI 34/34 0.01s） |
| M2 ❌ | ~~memory / compression 组件套件 + 数据集适配（HotpotQA / LongBench）+ 响应缓存~~ **已取消，不做** | — |
| M3 ✅ | agent e2e-live 套件（真实 LLM）+ `--baseline` 回归门禁 + 每日 cron 报告 + 历史趋势 | 通过率日环比可视化（sparkline + 环比 Δ）；42 case 加载、8 条 live 用例、34 条 mock 全通过；65 单测通过 |
| M4 | observability-server `POST /export-eval` trace 回流 + 脱敏 | 首批 trace/bfix case 入库 |
| M5 | LLM-as-judge + 语义评分器 + L4 provider 对比报告 | 开放性回答套件上线 |

### 8.1 M3 落地说明

**live 模式装配**（`packages/eval/src/core/live.ts`）

```
'--model deepseek/deepseek-chat'  ──►  getBuiltinModel（内置目录）
                                        │ 未命中则按 provider 推断 api 兜底（代理 / 兼容网关）
                                        ▼
                          adaptAiModel → RuntimeOptions.model
                          createStreamFnFromAi → RuntimeOptions.streamFn（temperature 默认 0）
```

- env 覆盖：`AIPACK_EVAL_MODEL` / `AIPACK_EVAL_PROVIDER` / `AIPACK_EVAL_API_KEY` / `AIPACK_EVAL_BASE_URL` / `AIPACK_EVAL_TEMPERATURE`，`<PROVIDER>_API_KEY` 兜底
- 适配层不支持 seed → **repeats 默认 3 + pass@k 判定**（k 次里至少过一次即通过，score 取均值）；mock 模式仍是每次都必须过
- 工具仍是 `createMockTools`（内存文件系统）：真实 LLM 只替换 LLM 侧，环境保持确定，不碰真实文件系统
- `EvalCase.mode`（`mock` / `live`）决定用例归属：mock 模式跳过 live-only，live 模式跳过 fixture replay，计入 `totals.skipped` 且不影响通过率

**套件**：`agent-e2e-live` 8 条（工具选择、参数保真、多步链式、错误恢复、不该调工具的克制、结构化输出），断言以 `tool-call` / `contains` / `json-field` / `success` 为主，避免对真实模型的措辞过拟合。

**baseline 门禁**

```bash
aipack-eval run --mode live --suite agent-e2e-live \
  --repeats 3 --report-dir eval-results --history eval-results/history.jsonl \
  --baseline eval-baseline.json --threshold 0.05
```

整体通过率下降或任一套件下降超阈值 → 退出码 1；baseline 缺失时 `--update-baseline` 建基线（快照式更新需人工评审 diff）。

**日环比可视化**：每次运行向 `eval-results/history.jsonl` 追加一行，报告渲染 sparkline + 逐次通过率 + 环比 Δ + 分套件环比；`aipack-eval history --path ...` 单独查看。

**cron**：`.github/workflows/eval-live.yml`，每日 UTC 03:00（`workflow_dispatch` 可手动指定 model / repeats），无 provider secret 时跳过；history 用 `actions/cache` 跨运行续接，报告进 Job Summary 与 artifact（保留 90 天）。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| judge 不稳定（位置偏差 / 分数抖动） | 异源模型 + repeats 取均值 + judge prompt 版本化；judge 解析失败不计入用例失败 |
| eval 集与真实分布漂移 | `origin` 分组报告；合成只做种子，trace 回流为主 |
| live 模式烧钱 | 预算熔断 + 响应缓存 + L3 用例数量控制（≤200） |
| 用例腐化（prompt 迭代后批量挂） | baseline 快照式更新流程：集中评审 `--update-baseline` 的 diff，而非逐个手改 |
| 脱敏遗漏 | 复用 `observability/src/redact`；导出管道强制过 redact 层，CI 抽查泄漏 |
