# Agent Context Runtime (ACR) v2.1 生产级方案

## 1. 定位

Agent Context Runtime（ACR）不是简单的 Context Compressor，而是 **Agent Runtime 的上下文生命周期管理系统**——Agent Context Operating System。

核心思想：

> **不压缩历史，而是重建 Agent 当前世界状态。**

传统"上下文压缩"的思路是在 Message 层面做减法——"哪些内容可以删掉"。ACR 的思路是在 State 层面做加法——"Agent 当前需要知道什么"。

就像人不需要记住所有对话细节，只需要知道：

- 我现在在哪（当前状态）
- 我要去哪（目标）
- 试过什么（失败尝试）
- 什么有效（成功路径）
- 有什么约束（边界条件）

---

## 2. 设计目标

| 目标               | 具体要求                                                                  |
| ------------------ | ------------------------------------------------------------------------- |
| **状态驱动**       | 以 AgentState Snapshot 为核心，而非消息截断                               |
| **长期运行**       | 支持 Agent 连续运行数小时/数百轮不丢失状态                                |
| **主动预防**       | 通过 Value Density 和 Context Entropy 提前压缩，不等 token 满了才被动处理 |
| **Workspace 感知** | 直接观测 git/filesystem，ground truth 状态不依赖 tool result 推断         |
| **分层上下文**     | L0-L5 六层模型，State > Recent > History 优先级清晰                       |
| **工具消化**       | Tool Result 不截断，而是 Digest 成结构化摘要                              |
| **三层记忆**       | Session / Workspace / User 记忆分离，各有生命周期                         |
| **零侵入**         | P0 通过 Hook 接入，不修改 agent-loop 核心                                 |
| **生产就绪**       | 完整配置体系、可观测性、风险控制、测试验证                                |

---

## 3. 总体架构

```
                         Agent Runtime (kobot/pi-agent-core)
                                   │
                       ┌───────────┴───────────┐
                       │    Agent Loop         │
                       └───────────┬───────────┘
                                   │
                          ┌────────┴────────┐
                          │ Context Health  │
                          │    Monitor      │
                          └────────┬────────┘
                                   │
          ┌────────────┬───────────┼───────────┬────────────┐
          ▼            ▼           ▼           ▼            ▼
   Token Monitor  Value Density  Entropy     Phase       Loop/Error
                 Monitor      Monitor      Detector     Detector
                                   │
                          ┌────────┴────────┐
                          │ Context Runtime │
                          │   (Orchestrator)│
                          └────────┬────────┘
                                   │
    ┌──────────┬──────────┬────────┼────────┬──────────┬──────────┐
    ▼          ▼          ▼        ▼        ▼          ▼          ▼
 State     Tool       Importance Compression Memory  Snapshot   Workspace
Extractor  Digestor    Engine     Pipeline   Writer   Builder    Observer
                                   │
                          ┌────────┴────────┐
                          │ Context Rebuild │
                          │  (State-based)  │
                          └────────┬────────┘
                                   │
                          ┌────────┴────────┐
                          │  New Context    │
                          │    Window       │
                          └─────────────────┘
```

### 3.1 核心流程（六步法）

```
    Observe
      ↓
    Understand
      ↓
    Compress
      ↓
    Remember
      ↓
    Rebuild
      ↓
    Continue
```

| 阶段           | 组件                                        | 职责                                              |
| -------------- | ------------------------------------------- | ------------------------------------------------- |
| **Observe**    | Context Health Monitor + Workspace Observer | 观测上下文健康度（token/密度/熵）和工作区真实状态 |
| **Understand** | State Extractor + Importance Engine         | 理解当前 Agent 处于什么状态，哪些信息重要         |
| **Compress**   | Compression Pipeline + Tool Digestor        | 执行分级压缩策略，消化工具输出                    |
| **Remember**   | Memory Writer (三层)                        | 关键信息写入对应记忆层                            |
| **Rebuild**    | Snapshot Builder                            | 基于 AgentState 重建上下文窗口                    |
| **Continue**   | Transition Injector                         | 注入平滑过渡消息，Agent 继续运行                  |

### 3.2 与 APG (Progress Guard) 的关系

ACR 与 APG 是 Runtime 控制平面的**双支柱**：

```
┌─────────────┐  suspicious/stuck   ┌─────────────┐
│  Progress   │────────────────────→│    ACR      │
│  Guard      │                     │             │
│ (检测问题)   │←────────────────────│ (恢复上下文) │
└─────────────┘  compression done   └─────────────┘
```

- APG 回答"Agent 是否卡住了"——进展检测
- ACR 回答"Agent 需要知道什么"——上下文管理
- APG 检测到问题 → 触发 ACR 做对应级别的压缩/重建
- ACR 完成重建 → 通知 APG 重置检测窗口（给 Agent 新起点）

### 3.3 集成方式

与 APG 相同，**P0 通过 Hook 零侵入接入**：

```typescript
const agent = new Agent({...});

const acr = new AgentContextRuntime({
  enabled: true,
  profile: 'coding',
  monitors: [...],
  compression: {...},
  memory: {...},
});

// 挂载
acr.attach(agent);

// 事件监听
acr.on('compression', (result) => {
  logger.info({ level: result.level, saved: result.tokensSaved }, 'Context compressed');
});

// 与 APG 联动
progressGuard.on('suspicious', () => acr.compact({ trigger: 'progress_suspicious', level: 'clean' }));
progressGuard.on('stuck', () => acr.compact({ trigger: 'progress_stuck', level: 'collapse' }));
```

接入点：

```typescript
agent.on('before_model_call', (ctx) => acr.check(ctx));
agent.on('after_tool_call', (ctx) => acr.observe(ctx));
agent.on('stuck', () => acr.compact({ trigger: 'stuck', level: 'snapshot' }));
```

---

## 4. Agent State Snapshot

**上下文管理的核心不是 Message，而是 AgentState。**

Message 是通信载体，State 才是 Agent 对世界的认知。压缩后重建上下文时，State Snapshot 是第一等公民。

```typescript
interface AgentState {
  // 任务状态
  task: {
    goal: string; // 当前目标（原始目标可能已演化，保留最新活跃目标）
    phase: TaskPhase; // 当前阶段
    status: 'running' | 'blocked' | 'completed';
    startTime: number;
    elapsedMs: number;
  };

  // 进展追踪
  completedTasks: string[]; // 已完成的子任务
  nextActions: string[]; // 明确的下一步方向
  attemptedStrategies: {
    // 已尝试的方法及结果
    strategy: string;
    result: 'success' | 'failed' | 'partial';
    reason?: string;
  }[];

  // 约束条件（永不删除）
  constraints: {
    content: string;
    source: 'user' | 'system' | 'decision';
    priority: 'critical' | 'high' | 'medium';
  }[];

  // 关键决策
  decisions: {
    decision: string;
    reason: string;
    timestamp: number;
  }[];

  // 工作区状态（来自 Workspace Observer 的 ground truth）
  workspace: {
    modifiedFiles: FileState[];
    createdFiles: string[];
    deletedFiles: string[];
    gitStatus: GitStatus;
    gitDiffSummary: string;
    testStatus: TestStatus;
  };

  // 错误状态
  errors: {
    error: string;
    errorType: string;
    source: string; // 哪个工具/步骤产生的
    resolved: boolean;
    firstSeen: number;
    occurrenceCount: number;
  }[];

  // 失败尝试（折叠后保留摘要）
  failedAttempts: {
    action: string;
    target: string; // 目标文件/资源
    failureReason: string;
    errorType: string;
  }[];

  // 关键发现（Research 场景）
  keyFindings?: {
    content: string;
    source: string;
    relevance: number;
  }[];

  // 元数据
  metadata: {
    snapshotVersion: number;
    lastUpdated: number;
    compressionCount: number;
  };
}

type TaskPhase =
  | 'requirement_analysis' // 需求分析
  | 'exploration' // 探索/调研
  | 'planning' // 规划
  | 'implementation' // 实现
  | 'verification' // 验证/测试
  | 'debugging' // 调试
  | 'refactoring' // 重构
  | 'documentation' // 文档
  | 'unknown';

interface FileState {
  path: string;
  status: 'modified' | 'created' | 'deleted';
  diffSummary?: string; // +XX -XX
  lastToolTouch?: string; // 最后通过哪个工具修改的
}

interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

interface TestStatus {
  lastRun?: number;
  total?: number;
  passed?: number;
  failed?: number;
  failingTests?: string[];
}
```

### 4.1 State 提取来源

AgentState 不是靠 LLM 总结出来的（P0 阶段），而是从多个来源**确定性地组装**：

| 字段             | 来源                                                    |
| ---------------- | ------------------------------------------------------- |
| `task.goal`      | 最新的用户意图消息 + System Prompt                      |
| `task.phase`     | Phase Detector（规则推断，见 §6.4）                     |
| `completedTasks` | 成功的工具结果 + 明确的"已完成"标记                     |
| `constraints`    | 用户消息中的约束词（"不要"、"必须"等）+ 关键决策        |
| `workspace.*`    | **Workspace Observer（git status/diff）**——ground truth |
| `errors`         | 失败的工具结果，按 errorHash 去重计数                   |
| `failedAttempts` | L3 State Collapse 时折叠写入                            |
| `decisions`      | 用户确认 + Agent 明确陈述的决策                         |

---

## 5. Context 分层模型

上下文不是一个扁平的消息列表，而是有优先级的六层结构：

```
┌─────────────────────────────────────────┐
│  Layer 0: System Prompt                 │  ← 永不删除
├─────────────────────────────────────────┤
│  Layer 1: Agent State Snapshot          │  ← 每次重建都更新，永不删除
├─────────────────────────────────────────┤
│  Layer 2: Current Phase Context         │  ← 当前阶段的相关上下文
├─────────────────────────────────────────┤
│  Layer 3: Recent Conversation           │  ← 最近 N 轮完整消息
├─────────────────────────────────────────┤
│  Layer 4: Relevant Tool Digests         │  ← 消化后的工具结果摘要
├─────────────────────────────────────────┤
│  Layer 5: Historical Memory             │  ← 按需从记忆系统检索
└─────────────────────────────────────────┘
```

**优先级原则**：`State > Phase > Recent > ToolDigests > History`

### 5.1 各层说明

| 层级                     | 内容                                                             | Token 预算        | 保留策略                        |
| ------------------------ | ---------------------------------------------------------------- | ----------------- | ------------------------------- |
| **L0 System**            | System Prompt + 工具定义 + 核心准则                              | 固定              | **永不删除**，始终在顶部        |
| **L1 State Snapshot**    | AgentState 的格式化文本表示                                      | ~500-1500 tokens  | **每次重建都更新**，始终紧跟 L0 |
| **L2 Current Phase**     | 当前阶段需要的上下文（如调试阶段的错误信息、代码上下文）         | ~1000-2000 tokens | 随阶段切换而替换                |
| **L3 Recent**            | 最近 N 轮的完整消息（user/assistant/tool_call/tool_result 配对） | ~2000-6000 tokens | 滑窗保留，N 默认 10-15          |
| **L4 Tool Digests**      | 历史工具调用的结构化摘要（非原始输出）                           | ~500-1500 tokens  | 保留有状态变化/错误/关键结果的  |
| **L5 Historical Memory** | 按需从 Session/Workspace/User Memory 检索                        | 0-2000 tokens     | 不主动放入，需要时检索注入      |

### 5.2 动态预算分配

总 Context Window 按比例动态分配给各层：

```typescript
interface LayerBudget {
  system: number; // 固定值，不参与比例分配
  stateSnapshot: number; // 通常 10-15%
  currentPhase: number; // 通常 15-20%
  recent: number; // 通常 30-40%
  toolDigests: number; // 通常 10-15%
  historicalMemory: number; // 通常 0-10%（按需）
  safetyMargin: number; // 5-10% 安全边界，防止溢出
}
```

**自适应调整**：

- Debugging 阶段：L2（错误信息）预算增加，L4 预算增加
- Research 阶段：L4（关键发现）预算增加，L5 预算增加
- Implementation 阶段：L3（最近交互）预算增加
- Token 紧张时：从 L5 → L4 → L3 → L2 顺序缩减，L0/L1 不动

---

## 6. Context Health Monitor

持续监测上下文健康状态，决定是否需要压缩/重建。

### 6.1 Token Monitor

最基础的触发器，按使用率分级响应：

```typescript
interface TokenHealth {
  used: number;
  limit: number;
  ratio: number; // used/limit
  level: 'ok' | 'attention' | 'warning' | 'critical' | 'emergency';
}

// 阈值（按 context_limit 的百分比）
const tokenThresholds = {
  attention: 0.6, // 60% → 开始监控
  warning: 0.75, // 75% → L1 Clean
  critical: 0.88, // 88% → L2 Window
  emergency: 0.96, // 96% → L3-L4 Collapse/Snapshot
  fatal: 0.99, // 99% → L5 Emergency
};
```

### 6.2 Value Density Monitor（价值密度）

不是等 token 满了才压缩，而是**主动检测低价值密度**，提前清理。

```typescript
interface ValueDensity {
  // 高价值 token / 总 token
  // 高价值 = 包含 goal/constraint/error/state_change/key_decision 标签的内容
  density: number; // 0-1，低于阈值触发压缩

  // 低密度信号
  signals: {
    duplicateToolResults: number; // 重复的工具结果数
    redundantReads: number; // 重复读同一资源且内容无变化
    emptyOrTrivialOutputs: number; // 空/无关紧要的输出
    staleErrors: number; // 已解决但未清理的错误信息
    longTemporaryOutputs: number; // 长日志/临时输出占比
  };
}
```

**触发条件**：`density < 0.4` 且总 token > 40% 限制 → 触发 L1 Clean

### 6.3 Context Entropy Monitor（上下文熵）

检测 Agent 是否处于**无效探索**状态——大量 read/search 但无任何状态变化。

这是比 APG 的 progress detection 更早期的信号：

```typescript
interface ContextEntropy {
  // 滑动窗口内（默认最近 10 轮）
  toolCallsInWindow: number;
  stateChangesInWindow: number; // 文件修改/git diff 变化
  newErrorsInWindow: number;
  uniqueResourcesTouched: number; // 不同资源数
  repeatedResourceReads: number; // 重复读取同一资源

  // 无效探索信号：
  // 工具调用多，但状态变化少，且在重复读取相同资源
  isInLowValueExploration: boolean;

  // 探索效率 = stateChanges / toolCalls
  explorationEfficiency: number; // 0-1，低于 0.1 且窗口内 toolCalls > 8 → 触发
}
```

**与 APG Progress Score 的区别**：

- Entropy Monitor 关注**上下文层面**的效率（读了很多但没记住什么）
- APG 关注**任务层面**的进展（做了很多但任务没推进）
- Entropy 是早期预警，APG 是后期确认

### 6.4 Phase Detector（阶段检测器）

推断 Agent 当前处于什么任务阶段，用于：

1. 动态调整各层预算分配
2. 阶段完成时主动压缩该阶段的上下文

```typescript
type TaskPhase =
  | 'requirement_analysis'
  | 'exploration'
  | 'planning'
  | 'implementation'
  | 'verification'
  | 'debugging'
  | 'refactoring'
  | 'documentation';

// 规则推断（P0）
function detectPhase(
  messages: Message[],
  workspace: WorkspaceState,
): TaskPhase {
  const recent = getRecentMessages(messages, 5);
  const toolPatterns = extractToolPatterns(recent);

  // 调试阶段：连续测试 + 错误
  if (toolPatterns.testFailures > 2 && toolPatterns.edits > 0)
    return 'debugging';

  // 验证阶段：主要在跑测试/命令
  if (toolPatterns.shellTests > 3 && toolPatterns.edits === 0)
    return 'verification';

  // 实现阶段：大量写操作
  if (toolPatterns.writes > 3) return 'implementation';

  // 探索阶段：大量读/搜索，写很少
  if (toolPatterns.reads > 5 && toolPatterns.writes < 2) return 'exploration';

  // 重构阶段：重命名/移动/大量编辑但测试通过
  if (toolPatterns.edits > 5 && toolPatterns.testFailures === 0)
    return 'refactoring';

  // 需求分析：刚开始，主要是用户消息
  if (messages.length < 5) return 'requirement_analysis';

  return 'unknown';
}
```

**阶段完成触发**：当阶段从 X 切换到 Y 时，触发 L2-L3 压缩，将 X 阶段的中间步骤折叠。

### 6.5 Error Storm Detector（错误风暴检测器）

连续 N 次工具调用都失败（相同或不同错误），说明当前策略可能有问题，需要清理失败历史重新思考。

```typescript
// 连续 5 次工具调用失败 → 触发 L1 Clean + 折叠失败尝试
// 同一错误连续出现 3 次 → 通知 APG，触发 L2 Window
```

### 6.6 触发器汇总

| 触发器              | 条件                         | 默认压缩级别            | 提前量           |
| ------------------- | ---------------------------- | ----------------------- | ---------------- |
| **Token Warning**   | token > 75%                  | L1 Clean                | 被动             |
| **Token Critical**  | token > 88%                  | L2 Window               | 被动             |
| **Token Emergency** | token > 96%                  | L3-L4 Collapse/Snapshot | 被动             |
| **Value Density**   | density < 0.4                | L1 Clean                | **主动**         |
| **Context Entropy** | efficiency < 0.1 + calls > 8 | L1 Clean + 提示反思     | **主动（早期）** |
| **Phase Change**    | 阶段切换                     | L2-L3 折叠上阶段        | 主动             |
| **Error Storm**     | 连续 5 次失败                | L1-L2                   | 主动             |
| **Loop Detection**  | APG 报告 stuck               | L3 Collapse             | APG 联动         |
| **User Trigger**    | 用户要求"总结/压缩"          | 用户指定                | 手动             |
| **Time Window**     | 运行超过 30 分钟             | L1 Clean                | 预防性           |

---

## 7. 五级压缩策略（Compression Pipeline）

压缩不是单一动作，而是从清理到重建的五级渐进策略。**绝不跳级**（除非 token 已到 fatal 阈值），每级压缩后重新检查健康度。

```
L1 Clean ──→ L2 Window ──→ L3 State Collapse ──→ L4 Snapshot Rewrite ──→ L5 Emergency
 无损          半无损          有损（折叠）          有损（重建）            极限
10-20%        30-50%           50-70%               70-85%                85-95%
```

### 7.1 L1 Clean（无损清理）

**目标**：不丢失任何有效信息，只移除冗余。0% 信息损失。

执行动作：

1. **精确去重**：移除 content hash 完全相同的消息
   - 重复的 tool result（如重复读同一文件且内容没变）
   - 重复的 assistant 回复
   - system 消息不去重，user 消息谨慎去重

2. **清理空/无效消息**：
   - 空 tool result
   - 纯空白消息
   - 无意义的中间输出

3. **Tool Digestor 预消化**（关键创新）：
   不是截断输出，而是将原始 tool output **消化**为结构化摘要：

```typescript
interface ToolDigest {
  tool: string;
  status: 'success' | 'failed';
  summary: string; // 一句话摘要（50-100 tokens）
  filesChanged: string[]; // 变更的文件
  errors: string[]; // 关键错误信息
  importantLines: string[]; // 包含 error/fail/pass/success/Expected/Received 等关键词的行
  outputHash: string; // 原始输出哈希（供需要时重新获取）
}
```

原始输出转换示例：

**原始**（8000 tokens pytest 输出）：

```
============================= test session starts ==============================
platform darwin -- Python 3.11.4, pytest-7.4.0
rootdir: /Users/xxx/project
collected 42 items

tests/test_auth.py ...........F..........
tests/test_utils.py ................
...
=================================== FAILURES ===================================
___________________________ TestAuth.test_token ______________________________

    def test_token():
>       assert service.validate("abc")
E       AssertionError: AuthService missing token validation

tests/test_auth.py:42: AssertionError
=========================== short test summary info ============================
FAILED tests/test_auth.py::TestAuth::test_token - AssertionError: AuthService missing token validation
========================= 1 failed, 41 passed in 2.3s =========================
```

**消化后**（~80 tokens）：

```
[Test Result] FAILED
- Passed: 41, Failed: 1
- Error: AuthService missing token validation (tests/test_auth.py:42)
- Duration: 2.3s
```

各工具的 Digest 规则：

| 工具            | Digest 重点                                                     |
| --------------- | --------------------------------------------------------------- |
| shell/test 命令 | 成功/失败 + 错误摘要 + 通过/失败数 + 耗时                       |
| read_file       | 文件路径 + 文件大小 + 关键代码结构（import/export/function 名） |
| grep/search     | 命中数 + 关键匹配行（最多 5 行）                                |
| web_fetch       | 页面标题 + URL + 关键内容摘要                                   |
| edit/write_file | 成功/失败 + 文件路径 + 变更行数                                 |

4. **空消息/无效消息清理**

### 7.2 L2 Window（锚点窗口）

**目标**：保留最近上下文 + 关键锚点，丢弃远古的中间步骤。低信息损失。

执行动作：

1. **识别锚点消息（必须保留）**：
   - 所有 L0 System 消息
   - L1 State Snapshot
   - 第一条 user 消息（原始目标）
   - 带 `goal`/`constraint`/`key_decision`/`current_error` 标签的消息
   - 最近 N 轮完整消息（N 默认 = 12）

2. **工具配对完整性保证**（核心不变式）：
   - 如果保留 tool_call，必须保留对应 tool_result
   - 如果保留 tool_result，必须保留对应 tool_call
   - 配对不完整的，要么补回要么一起删除

```typescript
function ensureToolPairing(messages: Message[]): Message[] {
  const callIdToMsg = new Map<string, Message>();
  const resultCallIdToMsg = new Map<string, Message>();

  // 建立映射
  for (const msg of messages) {
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) callIdToMsg.set(tc.id, msg);
    }
    if (msg.role === 'tool' && msg.toolCallId) {
      resultCallIdToMsg.set(msg.toolCallId, msg);
    }
  }

  const keep = new Set(messages.map((m) => m.id));

  // 检查：保留的 call 必须有 result
  for (const [callId, callMsg] of callIdToMsg) {
    if (keep.has(callMsg.id) && !resultCallIdToMsg.has(callId)) {
      keep.delete(callMsg.id); // 找不到对应 result，连调用一起删
    }
  }

  // 检查：保留的 result 必须有 call
  for (const [callId, resultMsg] of resultCallIdToMsg) {
    const callMsg = callIdToMsg.get(callId);
    if (callMsg && keep.has(resultMsg.id) && !keep.has(callMsg.id)) {
      keep.add(callMsg.id); // 补回调用
    }
  }

  return messages.filter((m) => keep.has(m.id));
}
```

3. **按原顺序返回**（永不重排消息）

### 7.3 L3 State Collapse（状态折叠）

**目标**：将连续的"尝试→失败"循环折叠为结构化的失败尝试摘要。中等信息损失。

触发场景：

- 检测到"修改→测试→失败"循环（APG errorLoop 信号）
- 同一文件被反复修改但测试仍失败
- Context Entropy 检测到无效探索

执行动作：

1. **识别折叠区间**：找到循环/无效探索的起止点
2. **提取关键信息**：
   - 尝试了哪些方法
   - 修改了哪些文件
   - 遇到了哪些错误
   - 错误是否有变化

3. **折叠为 Failed Attempts 摘要**：

   原始序列（10+ 条消息）：

   ```
   turn 8: edit_file(src/auth.ts) → 尝试添加 token 验证
   turn 9: npm test → FAILED: undefined token in validate()
   turn 10: edit_file(src/auth.ts) → 修复 undefined 问题
   turn 11: npm test → FAILED: token format invalid
   turn 12: edit_file(src/middleware.ts) → 换个地方加验证
   turn 13: npm test → FAILED: undefined token in validate()（同一错误）
   ```

   折叠后写入 AgentState.failedAttempts：

   ```
   failedAttempts: [
     { action: "添加 token 验证到 auth.ts", target: "src/auth.ts", failureReason: "undefined token", errorType: "TypeError" },
     { action: "修复 undefined", target: "src/auth.ts", failureReason: "token format invalid", errorType: "ValidationError" },
     { action: "移到 middleware 添加", target: "src/middleware.ts", failureReason: "undefined in validate()", errorType: "TypeError" },
   ]
   ```

   并在上下文中注入一条折叠总结消息：

   ```
   [状态折叠] 共进行了 3 次修复尝试，修改了 2 个文件，均未解决问题：
   - src/auth.ts: 添加token验证 → undefined token → 修复后 → format invalid
   - src/middleware.ts: 移到middleware → 仍出现 undefined in validate()
   错误模式：'undefined token' 反复出现。请考虑换一种方案。
   ```

4. **重复读取合并**：对同一文件/资源的多次读取合并为提示：
   ```
   [读取合并] 此期间读取了 src/auth.ts (3次), src/middleware.ts (2次)。
   最新内容以最近一次读取为准，如需重新查看请使用 read_file。
   ```

### 7.4 L4 Snapshot Rewrite（快照重建）

**目标**：基于 AgentState Snapshot **重建**整个上下文，而不是从原始消息裁剪。中高信息损失。

这是 ACR 区别于传统压缩器的核心——不删消息，而是**重建**一个新的、干净的上下文。

执行动作：

1. **更新 AgentState**：从所有历史中提取最新状态，State Extractor 完整运行
2. **关键信息写入 Memory**：重要的决策、发现、偏好写入对应记忆层
3. **构建全新上下文**：

```typescript
function rebuildContext(state: AgentState, recent: Message[]): Message[] {
  return [
    // L0: System Prompt（保留）
    systemPrompt,

    // L1: 全新 State Snapshot 文本
    {
      role: 'system',
      content: formatStateSnapshot(state),
    },

    // L2: 当前阶段上下文（如有）
    ...phaseContext,

    // L3: 最近 K 轮完整消息（K 默认 = 5，比 L2 的 N 小）
    ...recent.slice(-5),

    // L4: 关键 Tool Digests（非所有，只留与当前状态相关的）
    ...relevantDigests,
  ];
}
```

State Snapshot 格式化文本示例：

```
═══ Agent State Snapshot (v3) ═══

【当前目标】修复用户认证的 token 验证问题
【当前阶段】debugging
【状态】blocked

【已完成】
- 项目初始化完成
- 已添加 AuthService 基础框架
- 41 个测试通过

【已修改文件】
- src/auth.ts (modified, +32 -8)
- src/middleware.ts (modified, +15 -3)

【当前问题】
测试失败：AuthService missing token validation
位置：tests/test_auth.py:42
错误已连续出现 3 次

【已尝试方法（均未成功）】
1. 在 auth.ts 添加 token 验证 → undefined token
2. 修复 undefined 问题 → token format invalid
3. 移到 middleware 添加 → 仍然 undefined in validate()

【关键约束】
- 不能修改测试文件（critical）
- 必须兼容现有 API（high）

【下一步】
需要换一种思路实现 token 验证，避免重复之前的尝试。
═══════════════════════════════
```

### 7.5 L5 Emergency（紧急模式）

**目标**：token 即将超限，最大化压缩比，只保留最核心信息。高信息损失，但保任务不死。

只保留：

1. L0 System Prompt
2. 最精简的 State Snapshot（目标 + 当前错误 + 修改文件 + 下一步）
3. 最近 2-3 轮对话

```
═══ 紧急上下文重建 ═══
【目标】修复 token 验证
【问题】AuthService missing token validation（3次尝试未解决）
【修改】src/auth.ts, src/middleware.ts
【约束】不改测试文件
请重新思考方案，不要重复之前的失败尝试。
═══════════════════════
```

**极端兜底**：如果 L5 后仍然超限，清空一切只留 System + 一句话重述目标。

---

## 8. Workspace Observer（工作区观察者）

Coding Agent 必须感知真实工作区，而不是仅依赖 tool result 推断状态——因为 shell 命令可能有副作用，用户可能手动修改文件。

Workspace Observer 在以下时机获取 ground truth：

```typescript
// 触发时机
agent.on('after_tool_call', () => observer.scheduleCheck());
agent.on('before_model_call', () => observer.checkIfStale());
// 定时检查（默认每 30 秒一次，但有变更才更新）
setInterval(() => observer.check(), 30000);
```

### 8.1 观测内容

```typescript
interface WorkspaceState {
  // Git 状态（ground truth）
  git: {
    branch: string;
    status: 'clean' | 'dirty';
    modified: string[];
    staged: string[];
    untracked: string[];
    ahead: number;
    behind: number;
    lastCommit?: string;
    diffSummary: string; // 总 diff 统计
  };

  // 文件系统
  filesystem: {
    recentlyModified: { path: string; mtime: number }[];
    recentlyCreated: string[];
    recentlyDeleted: string[];
  };

  // 测试状态（如果最近跑过）
  tests?: {
    lastRunAt: number;
    framework?: string;
    passed: number;
    failed: number;
    failingTests: string[];
  };

  // 元数据
  lastChecked: number;
  source: 'git_status' | 'filesystem_watch' | 'tool_inference';
}
```

### 8.2 观测策略

- **不频繁跑 git 命令**：只在工具调用后调度检查，且有防抖（debounce 2s）
- **增量更新**：对比上次状态，只更新变化的部分
- **作为 ground truth**：Workspace Observer 的数据覆盖从 tool result 推断的数据
- **失败降级**：如果 git 命令不可用（非 git 项目），降级到文件系统监控 + tool 推断

---

## 9. Importance Engine（重要性引擎）

判断哪些信息值得保留/写入记忆/放入 L2-L4。

P0 用规则评分，P2+ 可引入轻量模型辅助：

```typescript
interface ImportanceScore {
  score: number; // 0-1
  factors: {
    recency: number; // 时效性
    roleWeight: number; // 角色权重
    semanticType: number; // 语义类型
    stateImpact: number; // 状态影响（是否导致工作区变化）
    errorRelevance: number; // 与当前错误的相关性
    goalRelevance: number; // 与当前目标的相关性
  };
  tags: MessageTag[];
}

// 默认权重
const weights = {
  semanticType: 0.3,
  stateImpact: 0.25,
  recency: 0.2,
  errorRelevance: 0.15,
  roleWeight: 0.05,
  goalRelevance: 0.05,
};
```

标签体系与 APG 共享：

| 标签               | 分数 | 识别方式             |
| ------------------ | ---- | -------------------- |
| `goal`             | 1.0  | 用户目标陈述         |
| `constraint`       | 0.95 | "不要"/"必须"/"注意" |
| `key_decision`     | 0.9  | 决策性陈述           |
| `current_error`    | 0.9  | 最近的错误信息       |
| `state_change`     | 0.85 | 成功修改文件/状态    |
| `success_result`   | 0.75 | 工具成功+产出        |
| `failed_attempt`   | 0.2  | 失败且错误重复       |
| `temporary_output` | 0.1  | 长日志/临时输出      |
| `duplicate`        | 0.0  | 重复内容             |

---

## 10. 三层 Memory 模型

三类记忆严格分离，各有生命周期、写入策略、检索策略。

```
┌─────────────────────────────────────────────────┐
│  Session Memory    │ 当前任务状态                 │ TTL: 任务结束
├────────────────────┼──────────────────────────────┤
│  Workspace Memory  │ 项目知识（架构/文件位置/命令）│ TTL: 项目级持久
├────────────────────┼──────────────────────────────┤
│  User Memory       │ 用户偏好/编码习惯/约束        │ TTL: 长期持久
└─────────────────────────────────────────────────┘
```

### 10.1 Session Memory（会话记忆）

- **内容**：AgentState、当前任务上下文、本轮对话的关键发现、临时状态
- **生命周期**：当前会话/任务结束即清理（或归档为 Workspace Memory）
- **写入时机**：每次压缩/重建时自动更新
- **检索**：始终全量在 L1 State Snapshot 中，无需检索

```typescript
interface SessionMemory {
  sessionId: string;
  agentState: AgentState; // 就是 AgentState Snapshot
  recentContext: Message[]; // L3 Recent
  toolDigests: ToolDigest[]; // L4 Digests
  createdAt: number;
  updatedAt: number;
}
```

### 10.2 Workspace Memory（工作区记忆）

- **内容**：项目架构知识、常用命令、文件位置、代码模式、踩过的坑
- **生命周期**：跨会话持久，与项目绑定
- **写入时机**：
  - 关键决策确定时
  - 发现项目特有模式时
  - 解决了一个有价值的 bug 时（错误模式+解决方案）
  - Session 结束时，将有长期价值的内容归档
- **检索**：需要时通过 `memory_search` 注入到 L5

```typescript
interface WorkspaceMemory {
  projectRoot: string; // 工作区路径
  architecture: {
    entryPoints: string[];
    keyDirectories: Record<string, string>; // 目录→用途说明
    frameworks: string[];
    conventions: string[];
  };
  commands: {
    test?: string;
    build?: string;
    dev?: string;
    lint?: string;
  };
  patterns: {
    pattern: string;
    description: string;
    source: string;
  }[];
  errorSolutions: {
    error: string;
    solution: string;
    files: string[];
  }[];
}
```

### 10.3 User Memory（用户记忆）

- **内容**：用户偏好、编码习惯、长期约束、沟通风格
- **生命周期**：跨项目、跨会话长期持久
- **写入时机**：用户明确表达偏好时、多次交互中学习到
- **检索**：System Prompt 构建时加载相关偏好，或按需检索

```typescript
interface UserMemory {
  userId: string;
  preferences: {
    language: string; // 沟通语言
    codingStyle?: string; // 编码风格偏好
    commentStyle?: 'minimal' | 'detailed' | 'none';
    testFramework?: string;
    packageManager?: 'npm' | 'yarn' | 'pnpm' | 'bun';
  };
  constraints: string[]; // 长期约束（"不要用 any"、"函数不能超过50行"）
  facts: { fact: string; learnedAt: number }[];
}
```

### 10.4 Memory Writer 规则

压缩前自动提取写入：

```typescript
async function extractAndWriteMemories(state: AgentState, messages: Message[]) {
  const writes: MemoryWrite[] = [];

  // 1. 用户明确要求记住的 → User Memory
  for (const msg of messages.filter((m) => m.role === 'user')) {
    if (/记住|别忘了|note that|remember/i.test(msg.content as string)) {
      writes.push({
        layer: 'user',
        content: extractFact(msg.content),
        importance: 0.9,
      });
    }
    const pref = extractPreference(msg.content);
    if (pref)
      writes.push({
        layer: 'user',
        content: pref,
        type: 'preference',
        importance: 0.85,
      });
  }

  // 2. 关键决策 → Session Memory（高价值的归档到 Workspace）
  for (const d of state.decisions) {
    writes.push({
      layer: 'session',
      content: d,
      type: 'decision',
      importance: 0.85,
    });
  }

  // 3. 解决了的错误 → Workspace Memory（错误→解决方案映射）
  for (const e of state.errors.filter((e) => e.resolved)) {
    writes.push({
      layer: 'workspace',
      type: 'error_solution',
      importance: 0.75,
    });
  }

  // 4. 项目模式发现 → Workspace Memory
  // 如"这个项目的测试都在 tests/ 目录下"、"用 pnpm 管理"等

  // 5. 文件最终状态摘要 → Session Memory（24h TTL）
  for (const f of state.workspace.modifiedFiles) {
    writes.push({
      layer: 'session',
      type: 'file_state',
      content: f,
      ttl: 86400000,
    });
  }

  await memoryWriter.write(writes);
}
```

---

## 11. Pipeline 完整流程

```typescript
async function compact(
  options: CompactOptions = {},
): Promise<CompressionResult> {
  const startTime = Date.now();

  // 1. Observe — 收集健康状态
  const health = contextMonitor.check();
  const workspace = await workspaceObserver.getState();

  // 2. Understand — 提取和理解状态
  const state = await stateExtractor.extract(messages, workspace);
  const level = options.level || decideCompressionLevel(health);

  // 3. Remember — 压缩前写入记忆
  await memoryWriter.extractAndWrite(state, messages);

  // 4. Compress — 执行压缩管线（级联各级策略）
  let compressed = [...messages];
  const strategiesRun: string[] = [];

  // 始终先跑 L1（无损清理是所有级别的基础）
  compressed = await runL1Clean(compressed);
  strategiesRun.push('l1_clean');

  if (level !== 'clean') {
    compressed = await runL2Window(compressed, state);
    strategiesRun.push('l2_window');
  }

  if (level === 'collapse' || level === 'snapshot' || level === 'emergency') {
    compressed = await runL3Collapse(compressed, state);
    strategiesRun.push('l3_collapse');
  }

  if (level === 'snapshot' || level === 'emergency') {
    compressed = await runL4Snapshot(state, compressed);
    strategiesRun.push('l4_snapshot_rewrite');
  }

  if (level === 'emergency') {
    compressed = await runL5Emergency(state, compressed);
    strategiesRun.push('l5_emergency');
  }

  // 5. 验证 — 配对完整性 + 安全检查
  compressed = ensureToolPairing(compressed);
  validateCompressedContext(compressed, state);

  // 6. Rebuild — 基于 State 重建（L4+ 已包含，这里做最终组装）
  const finalContext = await snapshotBuilder.build(state, compressed, level);

  // 7. Transition — 注入过渡消息
  const transition = createTransitionMessage(level, {
    tokensSaved: before - after,
    strategiesRun,
  });
  if (transition) finalContext.push(transition);

  // 更新 State 元数据
  state.metadata.compressionCount++;
  state.metadata.lastUpdated = Date.now();

  return {
    success: true,
    level,
    strategiesUsed: strategiesRun,
    tokensBefore: before,
    tokensAfter: after,
    tokensSaved: before - after,
    compressionRatio: 1 - after / before,
    messagesBefore: messages.length,
    messagesAfter: finalContext.length,
    durationMs: Date.now() - startTime,
    stateVersion: state.metadata.snapshotVersion,
    transitionMessage: transition?.content,
  };
}
```

---

## 12. 过渡消息与防震荡

### 12.1 分级过渡消息

压缩完成后注入系统级提示，避免模型困惑：

| 级别             | 过渡消息                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| **L1 Clean**     | `[系统] 已清理部分冗余内容（重复输出、过长日志已结构化）。不影响继续执行。`                                          |
| **L2 Window**    | `[系统] 早期的中间步骤已移出当前窗口。关键状态已保留在 Agent State 中。如需回顾早期内容，可重新调用工具或检索记忆。` |
| **L3 Collapse**  | `[系统] 连续的失败尝试已折叠并记录在 State 中。请避免重复已失败的方法，考虑换一种思路。`                             |
| **L4 Snapshot**  | `[系统] 上下文已基于当前状态重建。历史对话的核心信息已在 State Snapshot 中。请基于当前状态继续推进。`                |
| **L5 Emergency** | `[系统·紧急] 上下文已极限压缩以保证继续运行。请仔细查看 State Snapshot 中的当前状态和已尝试方法，换方案继续。`       |

### 12.2 防震荡机制

1. **冷却期**：压缩后 N 轮内不再触发同级别压缩（默认 5 轮）
2. **不跳级原则**：L1 → L2 → L3 → L4 → L5 逐级递进，除非 token 达 fatal 阈值
3. **压缩次数预算**：单次会话最多压缩 15 次，超过后只做 L1 无损清理
4. **滞后区间**：压缩后 token 必须降到下一级阈值再低 10%（hysteresis）才停止升级
5. **压缩后验证**：压缩后重新计算 token，如果仍然超限则升级一级

```typescript
const cooldownConfig = {
  minTurnsBetweenSameLevel: 5,
  maxCompressionsPerSession: 15,
  allowLevelJump: false,
  hysteresisRatio: 0.1,
  postCompressionCheck: true,
};
```

---

## 13. 可观测性

### 13.1 Metrics

| 指标名                            | 类型      | 标签                     | 说明                       |
| --------------------------------- | --------- | ------------------------ | -------------------------- |
| `acr_compression_total`           | Counter   | level, trigger, strategy | 压缩次数总计               |
| `acr_tokens_before`               | Histogram | level                    | 压缩前 token 数            |
| `acr_tokens_after`                | Histogram | level                    | 压缩后 token 数            |
| `acr_tokens_saved_total`          | Counter   | level                    | 累计节省 token             |
| `acr_compression_ratio`           | Histogram | level                    | 压缩比分布                 |
| `acr_compression_duration_ms`     | Histogram | level                    | 压缩耗时                   |
| `acr_state_snapshot_version`      | Gauge     | -                        | 当前 State 版本号          |
| `acr_value_density`               | Gauge     | -                        | 当前上下文价值密度         |
| `acr_context_entropy`             | Gauge     | -                        | 当前上下文熵值（探索效率） |
| `acr_health_level`                | Gauge     | -                        | 健康等级 (0-4)             |
| `acr_memory_writes_total`         | Counter   | layer, type              | 写入记忆条目数             |
| `acr_tool_digests_created_total`  | Counter   | tool                     | Tool Digest 创建数         |
| `acr_workspace_checks_total`      | Counter   | source                   | Workspace 检查次数         |
| `acr_compression_cooldown_active` | Gauge     | -                        | 冷却期状态 (0/1)           |
| `acr_pairing_fixes_total`         | Counter   | -                        | 工具配对修复次数           |

### 13.2 结构化日志

每次压缩输出：

```json
{
  "msg": "Context compacted",
  "level": "info",
  "compressionId": "acr_xyz789",
  "sessionId": "sess_abc",
  "level": "collapse",
  "trigger": "progress_stuck",
  "strategiesUsed": ["l1_clean", "l2_window", "l3_collapse"],
  "tokensBefore": 112000,
  "tokensAfter": 38000,
  "tokensSaved": 74000,
  "compressionRatio": 0.66,
  "messagesBefore": 95,
  "messagesAfter": 28,
  "stateVersion": 4,
  "failedAttemptsFolded": 5,
  "toolDigestsCreated": 8,
  "memoryWrites": { "session": 4, "workspace": 1, "user": 0 },
  "workspaceState": { "modifiedFiles": 2, "testFailures": 1 },
  "durationMs": 35,
  "cooldownUntil": 1234567890
}
```

### 13.3 Debug 模式

每轮输出健康状况和压缩决策详情：

```
[ACR] Turn 38
  Health: critical (tokens: 108k/128k = 84%, density: 0.32, entropy: 0.08)
  Phase: debugging
  Should compact: yes (level: l2_window → l3_collapse, trigger: token_critical + entropy_low)
  Cooldown: ok (last compression was 9 turns ago)
  State: modifiedFiles=2, errors=1, failedAttempts=3
  Running: l1_clean → l2_window → l3_collapse
[ACR] Compaction complete (acr_xyz789)
  Tokens: 108k → 35k (saved 73k, ratio: 68%)
  Messages: 95 → 24
  State updated: v3 → v4
  Failed attempts folded: 3
  Tool digests: 7 new
  Memories written: session=3, workspace=1
  Duration: 28ms
  Cooldown: 7 turns
```

---

## 14. 场景化 Profile

### 14.1 Coding Profile（默认）

```yaml
coding:
  monitors:
    token: { warning: 0.75, critical: 0.88, emergency: 0.96 }
    valueDensity: { threshold: 0.35 }
    entropy: { threshold: 0.10, minCalls: 6 }
    errorStorm: { consecutiveFails: 5 }
    phase: { enabled: true }
    workspaceObserver: { enabled: true, debounceMs: 2000 }

  layerBudget:
    stateSnapshot: 0.15
    currentPhase: 0.20
    recent: 0.30
    toolDigests: 0.20
    historicalMemory: 0.05
    safetyMargin: 0.10

  compression:
    recentKeep: { l2: 12, l3: 8, l4: 5, l5: 2 }
    digestRules:
      shell:
        {
          maxTokens: 2000,
          preservePatterns: [error, fail, pass, FAILED, Passed, Expected],
        }
      read_file: { maxTokens: 3000, preserveStructure: true }
      edit_file: { digestStyle: 'brief' }

  memory:
    autoExtractWorkspace: true # 积极提取项目知识
    errorSolutionsToWorkspace: true # 解决的 bug 存入工作区记忆
    sessionMemoryTTL: 86400000
```

### 14.2 Research Profile

```yaml
research:
  monitors:
    token: { warning: 0.70, critical: 0.85, emergency: 0.95 }
    valueDensity: { threshold: 0.45 } # 调研对信息密度要求更高
    entropy: { threshold: 0.15, minCalls: 10 } # 允许更多探索
    workspaceObserver: { enabled: false } # 非文件场景关闭

  layerBudget:
    stateSnapshot: 0.10
    currentPhase: 0.15
    recent: 0.25
    toolDigests: 0.25 # 调研中工具结果摘要更重要
    historicalMemory: 0.15 # 更多从记忆检索
    safetyMargin: 0.10

  compression:
    # 调研中不折叠失败尝试——"什么没找到"也是信息
    foldFailedAttempts: false
    # 保留更多来源信息
    preserveSources: true
    # Digest 更详细
    digestRules:
      web_fetch: { maxTokens: 4000, preserveKeyPoints: true }
      web_search: { keepResults: 10 }

  agentState:
    trackKeyFindings: true # 启用 keyFindings 字段
```

### 14.3 Assistant / 对话 Profile

```yaml
assistant:
  monitors:
    token: { warning: 0.70, critical: 0.85, emergency: 0.95 }
    valueDensity: { threshold: 0.40 }
    entropy: { enabled: false } # 对话场景熵检测意义不大
    workspaceObserver: { enabled: false }

  layerBudget:
    stateSnapshot: 0.10
    currentPhase: 0.10
    recent: 0.50 # 对话保留更多近期消息
    toolDigests: 0.10
    historicalMemory: 0.10
    safetyMargin: 0.10

  compression:
    recentKeep: { l2: 20, l3: 12, l4: 6, l5: 3 }
    foldFailedAttempts: false
    preserveTone: true # 保持对话语气连贯性

  memory:
    autoExtractUser: true # 积极提取用户偏好
    autoExtractPreferences: true
```

---

## 15. 完整配置（YAML）

```yaml
acr:
  enabled: true
  profile: coding # coding / research / assistant / custom
  integrate_with_progress_guard: true

  # Context Health Monitor
  monitors:
    token:
      enabled: true
      attention: 0.60
      warning: 0.75
      critical: 0.88
      emergency: 0.96
      fatal: 0.99

    valueDensity:
      enabled: true
      threshold: 0.40
      minTokensToCheck: 0.40 # token 超 40% 才开始检查密度

    contextEntropy:
      enabled: true
      windowSize: 10
      efficiencyThreshold: 0.10
      minToolCalls: 8

    phaseDetector:
      enabled: true
      compactOnPhaseChange: true
      phaseChangeLevel: l2

    errorStorm:
      enabled: true
      consecutiveFailures: 5
      sameErrorThreshold: 3
      level: l2

    timeWindow:
      enabled: true
      intervalMinutes: 30
      level: l1

    workspaceObserver:
      enabled: true
      debounceMs: 2000
      checkIntervalMs: 30000
      useGit: true
      useFsWatch: false # P2+ 可用 fs.watch
      fallbackToToolInference: true

  # Compression Pipeline
  compression:
    # 冷却与防震荡
    cooldown:
      minTurnsBetweenSameLevel: 5
      maxCompressionsPerSession: 15
      allowLevelJump: false
      hysteresisRatio: 0.10
      postCompressionCheck: true

    # 各级策略开关
    strategies:
      l1_clean:
        deduplicate: true
        deduplicate_tool_results: true
        deduplicate_assistant_messages: true
        deduplicate_user_messages: false
        remove_empty: true
        digest_tool_outputs: true

      l2_window:
        recent_messages_to_keep: 12
        anchor_roles: [system]
        anchor_tags: [goal, constraint, key_decision, current_error]
        ensure_tool_pairing: true

      l3_collapse:
        fold_failed_attempts: true
        min_attempts_to_fold: 3
        max_attempts_in_summary: 10
        merge_repeated_reads: true
        min_reads_to_merge: 3
        use_llm_summary: false # P1+

      l4_snapshot_rewrite:
        recent_keep: 5
        rebuild_state_snapshot: true
        write_memories_before: true

      l5_emergency:
        recent_keep: 2
        minimal_state_only: true

    # Tool Digest 规则
    toolDigest:
      max_tokens_per_digest: 500
      default_rules:
        - preservePatterns:
            [
              error,
              Error,
              fail,
              FAIL,
              success,
              pass,
              Pass,
              Expected,
              Received,
              ✓,
              ✗,
            ]
        - headLines: 5
        - tailLines: 10

    # 过渡消息
    transitionMessages:
      enabled: true
      l1: '[系统] 已清理冗余内容（重复输出/过长日志已结构化），不影响继续。'
      l2: '[系统] 早期中间步骤已移出窗口，关键状态保留在 Agent State 中。可重新调用工具查看细节。'
      l3: '[系统] 连续失败尝试已折叠记录。请避免重复已失败的方法，换思路尝试。'
      l4: '[系统] 上下文已基于当前状态重建。核心信息在 State Snapshot 中，请基于当前状态继续。'
      l5: '[系统·紧急] 上下文已极限压缩。请查看 State Snapshot，换方案继续。'

  # Memory
  memory:
    session:
      enabled: true
      autoUpdate: true
    workspace:
      enabled: true
      autoExtractArchitecture: true
      autoExtractCommands: true
      errorSolutions: true
      projectRootBound: true
    user:
      enabled: true
      autoExtractPreferences: true
      autoExtractFacts: true
      minImportanceToWrite: 0.7

  # Importance Engine
  importance:
    weights:
      semanticType: 0.30
      stateImpact: 0.25
      recency: 0.20
      errorRelevance: 0.15
      roleWeight: 0.05
      goalRelevance: 0.05
    tagWeights:
      goal: 1.0
      constraint: 0.95
      key_decision: 0.9
      current_error: 0.9
      state_change: 0.85
      success_result: 0.75
      failed_attempt: 0.2
      temporary_output: 0.1
      duplicate: 0.0

  # 可观测性
  observability:
    debug: false
    logCompressions: true
    logHealthChecks: false
    emitMetrics: true
    keepCompressionHistory: 20
    keepStateHistory: 5 # 保留最近 5 个 State 版本用于回溯

  # Profile 覆盖
  profiles:
    coding:
      # ...见 §14.1
    research:
      # ...见 §14.2
    assistant:
      # ...见 §14.3
```

---

## 16. 验证与测试

### 16.1 不变式（压缩后必须永远满足）

```
【配对完整性不变式】
对于压缩后的任意消息 m：
  如果 m 包含 toolCalls，每个 toolCall 都有对应的 tool_result 消息存在
  如果 m.role === 'tool'，则对应的 tool_call 消息存在

【锚点保留不变式】
  L0 System Prompt 永远存在且在最前面
  L1 State Snapshot 永远存在且紧跟 L0
  标记为 goal/constraint (critical) 的消息永远保留（或在 State 中体现）

【消息序不变式】
  保留的消息相对顺序与压缩前一致，永远不重排

【State 完整性不变式】
  AgentState 中 task.goal 非空
  AgentState.workspace 反映 Workspace Observer 的最新 ground truth

【Token 安全不变式】
  压缩后总 tokens < context_limit * (1 - safetyMargin)
  如果 L5 后仍超限，返回失败而不是继续发送超限上下文
```

### 16.2 核心测试用例

| 测试场景                                     | 预期结果                                 |
| -------------------------------------------- | ---------------------------------------- |
| Token 达 75% → L1 Clean                      | 去重 + Tool Digests，压缩比 10-20%，无损 |
| Token 达 88% → L2 Window                     | 锚点保留，最近消息保留，工具配对完整     |
| 连续 5 次测试失败 → L3 Collapse              | 失败尝试折叠到 AgentState.failedAttempts |
| APG 报告 stuck → L3/L4                       | 状态折叠或快照重建，APG 窗口重置         |
| 压缩后 tool_call 孤立                        | 自动修复：要么补回 result，要么删除 call |
| 第一条 user 消息（原始目标）                 | 永远保留或在 State 中重述                |
| Workspace Observer 检测到外部修改            | AgentState.workspace 更新为 ground truth |
| 压缩后立刻再检查                             | 冷却期内不重复压缩                       |
| L5 后仍然超 token                            | 降级到极简兜底，返回成功不崩溃           |
| 用户明确要求"记住 X"                         | X 写入对应 Memory 层                     |
| git status 显示的文件修改 vs tool 推断不一致 | 以 git 为准（ground truth）              |
| 阶段从 exploration → implementation          | L2 折叠探索阶段的读/搜索历史             |

---

## 17. 风险与缓解

| 风险                                       | 影响                                          | 缓解措施                                                                                |
| ------------------------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| **State 提取错误/不完整**                  | Agent 基于错误状态做决策                      | 多源验证（tool result + git + fs）；保守策略（不确定的不更新）；State 版本化可回退      |
| **L4 Snapshot 信息丢失**                   | 重建后 Agent 忘记重要上下文                   | 渐进式（不跳级）；记忆备份；过渡消息明确提示；用户可见压缩事件                          |
| **Tool Digest 丢失关键信息**               | 错误/警告被错误省略                           | Digest 规则保守（多保留）；关键模式行强制保留；原始输出有 hash 可追溯                   |
| **Workspace Observer 开销**                | git status 频繁执行影响性能                   | 防抖 + 增量检查 + 工具调用后才调度；失败降级到 tool 推断                                |
| **压缩震荡**                               | 反复压缩浪费性能                              | 冷却期 + 次数限制 + 滞后区间 + 不跳级                                                   |
| **记忆膨胀**                               | Memory 越来越多、检索变慢                     | 分层 TTL；Workspace 记忆按项目绑定；User 记忆重要性阈值；定期清理低价值条目             |
| **误折叠正在进行的有效尝试**               | Agent 正在推进的工作被误判为失败循环折叠      | 折叠前检查 stateChange；只在 APG 确认或明确循环模式下折叠；折叠后仍保留最近 N 轮        |
| **额外 LLM 成本**                          | 总结/摘要消耗 token                           | P0-P1 全规则无 LLM；P2+ 用小模型做摘要且限制长度；仅 L4+ 可能用到                       |
| **非 coding 场景 Workspace Observer 无效** | Research/Assistant 场景 git/fs 无意义         | 按 Profile 关闭；Observer 失败自动降级；非文件项目自动检测并关闭                        |
| **压缩后模型困惑**                         | 模型不知道发生了压缩、不知道有 State Snapshot | 分级过渡消息；State Snapshot 有清晰视觉分隔；System Prompt 中说明 State Snapshot 的存在 |

---

## 18. 工程目录结构

```
src/context-runtime/
├── index.ts                      # 主入口 AgentContextRuntime 类
├── types.ts                      # 所有类型定义
├── runtime.ts                    # Runtime 编排器（compact 主流程）
├── context-manager.ts            # Context Window 管理
│
├── monitor/                      # Context Health Monitor
│   ├── base.ts                   # Monitor 基类
│   ├── token-monitor.ts
│   ├── density-monitor.ts        # Value Density
│   ├── entropy-monitor.ts        # Context Entropy
│   ├── phase-detector.ts
│   ├── error-storm-monitor.ts
│   └── index.ts
│
├── state/                        # Agent State
│   ├── agent-state.ts            # AgentState 定义/格式化
│   ├── workspace-state.ts        # WorkspaceState
│   ├── state-extractor.ts        # 从消息+工作区提取 State
│   ├── snapshot-builder.ts       # Rebuild: 基于 State 构建新上下文
│   └── phase-context.ts          # L2 Current Phase 内容构建
│
├── compress/                     # Compression Pipeline
│   ├── pipeline.ts               # 管线编排
│   ├── l1-clean.ts               # 去重 + Digest 预处理
│   ├── l2-window.ts              # 锚点窗口
│   ├── l3-collapse.ts            # 失败尝试折叠
│   ├── l4-snapshot.ts            # Snapshot Rewrite
│   ├── l5-emergency.ts           # Emergency
│   ├── pairing.ts                # 工具配对完整性保证
│   └── transition.ts             # 过渡消息注入
│
├── tool/                         # Tool Digest
│   ├── digestor.ts               # Tool Digest 引擎
│   ├── rules/                    # 各工具的 Digest 规则
│   │   ├── shell.ts
│   │   ├── file-tools.ts
│   │   ├── search-tools.ts
│   │   └── web-tools.ts
│   └── index.ts
│
├── observer/                     # Workspace Observer
│   ├── workspace-observer.ts
│   ├── git-observer.ts
│   ├── fs-observer.ts             # P2
│   └── index.ts
│
├── importance/                   # Importance Engine
│   ├── scorer.ts
│   ├── tagger.ts                 # 语义标签
│   └── weights.ts
│
├── memory/                       # 三层 Memory
│   ├── memory-writer.ts
│   ├── session-memory.ts
│   ├── workspace-memory.ts
│   ├── user-memory.ts
│   └── memory-integration.ts
│
├── observability/
│   ├── metrics.ts
│   ├── structured-logger.ts
│   └── debug-logger.ts
│
└── config/
    ├── schema.ts                 # 配置 schema (zod)
    ├── defaults.ts               # 默认配置
    └── profiles.ts               # 内置 Profile
```

---

## 19. 实现路线图

| 阶段        | 内容                                                                                                                                                                                          | 代码量  | 依赖                                     | 价值                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| **P0 核心** | AgentState 模型 + Token/ValueDensity Monitor + L1 Clean（去重+Tool Digest）+ L2 Window（锚点+配对保证）+ Workspace Observer(git) + Session Memory + Hook 集成 + 基础 Metrics + 单元测试       | ~600 行 | 无额外依赖（git 命令子进程）             | 解决 80% token 超限问题；AgentState 骨架建立；Workspace 有 ground truth |
| **P1 增强** | Context Entropy + Phase Detector + Error Storm + L3 State Collapse（失败尝试折叠+重复读取合并）+ 三层 Memory 完整实现 + Importance Engine + 冷却防震荡 + 过渡消息 + APG 联动 + 完整日志/Debug | ~600 行 | 现有 memory 模块                         | 主动预防（Value Density+Entropy）；失败折叠；与 APG 闭环；记忆系统工作  |
| **P2 进阶** | L4 Snapshot Rewrite + 分层 Context 模型 + 动态预算分配 + 语义标签优化 + 各场景 Profile 完整调优 + 压缩历史审计 + State 版本回退 + Tool Digest 规则完善                                        | ~600 行 | 可选 LLM（复用现有 AI 模块，做高级摘要） | 真正"重建"而非"裁剪"；长会话支持；多场景适配                            |
| **P3 高级** | L5 Emergency 兜底 + 自适应阈值（根据模型/任务动态调参）+ 压缩质量评估（重建后验证任务可继续）+ Workspace Memory 自动架构提取 + fs.watch 实时监控 + Dashboard/可视化                           | ~500 行 | 可选 embedding 做语义检索                | 生产级完备；智能自适应；平台级能力                                      |

### P0 交付物（第一个可用版本）

1. `AgentState` 核心类型定义
2. Token Monitor + Value Density Monitor
3. L1 Clean：精确去重 + Tool Digest（shell/read_file 基础规则）
4. L2 Window：锚点识别 + 工具配对完整性保证
5. Workspace Observer：`git status` + `git diff --stat` 防抖
6. Session Memory 基础实现（AgentState 持久化）
7. Hook 集成（`before_model_call`/`after_tool_call`）
8. 基础 Metrics + 结构化日志
9. 单元测试（覆盖不变式验证）

P0 完成后，**Agent 已经不会因为 token 超限而崩溃**，且上下文里不会再有大量重复的冗余内容。

---

## 20. 核心设计原则

1. **状态优先，不裁剪消息**：以 AgentState 为核心，重建上下文比裁剪消息更可靠
2. **Ground truth 从工作区来**：git/filesystem 是文件状态的最终权威，不依赖 tool result 推断
3. **主动预防优于被动响应**：Value Density + Entropy 在 token 满之前就清理
4. **渐进式，不跳级**：五级递进，给 Agent 适应机会
5. **Tool 输出不截断，要消化**：Digest 成结构化摘要比保留头尾有价值
6. **三类记忆不混合**：Session/Workspace/User 分层管理，各有生命周期
7. **结构永远大于内容**：可以丢内容，但工具配对、消息顺序、State 完整性不能破
8. **删除前先记住**：有价值的信息写入记忆再从上下文移除
9. **压缩后打个招呼**：过渡消息让模型知道状态已更新
10. **P0 不用 LLM**：所有核心策略用规则实现，零额外成本
11. **与 APG 共生**：ACR 管上下文，APG 管进展，两者联动形成控制平面
12. **可观测不黑盒**：每次操作都有 Metrics、日志、审计，State 版本化可回退

---

## 21. 最终定位

Agent Context Runtime (ACR) 不是 Context Compressor，而是 **Agent Context Operating System**。

它管理 Agent 从认知到记忆的完整上下文生命周期：

```
    Observe  —— 持续监控上下文健康度和工作区真实状态
      ↓
    Understand —— 提取 AgentState，理解当前阶段和重要信息
      ↓
    Compress  —— 级联执行五级压缩策略，消化工具输出
      ↓
    Remember  —— 关键信息写入三层记忆，不丢失长期价值
      ↓
    Rebuild   —— 基于 AgentState 重建高信息密度的上下文
      ↓
    Continue  —— 注入过渡消息，Agent 继续运行，全程可观测
```

最终目标：

> 让 Agent 的上下文永远保持高信息密度——既不超限，也不丢失关键状态，让 Agent 始终清楚"我在哪、要去哪、试过什么、什么有效"，能够连续运行数小时甚至数天而不因为上下文问题退化或崩溃。

**ACR 与 APG 并列，作为 kobot Runtime 控制平面的双支柱：APG 确保 Agent 在推进任务，ACR 确保 Agent 始终有清晰的认知状态。**
