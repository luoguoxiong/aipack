# Agent Progress Guard (APG) v2-final 技术方案

## 1. 背景与问题

在 Harness Agent Runtime 中，Agent 的执行模型是一个持续循环：

```
User Goal → LLM Reasoning → Tool Call → Tool Result → Context Injection → Next Turn
```

由于下一步行为由模型自主决定，容易出现"原地打转"的情况：

- 重复执行相同动作
- 修改代码但环境没有实际变化
- 相同错误反复出现
- 搜索信息但始终形不成结论
- 消耗大量 token 但任务没有推进

### 1.1 传统 Loop Detector 的局限

传统方案只能发现**完全重复**的模式：

```
read_file("a.ts") → read_file("a.ts") → read_file("a.ts")
```

但真实场景的死循环往往是**动作不同但无进展**：

```
修改代码 → 测试失败 → 修改代码 → 测试失败 ...
搜索 A → 搜索 B → 搜索 A → 搜索 B ...
```

### 1.2 核心洞察

> 循环的本质不是"重复"，而是"消耗资源但无进展"。

因此我们需要的不是 Loop Detector，而是 **Agent Progress Guard (APG)** —— 一套 Agent Runtime 的控制平面，负责观察 Agent 是否在持续产生有效进展。

---

## 2. 设计目标

| 目标 | 具体要求 |
|------|---------|
| **进展检测** | 判断 Agent 是否真正推进任务，而不只是判断是否重复 |
| **低成本** | 不依赖 embedding，不额外调用 LLM，单轮检测 < 10ms |
| **低误报** | 白名单机制 + 上下文感知 + 升级需确认，避免误杀正常流程 |
| **渐进恢复** | 提醒 → 修正 → 限制 → 终止，多级别干预，支持降级恢复 |
| **零侵入** | P0 通过 Hook / 事件订阅接入，不修改 agent-loop 核心 |
| **可观测** | 结构化诊断报告 + Metrics + Debug 模式 |
| **通用性** | 不绑定文件系统，支持 file / API / DB / browser 等多种资源类型 |
| **可配置** | 支持不同 Agent Profile，不同任务类型有不同的策略和权重 |

---

## 3. 总体架构

```
                    Agent Runtime
                              │
                       Execution Events
                              │
  ┌───────────────────────────┴───────────────────────────────┐
  │           Agent Progress Guard (Control Plane)        │
  │                                                           │
  │  ┌──────────────┐                                        │
  │  │ Trace Collector │  采集执行轨迹                          │
  │  └───────┬───────┘                                        │
  │          ▼                                                  │
  │  ┌──────────────┐                                        │
  │  │  State Engine  │  维护资源状态快照                     │
  │  └───────┬───────┘                                        │
  │          ▼                                                  │
  │  ┌──────────────────┐                                    │
  │  │ Progress Analyzer  │  计算进展评分                       │
  │  └───────┬───────────┘                                    │
  │          ▼                                                  │
  │  ┌──────────────┐                                        │
  │  │   Risk Engine   │  风险评估 + 白名单过滤              │
  │  └───────┬───────┘                                        │
  │          ▼                                                  │
  │  ┌──────────────────────┐                                    │
  │  │ Recovery Controller │  分级干预 + 状态机                 │
  │  └──────────────────┘                                    │
  └───────────────────────────┬───────────────────────────────┘
                              │
                   ┌──────────┴──────────┐
                   ▼                     ▼
           steer / restrict         abort
         (注入消息/限制工具)        (终止运行)
```

### 3.1 五层职责

| 层级 | 组件 | 职责 |
|------|------|------|
| **采集层** | Trace Collector | 从 Agent 事件流中采集 Execution Trace |
| **状态层** | State Engine | 维护 ResourceState，生成 StateSnapshot |
| **分析层** | Progress Analyzer | 计算 ProgressScore，运行检测策略 |
| **决策层** | Risk Engine | 加权融合 + 白名单过滤 → RiskAssessment |
| **控制层** | Recovery Controller | 状态机管理 + 分级干预 + 降级恢复 |

### 3.2 集成原则

- **P0 零侵入核心**：通过 `agent.subscribe()` + `agent.steer()` + `agent.abort()` 三个公开 API 接入
- **可热插拔**：随时启用/禁用，不影响 Agent 正常运行
- **远期 Middleware**：P3 再考虑是否在 pi-core 层引入 Middleware 抽象

---

## 4. 核心概念

### 4.1 Execution Trace（执行轨迹）

Agent 的每一步行为都被记录为 Step，形成完整的执行轨迹。

```typescript
interface ExecutionTrace {
  steps: TraceStep[];
  windowSize: number;           // 滑窗大小，默认 20
  totalSteps: number;
}

interface TraceStep {
  id: number;                   // 全局递增序号
  turnIndex: number;            // 所属 turn（一个 turn 可能有多个 tool call）
  type: 'assistant' | 'tool_call' | 'tool_result';

  // 工具相关
  toolName?: string;
  toolIntent?: ToolIntent;      // 抽象后的操作意图
  inputHash?: string;          // 输入参数的规范化哈希
  outputHash?: string;         // 输出结果的指纹哈希

  // 目标资源
  resourceType?: ResourceType;        // 资源类型 (file/api/db/...)
  resourceId?: string;          // 资源标识 (文件路径/URL/表名...)
  targetKey?: string;         // 操作对象的人类可读标识

  // 效果
  success: boolean;
  errorHash?: string;          // 错误指纹
  errorType?: string;           // 错误分类

  // 状态快照
  stateBefore: string;           // 操作前的状态哈希
  stateAfter: string;            // 操作后的状态哈希
  stateChanged: boolean;        // 状态是否变化

  // 元数据
  timestamp: number;
  durationMs: number;
  tokensUsed?: number;        // 本轮 token 消耗
}
```

### 4.2 Resource State（资源状态）

不绑定文件系统。Agent 的状态可能来自多种资源类型。

```typescript
type ResourceType =
  | 'file'       // 文件系统
  | 'api'        // API 响应
  | 'database'   // 数据库
  | 'memory'     // 记忆系统
  | 'browser'    // 浏览器页面
  | 'workflow'    // 工作流状态
  | 'other';

interface ResourceState {
  type: ResourceType;
  id: string;               // 资源唯一标识 (路径/URL/主键...)
  hash: string;           // 内容/值的指纹
  lastModified: number;  // 最后修改时间
  accessCount: number;   // 被访问次数
  modifyCount: number;  // 被修改次数
}

interface StateSnapshot {
  resources: Record<string, ResourceState>;  // key = type:id
  stateHash: string;                       // 所有资源的综合哈希
  modifiedCount: number;                       // 被修改过的资源数
  errorHash: string;                       // 错误状态的综合哈希
}
```

**状态更新规则**：

| 操作类型 | 对 stateHash 的影响 |
|---------|-------------------|
| 读操作 (READ intent) | 更新 `accessCount`，stateHash **可能变化**（因为 toolResultHashes 更新） |
| 写操作 (MODIFY intent) | 更新 `hash` + `modifyCount`，stateHash **一定变化**（如果内容真的变了） |
| 验证操作 (VERIFY intent) | 根据结果判断，错误更新 errorHash |
| 操作失败 | 只更新 errorHash，不更新资源 hash |
| shell / 不可追踪操作 | 标记为 `maybe_changed`，保守假设状态可能变了 |

### 4.3 Tool Intent（工具意图抽象）

把具体工具映射到更高层的操作意图，避免"参数不同就算不同操作"的问题。

```typescript
type ToolIntent =
  | 'READ'           // 读操作：读文件/搜索/查询/获取
  | 'MODIFY'         // 写操作：写文件/编辑/删除/创建
  | 'VERIFY'         // 验证：测试/编译/检查/运行
  | 'RESEARCH'       // 调研：搜索/web_fetch/文档查询
  | 'MEMORY'         // 记忆：读写
  | 'SCHEDULE'       // 调度：cron/定时
  | 'OTHER';
```

**默认映射表**（可配置，可通过 `tool_intents` 覆盖）：

| 工具名 | Intent | 资源类型 |
|-------|--------|---------|
| read_file | READ | file |
| edit_file | MODIFY | file |
| write_file | MODIFY | file |
| apply_patch | MODIFY | file |
| delete_file | MODIFY | file |
| grep | READ | file |
| search_codebase | READ | file |
| find_files | READ | file |
| shell | VERIFY (可配置) | other |
| web_search | RESEARCH | api |
| web_fetch | RESEARCH | api |
| memory_* | MEMORY | memory |
| cron_* | SCHEDULE | other |

### 4.4 Progress Score（进展评分）

每轮的进展评分，0-1 分。由多个维度加权得出。

```typescript
interface ProgressScore {
  score: number;              // 综合得分 0-1
  trend: 'up' | 'down' | 'flat';  // 与上一轮对比的趋势

  signals: {
    stateChange: number;       // 状态变化 0-1 (资源修改/内容变化)
    infoGain: number;         // 信息增益 0-1 (新资源/新结果/新发现)
    errorMovement: number;    // 错误动态 0-1 (错误减少/错误类型变化 → 正分；错误不变/增加 → 负分)
    novelty: number;         // 目标新颖度 0-1 (操作了多少新资源/新目标)
    outputGrowth: number;    // 产出增长 0-1 (文本长度/工具调用数变化)
  };
}
```

**默认权重**：

```
progressScore =
  0.35 * stateChange
+ 0.30 * infoGain
+ 0.20 * errorMovement
+ 0.10 * novelty
+ 0.05 * outputGrowth
```

> 注：`goalProgress` 放在 P2 阶段，因为 Goal State 生成需要额外机制支持。

### 4.5 Budget State（预算状态）

追踪资源消耗，用于检测"高消耗 + 低进展 = 浪费"。

```typescript
interface BudgetState {
  tokens: number;           // 累计 token 消耗
  cost: number;           // 累计成本估算
  toolCalls: number;     // 累计工具调用次数
  turns: number;        // 累计轮数
  durationMs: number;      // 累计运行时长

  // 预算限制
  maxTokens?: number;
  maxToolCalls?: number;
  maxTurns?: number;
  maxDurationMs?: number;
}
```

---

## 5. 检测策略

6 种策略，各有侧重，独立计算置信度，最后加权融合。

### 5.1 State Freeze Detection（状态冻结检测）

**最高优先级，最可靠的信号。**

检测：**写操作之后，资源状态没有变化**。

```
turn 1: modify_file("a.ts") → resource hash: ABC → changed: true   ✓ 正常
turn 2: modify_file("a.ts") → resource hash: ABC → changed: false  ✗ 冻结
turn 3: modify_file("a.ts") → resource hash: ABC → changed: false  ✗ 冻结
```

**判定逻辑**：
- 只看 **写操作**（MODIFY intent），读操作不改变资源状态是正常的
- 连续 N 次写操作后资源 hash 不变 → 触发
- N 默认 = 3
- 如果 shell 等不可追踪操作，保守假设状态变了

**置信度**：0.9

**对应场景**：
- 反复修改但内容没变（改错地方了 / 修改被回滚了）
- 写操作失败但 Agent 以为成功了

### 5.2 Error Loop Detection（错误循环检测）

**针对 coding / fix 类任务的核心策略。**

检测：**同一个错误反复出现，Agent 尝试修复但失败。**

```
turn 1: npm test → Error: "undefined variable 'foo'"  (errorHash: XYZ)
turn 2: edit_file → 自以为修好了
turn 3: npm test → Error: "undefined variable 'foo'"  (errorHash: XYZ)  ← 循环开始
turn 4: edit_file → 又改了一次
turn 5: npm test → Error: "undefined variable 'foo'"  (errorHash: XYZ)
```

**判定逻辑**：
- 计算错误指纹（errorHash）：对错误信息做规范化哈希
- 同一个 errorHash 出现 ≥ N 次 → 触发
- N 默认 = 3
- 中间如果有新的错误类型出现，重置计数

**置信度**：0.85

**对应场景**：
- 修 bug 但每次都没修对
- 同一个测试反复失败
- 自我修正但方向错误

### 5.3 Tool Intent Cycle Detection（工具意图循环检测）

检测：**工具意图序列形成周期性重复模式。**

使用 **N-gram 模式匹配**：

```
2-gram:  MODIFY VERIFY MODIFY VERIFY      → 检测到周期=2 的循环
3-gram:  READ MODIFY VERIFY READ MODIFY VERIFY  → 检测到周期=3 的循环
```

检测的是 **Tool Intent 序列**，不是具体工具名。

**判定逻辑**：
- 滑窗内检测长度为 2/3/4 的重复模式
- 重复次数 ≥ 3 次 → 触发
- 置信度随模式长度升高（长模式更可信）
- 如果每轮的 stateChange 或 infoGain > 0，不触发（有进展就不算循环）

**置信度**：0.5 ~ 0.75（取决于模式长度和重复次数）

**对应场景**：
- 读 → 改 → 验证 → 读 → 改 → 验证（但没进展）
- 搜索 A → 搜索 B → 搜索 A → 搜索 B

### 5.4 Action Repetition（动作重复检测）

**基础检测，权重最低。**

检测：**完全相同的工具调用（name + inputHash）重复出现。**

```
turn 1: read_file("config.json")  inputHash: abc
turn 2: read_file("config.json")  inputHash: abc  ← 重复
turn 3: read_file("config.json")  inputHash: abc  ← 重复
```

**判定逻辑**：
- 同一 tool + 同一 inputHash 连续出现 ≥ N 次 → 触发
- N 默认：写操作 = 3，读操作 = 5（读操作阈值更高）
- 如果输出结果不同，降低置信度

**置信度**：0.4 ~ 0.6

### 5.5 Progress Stagnation（进展停滞检测）

检测：**连续多轮 Progress Score 持续低于阈值。**

```
turn 1: progress = 0.8   ← 正常
turn 2: progress = 0.3   ← 下降
turn 3: progress = 0.1   ← 很低
turn 4: progress = 0.05  ← 几乎没有进展
turn 5: progress = 0.0   ← 完全停滞
```

**判定逻辑**：
- 连续 N 轮 progressScore < threshold → 触发
- N 默认 = 4
- threshold 默认 = 0.2
- 趋势（trend）也是判断因素——持续下降比一直低位更危险

**置信度**：0.7

### 5.6 Budget Waste Detection（预算浪费检测）

检测：**消耗了大量资源，但进展很少。**

```
tokens: 50000
progress: 0.1
→ 单位进展成本 = 50000 / 0.1 = 500000 tokens/单位进展  ← 严重浪费
```

**判定逻辑**：
- 计算效率比：`tokens / (progressScore + 0.1)`
- 效率比 > 阈值 → 触发
- 只在总 token 消耗超过最小阈值后才开始检测（避免早期误判）

**置信度**：0.6

---

## 6. Risk Engine（风险引擎）

### 6.1 风险分计算

```typescript
riskScore =
  stateFreezeConfidence     * 0.35
+ errorLoopConfidence     * 0.30
+ toolCycleConfidence     * 0.15
+ progressStagnationConfidence * 0.10
+ budgetWasteConfidence   * 0.10
```

权重设计思路：
- **状态冻结**和**错误循环**是最强信号，占 65%
- **工具循环**是中等信号，占 15%
- **进展停滞**和**预算浪费**是辅助信号，占 20%

### 6.2 风险等级阈值

| 等级 | 风险分 | 含义 |
|------|-------|------|
| `normal` | < 0.4 | 正常运行 |
| `suspicious` | 0.4 ~ 0.7 | 可疑，需要关注 |
| `stuck` | 0.7 ~ 0.9 | 卡住了，需要干预 |
| `failed` | ≥ 0.9 | 判定失败，终止 |

### 6.3 Agent Profile（任务类型适配）

不同类型的 Agent 有不同的权重和阈值。

```typescript
type AgentProfile = 'coding' | 'research' | 'assistant' | 'workflow';
```

| Profile | 调整 | 原因 |
|---------|------|------|
| **coding** | stateFreeze ↑, errorLoop ↑, toolCycle ↓ | 写操作多，错误循环常见；工具序列重复是正常开发流程 |
| **research** | infoGain ↑, toolCycle ↑, stateFreeze ↓ | 读操作多，状态变化少；信息增益是关键 |
| **assistant** | novelty ↑, errorLoop ↓, stateFreeze ↓ | 对话为主，工具调用少；回复多样性是关键 |
| **workflow** | goalProgress ↑, budgetWaste ↑ | 有明确步骤和预算 |

Profile 通过配置文件指定，默认 `assistant`。

---

## 7. 白名单机制（降低误报）

即使达到阈值，以下情况也**不升级风险**。这是控制误报率的关键。

### 7.1 批量操作模式

检测到 Agent 在**枚举不同资源**（不同文件 / 不同 URL / 不同记录），且每轮都有产出：

```
turn 1: process file_1.ts  resourceId: file_1.ts
turn 2: process file_2.ts  resourceId: file_2.ts  ← 新资源
turn 3: process file_3.ts  resourceId: file_3.ts  ← 新资源
turn 4: process file_4.ts  resourceId: file_4.ts  ← 新资源
```

**判定规则**：
- 连续 N 轮操作的 resourceId 都不同
- 且每轮都有 stateChange 或 infoGain > 0
- → 判定为批量操作，豁免

### 7.2 长思考链模式

工具调用很少，但**文本输出在持续增长**：

```
turn 1: text length = 500, tools = 0
turn 2: text length = 1200, tools = 0  ← 增长了
turn 3: text length = 2000, tools = 0  ← 增长了
```

**判定规则**：
- 连续 N 轮工具调用数 ≤ 1
- 且文本长度持续增长
- → 判定为长思考链，豁免

### 7.3 自我修正模式

错误在**变化**（不是同一个错误反复出现），说明 Agent 在尝试不同方法：

```
turn 1: error: "syntax error at line 5"
turn 2: error: "undefined variable 'foo'"   ← 错误变了
turn 3: error: "type mismatch at line 10"   ← 错误又变了
```

**判定规则**：
- 连续 N 轮都有错误
- 但每个错误的 errorHash 都不同
- 且 error 数量在减少或类型在变化
- → 判定为自我修正中，豁免（最多豁免 M 轮）

### 7.4 自定义白名单

用户可配置的豁免规则：

```yaml
whitelist:
  tools:                  # 这些工具的重复不算循环
    - read_file
    - web_search
  resource_types:           # 这些资源类型的重复允许
    - memory
  max_self_correction_retries: 3  # 自我修正的最大豁免轮数
```

---

## 8. Recovery Controller（恢复控制器）

### 8.1 状态机

```
                       ┌─────────────┐
                       │   NORMAL    │
                       └──────┬──────┘
                              │
                risk > suspicious_threshold
                且连续 2 轮确认 (confirmation_turns = 2)
                              ▼
                       ┌─────────────┐
               ┌──────→│ SUSPICIOUS  │──────┐
               │       └──────┬──────┘      │
               │              │              │
               │   risk > stuck_threshold   │
               │   且连续 2 轮确认           │  risk < normal_threshold
               │              ▼              │  且连续 3 轮恢复 (downgrade_turns = 3)
               │       ┌─────────────┐      │
               │       │   STUCK     │──────┘
               │       └──────┬──────┘
               │              │
               │   重试次数用完 / risk > failed
               │   且连续 2 轮确认
               │              ▼
               │       ┌─────────────┐
               └───────│   FAILED    │
               回退    └─────────────┘
```

**关键规则**：
- **升级需要确认**：连续 N 轮风险分都超过阈值才升级，避免单轮波动
- **降级需要稳定**：连续 M 轮风险分都低于阈值才降级，确保真正恢复
- **FAILED 是终态**：一旦进入 FAILED，就终止运行，不支持降级
- **默认值**：升级确认 = 2 轮，降级确认 = 3 轮（降级更谨慎）

### 8.2 分级干预策略

| 风险等级 | 干预级别 | 干预动作 | 具体行为 |
|---------|---------|---------|---------|
| **NORMAL** | L0 | 无 | 正常运行，静默采集指标 |
| **SUSPICIOUS** | L1 | Reflection（反思） | 通过 `steer()` 注入反思消息，提醒检查是否在原地打转 |
| **STUCK** | L2 | Context Reset（上下文重置） | 压缩历史，保留关键信息，重新明确目标 |
| **STUCK** | L3 | Tool Restriction（工具限制） | 禁止继续使用导致循环的工具 |
| **FAILED** | L4 | Terminate（终止） | 调用 `abort()` 终止，返回结构化失败原因 |

> 注：L2 和 L3 都是 STUCK 级的干预，先尝试 L2，无效再升级到 L3。

### 8.3 Reflection 干预（L1，SUSPICIOUS 级）

注入的消息示例：

```
你似乎在重复类似的操作但没有明显进展。请先停下来反思：

1. 你已经尝试了哪些方法？
2. 目前的状态和开始时有什么不同？
3. 是否需要换一种思路？
4. 如果卡住了，请直接说明，我可以提供帮助。

建议：先列一个清晰的下一步计划，再继续执行。
```

注入方式：通过 `agent.steer()`，消息会在下一个 assistant turn 之前注入。

### 8.4 Context Reset 干预（L2，STUCK 级）

**做什么**：
1. 找到循环起点（风险开始上升的那个 turn）
2. 保留：goal（如果有）+ 关键资源列表 + 当前状态摘要 + 错误摘要
3. 丢弃：循环过程中的无效 tool history
4. 注入：新的系统级引导消息

**怎么做**：
- P0-P1：通过 `steer()` 注入总结 + 重述目标的消息
- P2：结合 `transformContext` 机制做更深度的重置

注入的消息示例：

```
[系统重置] 检测到你可能卡住了。以下是当前状态的摘要：

已修改的资源：{modifiedResources}
最近的错误：{lastError}
已尝试的方法：{已尝试的策略列表}

请基于以上信息，换一种方法重新开始。不要重复之前已经失败的尝试。
```

### 8.5 Tool Restriction 干预（L3，STUCK 级）

**做什么**：禁止 Agent 继续使用导致循环的工具。

**实现方式**（P1 及以后）：
- 通过 `beforeToolCall` hook 拦截，返回 `{ block: true }`
- 或通过 `steer()` 明确告诉模型"禁止再使用 X 工具"

**示例场景**：
- 反复 read_file 同一个文件 → 禁止继续 read_file 该文件
- 反复运行同一个测试但总失败 → 禁止继续运行该测试，建议换方法

### 8.6 Terminate 干预（L4，FAILED 级）

终止运行，并返回结构化的失败信息：

```typescript
interface FailureReport {
  reason: string;              // 失败原因简述
  riskLevel: 'failed';
  diagnosis: {
    firstDetectedTurn: number;  // 首次检测到异常的轮次
    stuckDurationTurns: number;// 卡住了多少轮
    tokensWasted: number;       // 浪费的 token 数
    patterns: string[];         // 检测到的循环模式
    strategyBreakdown: {       // 各策略得分
      name: string;
      confidence: number;
      evidence: string;
    }[];
  };
  stateSnapshot: {
    modifiedResources: string[];
    lastError?: string;
  };
  suggestion: string;           // 给用户的建议
}
```

---

## 9. 与 Agent Runtime 的集成

### 9.1 P0 集成方式：Hook + 事件订阅

**零侵入，纯外部挂载。**

使用 Agent 已有的三个公开 API：

| API | 用途 |
|-----|------|
| `agent.subscribe(listener)` | 监听生命周期事件，采集信号 |
| `agent.steer(message)` | 注入反思 / 引导消息 |
| `agent.abort()` | 终止运行 |

不需要修改 `agent-loop.ts` 一行代码。

### 9.2 集成代码结构

```typescript
// 使用方式
const agent = new Agent({...});

const progressGuard = new ProgressGuard({
  enabled: true,
  profile: 'coding',
  windowSize: 20,
  thresholds: {...},
  strategies: [...],
  recovery: {...},
  whitelist: {...},
  budget: {...},
});

// 挂载
progressGuard.attach(agent);

// 监听事件
progressGuard.on('risk_change', (event) => {
  logger.info({ level: event.level, score: event.score }, 'Risk level changed');
});

progressGuard.on('intervention', (event) => {
  logger.info({ level: event.level, action: event.action }, 'Intervention triggered');
});

progressGuard.on('diagnosis', (diagnosis) => {
  logger.debug(diagnosis, 'Progress diagnosis');
});
```

### 9.3 内部数据流

```
agent.subscribe()
      │
      ▼
┌─────────────────┐
│ Trace Collector  │  收集 TraceStep
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   State Engine   │  更新 ResourceState，生成 StateSnapshot
└────────┬────────┘
         │
         ▼
┌────────────────────┐
│ Progress Analyzer  │  计算 ProgressScore，运行检测策略
└────────┬───────────┘
         │
         ▼
┌─────────────────┐
│   Risk Engine    │  加权融合 + 白名单过滤 → RiskAssessment
└────────┬────────┘
         │
         ▼
┌────────────────────┐
│ Recovery Controller │  状态机 + 分级干预 + 降级恢复
└────────┬───────────┘
         │
         ├─→ agent.steer()      注入消息
         ├─→ agent.abort()      终止运行
         └─→ event emitter        发布事件
```

### 9.4 远期：Middleware 模式（P3）

验证价值后，可考虑在 Agent Runtime 层引入 Middleware 抽象：

```
Agent → Middleware Chain → Tool Runtime
                    ↑
              ProgressGuard
```

但这属于 P3 远期目标，P0-P2 不依赖这个。

---

## 10. 配置设计

```yaml
progress_guard:
  enabled: true
  profile: coding               # coding / research / assistant / workflow
  window_size: 20
  min_turns_before_detect: 3   # 至少多少轮后才开始检测

  # 风险阈值
  thresholds:
    suspicious: 0.4
    stuck: 0.7
    failed: 0.9

  # 状态机配置
  state_machine:
    confirmation_turns: 2     # 升级需要连续确认的轮数
    downgrade_turns: 3        # 降级需要连续恢复的轮数

  # 策略权重 (可被 profile 覆盖)
  strategy_weights:
    state_freeze: 0.35
    error_loop: 0.30
    tool_cycle: 0.15
    progress_stagnation: 0.10
    budget_waste: 0.10

  # 启用的检测策略
  strategies:
    - state_freeze
    - error_loop
    - tool_cycle
    - progress_stagnation
    - action_repeat
    - budget_waste

  # 工具意图映射 (可覆盖默认)
  tool_intents:
    shell: VERIFY
    web_search: RESEARCH

  # 白名单
  whitelist:
    batch_operation: true          # 允许批量操作模式
    long_thinking_chain: true      # 允许长思考链
    self_correction_retries: 3     # 自我修正豁免轮数
    allowed_repeat_tools:          # 允许重复调用的工具
      - read_file
      - web_search

  # 恢复策略
  recovery:
    suspicious:
      action: reflection
      cooldown_turns: 3            # 同级别干预的冷却轮数
    stuck:
      actions:                     # 按顺序尝试
        - context_reset
        - tool_restriction
      max_retries: 2               # 最多干预几次
    failed:
      action: terminate

  # 预算配置
  budget:
    enabled: true
    max_tokens: 100000
    max_tool_calls: 200
    max_turns: 50
    efficiency_threshold: 50000         # 单位进展 token 数，超过则判定浪费

  # Profile 覆盖 (示例: coding profile 的特殊配置)
  profiles:
    coding:
      strategy_weights:
        state_freeze: 0.40
        error_loop: 0.35
        tool_cycle: 0.10
    research:
      strategy_weights:
        info_gain: 0.35
        tool_cycle: 0.25
        state_freeze: 0.15
```

---

## 11. 可观测性

### 11.1 诊断报告

检测到卡住时输出结构化诊断：

```typescript
interface ProgressDiagnosis {
  riskLevel: RiskLevel;
  riskScore: number;
  firstDetectedTurn: number;
  stuckDurationTurns: number;
  tokensWasted: number;

  // 各策略的详细得分
  strategyBreakdown: {
    name: string;
    confidence: number;
    evidence: string;
  }[];

  // 进展趋势
  progressTrend: {
    turn: number;
    score: number;
  }[];

  // 检测到的模式
  detectedPatterns: string[];

  // 白名单命中情况
  whitelistChecks: {
    name: string;
    matched: boolean;
    detail?: string;
  }[];

  // 建议
  suggestedAction: string;
}
```

### 11.2 Metrics

| 指标名 | 类型 | 说明 |
|--------|------|------|
| `pg_risk_score` | Gauge | 当前风险分 0-1 |
| `pg_risk_level` | Gauge | 当前风险等级 (0/1/2/3) |
| `pg_progress_score` | Gauge | 当前进展分 0-1 |
| `pg_tokens_total` | Counter | 累计 token 消耗 |
| `pg_intervention_total` | Counter | 干预次数总计，按级别和类型分标签 |
| `pg_detected_total` | Counter | 检测到卡住的次数 |
| `pg_tokens_wasted_total` | Counter | 循环浪费的 token 数 |
| `pg_avg_recovery_turns` | Histogram | 从卡住到恢复平均用了多少轮 |
| `pg_whitelist_hits_total` | Counter | 白名单命中次数，按类型分标签 |

### 11.3 Debug 模式

开启后每轮输出详细的检测信息：

```
[PG] Turn 5
  Progress: 0.15 (stateChange:0.0, infoGain:0.1, errorMovement:0.0, novelty:0.3, outputGrowth:0.2)
  Risk: 0.65 (stateFreeze:0.8*0.35 + errorLoop:0.7*0.30 + toolCycle:0.5*0.15 + stagnation:0.6*0.10 + budget:0.4*0.10)
  Level: suspicious (连续 1/2 轮确认)
  Whitelist: batch=no, long_chain=no, self_correction=yes (剩余 2 次)
  Budget: tokens=12500, efficiency=83333/单位进展
```

---

## 12. 实现路线

| 阶段 | 内容 | 代码量 | 价值 |
|------|------|-------|------|
| **P0 骨架** | Trace Collector + State Engine (ResourceState) + StateFreeze + ErrorLoop + RiskScore (基础) + Reflection 干预 + Hook 集成 + 基础测试 | ~400 行 | 能用，覆盖 coding 场景 70% |
| **P1 增强** | ToolIntent + ToolCycle + ProgressStagnation + BudgetGuard + 白名单 (批量/长链/自修正) + 三级干预 + 降级恢复 + 诊断报告 | ~500 行 | 准确，误报率低，干预智能 |
| **P2 完善** | Context Reset + Tool Restriction + Agent Profile + 完整 Metrics + Debug 模式 + 配置化 + GoalState(可选) | ~400 行 | 完善，可观测，生产可用 |
| **P3 高级** | Middleware 集成 + 自适应权重 + 语义分析 + 文件系统级 state 追踪 + Dashboard | ~400 行 | 智能进化，平台级能力 |

### P0 交付物

- `src/progress-guard/index.ts` — 主入口 + ProgressGuard 类
- `src/progress-guard/trace-collector.ts` — 轨迹采集
- `src/progress-guard/state-engine.ts` — 状态引擎
- `src/progress-guard/progress-analyzer.ts` — 进展分析
- `src/progress-guard/risk-engine.ts` — 风险引擎
- `src/progress-guard/recovery-controller.ts` — 恢复控制
- `src/progress-guard/types.ts` — 类型定义
- `tests/progress-guard.test.ts` — 单元测试

---

## 13. 与传统 Loop Detector 对比

| 能力 | 传统 Loop Detector | APG v2-final |
|------|-------------------|--------------|
| 完全重复检测 | ✅ | ✅ |
| 状态变化判断 | ❌ | ✅ (通用 ResourceState) |
| 错误循环识别 | 部分 | ✅ |
| 工具序列模式检测 | 部分 | ✅ (Intent 级) |
| 进展度量 | ❌ | ✅ |
| 预算/浪费检测 | ❌ | ✅ |
| 白名单 / 误报控制 | ❌ | ✅ (4 种豁免) |
| 分级干预 | 3 级 | 4 级 + 降级恢复 |
| 状态机确认 | ❌ | ✅ (升级/降级都需确认) |
| 诊断报告 | 简单 | 结构化 + Metrics + Debug |
| Agent Profile 适配 | ❌ | ✅ (4 种预设) |
| 通用性 | 文件为主 | 多资源类型 |
| Coding agent 适配 | 一般 | 优秀 |
| 无需 LLM | ✅ | ✅ |
| 零侵入集成 | 需修改核心 | ✅ Hook 接入 |

---

## 14. 核心设计原则

1. **进展优先，重复为辅**：不判断 Agent 有没有重复，而判断 Agent 有没有继续产生有效进展
2. **多信号融合，避免单点误判**：6 种策略加权，白名单过滤，升级需要确认
3. **渐进干预，给足机会**：从提醒到终止分多级，每级都有冷却和降级机制
4. **零侵入起步，逐步深化**：P0 用 Hook 接入，验证价值后再考虑 Middleware 等深层集成
5. **通用抽象，不绑定场景**：ResourceState 不绑定文件系统，支持多种资源类型
6. **可观测可解释**：每一次判定都有结构化的原因和证据，不是黑盒
7. **Profile 化配置**：不同类型的 Agent 和任务有不同的策略和权重

---

## 15. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 误报（正常流程被判为卡住） | 用户体验差 | 白名单机制 + 升级需 2 轮确认 + SUSPICIOUS 级只提醒不打断 + 降级恢复 |
| 漏报（真卡住了没检测到） | 浪费 token | 多策略互补 + ProgressStagnation + BudgetWaste 兜底 |
| 干预后反而更糟 | 任务失败 | 降级机制 + 最多干预 N 次 + 用户可随时手动关闭 |
| StateEngine 不准确 | 检测不准 | P0 只追踪已知工具，不可追踪操作保守假设；P2 可增加文件系统监控 |
| 性能开销 | 增加延迟 | 纯计算无 I/O，目标 < 10ms/轮；可通过配置关闭部分策略 |
| Profile 选择困难 | 效果打折 | 提供 4 种预设 Profile + 支持自定义权重 + P3 自适应 |

---

## 16. 最终定位

Agent Progress Guard 不只是一个 Loop Detector，而是 **Agent Runtime 的控制平面 (Control Plane)**。

它负责：

```
观察 Agent 运行状态
    ↓
判断是否产生有效进展
    ↓
识别风险等级
    ↓
自动恢复 / 干预
    ↓
输出可观测诊断
```

最终目标：

> 让 Agent 不仅能执行任务，还能知道自己是否正在浪费资源。

**推荐作为 `kobot` Runtime 层的基础能力实现。
