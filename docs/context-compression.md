# Context Compression Strategy (CCS) v1.0 生产级方案

## 1. 背景与问题

在长时间运行的 Agent 会话中，上下文窗口（Context Window）会随着对话轮次增加而持续增长：

```
System Prompt → User Messages → Assistant Messages → Tool Calls → Tool Results → ... → Token Limit Exceeded
```

**核心痛点**：

| 问题           | 影响                                               |
| -------------- | -------------------------------------------------- |
| **Token 超限** | 直接导致 API 调用失败，任务中断                    |
| **注意力稀释** | 关键信息被大量冗余历史淹没，模型推理质量下降       |
| **成本飙升**   | 每轮重复发送全部历史，token 成本线性增长           |
| **响应延迟**   | 上下文越长，推理时间越长                           |
| **上下文污染** | 错误的尝试、过时的信息残留在上下文中，误导后续决策 |

### 1.1 传统方案的局限

| 方案               | 问题                                                     |
| ------------------ | -------------------------------------------------------- |
| **固定滑动窗口**   | 粗暴截断，可能丢失关键信息（如早期的用户需求、重要约束） |
| **简单截断旧消息** | 工具调用与结果可能被截断导致配对断裂，模型困惑           |
| **每次都总结**     | 总结本身消耗 token，且多轮总结后信息失真累积             |
| **仅靠 KV 缓存**   | 只解决速度问题，不解决 token 限制和注意力稀释问题        |

### 1.2 核心设计原则

> **上下文压缩不是"删东西"，而是"信息蒸馏"——在最小信息损失的前提下，最大化上下文价值密度。**

CCS 的设计遵循以下原则：

1. **渐进式压缩**：从温和到激进，多级策略，避免一步到位丢失关键信息
2. **场景感知**：不同任务类型（coding/research/assistant）使用不同策略
3. **结构保留**：工具调用-结果配对、消息时序关系等结构不被破坏
4. **可观测可回溯**：每次压缩都有记录，可调试可恢复
5. **零额外 LLM 调用优先**：优先用规则/哈希/统计方法，减少额外成本
6. **记忆协同**：重要信息写入持久化记忆，不依赖上下文存活
7. **与 APG 联动**：配合 Progress Guard 在检测到停滞/循环时主动压缩

---

## 2. 设计目标

| 目标         | 具体要求                                           |
| ------------ | -------------------------------------------------- |
| **多级策略** | 提供 5+ 种压缩算法，按成本/激进程度分级            |
| **多触发器** | 支持 token 阈值、停滞检测、用户触发、循环触发等    |
| **无损优先** | 优先无损压缩，再考虑有损；有损压缩必须保留关键信息 |
| **结构完整** | 工具调用与结果始终配对，消息边界清晰               |
| **低开销**   | P0 策略不额外调用 LLM，单轮压缩 < 50ms             |
| **可配置**   | 每个场景可独立配置策略组合、阈值、参数             |
| **可观测**   | Metrics + 压缩日志 + 前后对比快照                  |
| **记忆联动** | 自动识别重要信息写入长期记忆                       |
| **平滑过渡** | 压缩后注入上下文过渡说明，避免模型困惑             |

---

## 3. 总体架构

```
                         Agent Runtime
                                   │
                          ┌────────┴────────┐
                          │  Context Window │
                          └────────┬────────┘
                                   │
                       ┌───────────┴───────────┐
                       │   Context Compressor  │
                       │     (Control Plane)   │
                       │                       │
  ┌──────────────┐     │  ┌───────────────┐    │
  │  Trigger     │───────→│  Compression  │    │
  │  Detector    │     │  │  Orchestrator │    │
  └──────────────┘     │  └───────┬───────┘    │
                       │          │            │
  ┌──────────────┐     │  ┌───────▼───────┐    │     ┌──────────────┐
  │  Importance  │     │  │  Strategy     │───────→  │  Context     │
  │  Scorer      │───────→│  Pipeline     │    │     │  Transformer │
  └──────────────┘     │  └───────┬───────┘    │     └──────────────┘
                       │          │            │
  ┌──────────────┐     │  ┌───────▼───────┐    │     ┌──────────────┐
  │  Memory      │     │  │  Validator &  │───────→  │  Persistent  │
  │  Integrator  │←───────│  Post-Process │    │     │  Memory      │
  └──────────────┘     │  └───────────────┘    │     └──────────────┘
                       └───────────────────────┘
                                   │
                          ┌────────┴────────┐
                          │ Compressed Context │
                          └─────────────────┘
```

### 3.1 七层组件职责

| 层级       | 组件                     | 职责                                         |
| ---------- | ------------------------ | -------------------------------------------- |
| **触发层** | Trigger Detector         | 检测是否需要压缩（token阈值/停滞/循环/手动） |
| **评估层** | Importance Scorer        | 对每条消息/内容块计算重要性分数              |
| **编排层** | Compression Orchestrator | 选择策略组合，控制压缩强度，管理压缩历史     |
| **执行层** | Strategy Pipeline        | 具体的压缩算法执行（多种策略可级联）         |
| **验证层** | Validator                | 检查压缩后上下文完整性、配对性、最小信息保留 |
| **后处理** | Post-Process             | 注入过渡消息，更新元数据，记录审计日志       |
| **记忆层** | Memory Integrator        | 将关键信息写入持久化记忆系统                 |

### 3.2 集成方式

与 APG (Progress Guard) 相同，**P0 通过 Hook 零侵入接入**：

```typescript
// 使用方式
const agent = new Agent({...});

const compressor = new ContextCompressor({
  enabled: true,
  profile: 'coding',
  strategies: [...],
  triggers: {...},
  thresholds: {...},
});

// 挂载
compressor.attach(agent);

// 与 Progress Guard 联动
progressGuard.on('stuck', () => compressor.compress({ level: 'aggressive' }));
progressGuard.on('suspicious', () => compressor.compress({ level: 'light' }));
```

---

## 4. 核心数据模型

### 4.1 Context Window 结构

```typescript
interface ContextWindow {
  messages: Message[];
  systemPrompt: string;
  metadata: ContextMetadata;
  tokenCount: number;
  hash: string;
}

interface Message {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  timestamp: number;
  turnIndex: number;

  // 工具相关
  toolCallId?: string; // 工具调用ID，用于配对
  toolCalls?: ToolCall[]; // assistant 发起的工具调用
  toolName?: string; // tool 消息对应的工具名

  // 压缩元数据
  importanceScore?: number; // 0-1 重要性分数
  compressionFlags?: CompressionFlag[]; // 压缩标记
  isSummary?: boolean; // 是否是总结消息
  originalMessageIds?: string[]; // 如果是总结，原始消息ID

  // 语义标记
  tags?: MessageTag[]; // 语义标签（goal/constraint/error/result/...）
}

interface ContextMetadata {
  sessionId: string;
  createdAt: number;
  lastCompressedAt?: number;
  compressionCount: number;
  totalTokensBeforeCompression: number;
  tokensSaved: number;
}
```

### 4.2 重要性评分模型

```typescript
interface ImportanceScore {
  score: number; // 0-1 综合得分
  factors: {
    recency: number; // 时效性：越新越重要
    roleWeight: number; // 角色权重：user > assistant > tool
    semanticType: number; // 语义类型：goal/constraint/error 权重高
    referenceCount: number; // 被引用次数：被后续消息引用则重要
    stateChange: number; // 状态变化：导致文件修改/状态变更的工具结果重要
    userIntent: number; // 用户意图匹配度
    toolSuccess: number; // 工具成功结果 vs 失败结果
  };
  tags: MessageTag[];
}

type MessageTag =
  | 'goal' // 用户目标/需求
  | 'constraint' // 约束条件
  | 'key_decision' // 关键决策
  | 'error' // 错误信息
  | 'success_result' // 成功的结果
  | 'file_modification' // 文件修改
  | 'intermediate_step' // 中间步骤
  | 'redundant' // 冗余信息
  | 'failed_attempt' // 失败尝试
  | 'duplicate' // 重复内容
  | 'temporary_output' // 临时输出（如长列表、日志）
  | 'reflection' // 反思/总结
  | 'memory_worthy'; // 值得存入记忆
```

### 4.3 压缩结果

```typescript
interface CompressionResult {
  success: boolean;
  level: CompressionLevel;
  strategiesUsed: string[];

  // Token 统计
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  compressionRatio: number; // 0-1，越大压缩越狠

  // 消息统计
  messagesBefore: number;
  messagesAfter: number;
  messagesRemoved: number;
  messagesSummarized: number;

  // 保留的关键信息
  preservedMessageIds: string[];
  memoryWrites: MemoryWrite[];

  // 审计
  compressionId: string;
  timestamp: number;
  durationMs: number;
  strategyBreakdown: StrategyResult[];

  // 注入的过渡消息
  transitionMessage?: string;
}

type CompressionLevel =
  | 'none'
  | 'light'
  | 'moderate'
  | 'aggressive'
  | 'extreme';
```

---

## 5. 压缩策略库

### 5.1 策略分级总览

| 级别   | 策略            | 类型   | 额外 LLM     | 压缩比 | 信息损失 | 适用场景                      |
| ------ | --------------- | ------ | ------------ | ------ | -------- | ----------------------------- |
| **L0** | 无压缩          | -      | -            | 0%     | 0%       | 正常运行                      |
| **L1** | 去重 + 清理     | 无损   | 否           | 10-20% | 0%       | Token 接近阈值，预防性压缩    |
| **L2** | 滑窗 + 关键锚点 | 半无损 | 否           | 30-50% | 低       | Token 达到 70% 阈值           |
| **L3** | 中间步骤总结    | 有损   | 是（小模型） | 50-70% | 中       | Token 达到 85% / 检测到停滞   |
| **L4** | 语义聚类 + 摘要 | 有损   | 是           | 70-85% | 中高     | Token 达到 95% / 循环检测触发 |
| **L5** | 激进重写        | 有损   | 是           | 85-95% | 高       | Token 超限迫近 / 即将失败     |

### 5.2 L1: 无损清理策略

**目标**：不丢失任何有效信息，只移除冗余。

#### 5.2.1 精确去重

```typescript
// 检测完全相同的消息（content hash 相同）
function deduplicate(messages: Message[]): Message[] {
  const seen = new Set<string>();
  return messages.filter((msg) => {
    // system 消息不去重
    if (msg.role === 'system') return true;

    const hash = hashMessage(msg);
    if (seen.has(hash)) {
      return false; // 重复，移除
    }
    seen.add(hash);
    return true;
  });
}
```

**去重范围**：

- 完全相同的 tool result（如重复读同一个文件且内容没变）
- 完全相同的 assistant 回复（罕见，但循环时可能出现）
- system 消息不去重，user 消息谨慎去重

#### 5.2.2 工具结果截断

**场景**：Shell 输出、长列表、大文件内容、堆栈跟踪过长。

```typescript
function truncateToolOutput(
  msg: Message,
  options: { maxLength: number },
): Message {
  if (msg.role !== 'tool') return msg;

  const content =
    typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  if (content.length <= options.maxLength) return msg;

  // 保留头部和尾部，中间截断
  const head = content.slice(0, options.maxLength * 0.6);
  const tail = content.slice(-options.maxLength * 0.4);
  const truncated = `${head}\n\n... [${content.length - options.maxLength} 字符已截断] ...\n\n${tail}`;

  // 标记
  return {
    ...msg,
    content: truncated,
    compressionFlags: [...(msg.compressionFlags || []), 'truncated_output'],
  };
}
```

**默认截断阈值**：

- 单个 tool result > 4000 tokens → 截断
- Shell 输出保留前 60% 后 40%（头部通常有命令，尾部通常有结果摘要/错误）
- 大文件内容提示"文件过长，已截断，请按需读取特定部分"

#### 5.2.3 空消息/无效消息清理

移除：

- 空的 tool result
- 只有空白字符的消息
- 重复的 system 消息
- 纯思考过程标记（如 `<thinking>` 标签内的中间内容，如有）

---

### 5.3 L2: 滑窗 + 关键锚点策略

**目标**：保留最近的上下文，同时确保早期的关键信息不丢失。

#### 5.3.1 带锚点的滑动窗口

```typescript
interface AnchoredWindowOptions {
  recentWindowSize: number; // 最近保留的消息数，默认 20
  maxTokens: number; // 目标 token 数
  anchorRoles: string[]; // 必须保留的角色，默认 ['system']
  anchorTags: MessageTag[]; // 必须保留的标签
}

function anchoredWindow(
  messages: Message[],
  options: AnchoredWindowOptions,
): Message[] {
  // 1. 识别锚点消息（必须保留）
  const anchors = new Set<string>();

  // - 所有 system 消息
  messages.filter((m) => m.role === 'system').forEach((m) => anchors.add(m.id));

  // - 带关键标签的消息
  messages
    .filter((m) =>
      m.tags?.some((t) => ['goal', 'constraint', 'key_decision'].includes(t)),
    )
    .forEach((m) => anchors.add(m.id));

  // - 用户最初的目标消息（第一条 user 消息）
  const firstUser = messages.find((m) => m.role === 'user');
  if (firstUser) anchors.add(firstUser.id);

  // - 最近 N 条消息
  const recentStart = Math.max(0, messages.length - options.recentWindowSize);
  messages.slice(recentStart).forEach((m) => anchors.add(m.id));

  // 2. 确保工具配对完整：如果保留 tool_call，必须保留对应的 tool_result
  const toolCallIds = new Set<string>();
  messages
    .filter((m) => anchors.has(m.id) && m.toolCalls)
    .forEach((m) => {
      m.toolCalls?.forEach((tc) => toolCallIds.add(tc.id));
    });

  // 反向：如果保留 tool_result，也要保留对应的 tool_call
  messages
    .filter((m) => anchors.has(m.id) && m.role === 'tool' && m.toolCallId)
    .forEach((m) => {
      const callMsg = messages.find((mm) =>
        mm.toolCalls?.some((tc) => tc.id === m.toolCallId),
      );
      if (callMsg) anchors.add(callMsg.id);
    });

  // 保留对应的 tool result
  messages
    .filter((m) => toolCallIds.has(m.toolCallId || ''))
    .forEach((m) => anchors.add(m.id));

  // 3. 按原顺序返回保留的消息
  return messages.filter((m) => anchors.has(m.id));
}
```

**关键特性**：

- **永不截断的锚点**：System Prompt、用户原始目标、关键约束、关键决策
- **工具配对完整**：tool_call 和 tool_result 总是同时保留或移除
- **消息顺序保持**：不会重排消息，避免时序混乱

---

### 5.4 L3: 中间步骤总结策略

**目标**：将多轮相似的中间步骤替换为一段简洁总结。

#### 5.4.1 失败尝试折叠

检测连续的"修改 → 验证 → 失败"循环，折叠为总结：

```
原始序列（10+ 条消息）：
  turn 5: edit_file(a.ts) → 尝试修复 X
  turn 6: npm test → 失败，错误 E1
  turn 7: edit_file(a.ts) → 再次尝试修复 X
  turn 8: npm test → 失败，错误 E2
  turn 9: edit_file(b.ts) → 尝试另一种方法
  turn 10: npm test → 失败，错误 E1
  ...

压缩后（1 条总结消息）：
  [压缩总结] 在尝试修复 X 的过程中，进行了 3 次修改和测试，均未成功：
  - 尝试修改 a.ts 两次，分别遇到错误 E1 和 E2
  - 尝试修改 b.ts，仍然遇到错误 E1
  - 错误模式：E1 反复出现
  当前仍未解决。
```

#### 5.4.2 重复读取合并

对同一文件的多次读取，合并为：

```
[压缩总结] 在此期间读取了以下文件：
- src/foo.ts (读取 3 次)
- src/bar.ts (读取 2 次)
- config.json (读取 1 次)
最新的文件内容请参考最近一次读取结果，或使用 read_file 重新获取。
```

#### 5.4.3 总结生成方式

**P0（无 LLM）**：基于模板的规则化总结：

```typescript
function ruleBasedSummarize(attempts: FailedAttempt[]): string {
  const files = new Set(attempts.map((a) => a.file));
  const errors = new Set(attempts.map((a) => a.errorType));

  return `[压缩总结] 共进行了 ${attempts.length} 次尝试，修改了 ${files.size} 个文件，遇到 ${errors.size} 种错误：
- 修改文件：${[...files].join(', ')}
- 错误类型：${[...errors].join(', ')}
- 结果：均未成功，请考虑换一种方法。`;
}
```

**P1（轻量 LLM）**：使用小模型/快速模型生成更自然的总结，控制在 100-200 tokens。

---

### 5.5 L4: 语义聚类 + 分层摘要策略

**目标**：对长会话进行分段语义摘要，保留语义骨架。

#### 5.5.1 会话分段

按语义主题将历史分成多个块：

```typescript
interface ConversationSegment {
  id: string;
  startTurn: number;
  endTurn: number;
  messages: Message[];
  topic: string; // 主题标签
  outcome: 'success' | 'failure' | 'partial' | 'ongoing';
  keyEntities: string[]; // 涉及的关键实体（文件/函数/概念）
  summary: string; // 该段的摘要
}
```

**分段依据**：

- 用户消息中的主题切换
- 工具调用的资源类型变化（从文件 A 转到文件 B）
- 显式的阶段标记（"接下来..."、"现在让我们..."）
- 时间间隔（长时间停顿后可能是新主题）

#### 5.5.2 分层摘要结构

```
压缩后上下文结构：

1. System Prompt（保留）
2. 用户原始目标（保留）
3. [会话摘要] 整体进展摘要（1 段）
4. [阶段 N 摘要] 阶段 1 摘要（早期阶段）
5. [阶段 N-1 摘要] 阶段 2 摘要（中期阶段）
   ...
6. 最近 K 轮完整消息（保留最近的详细上下文）
7. 当前活跃的工具调用/结果（完整保留）
```

**摘要粒度原则**：

- 越早期的阶段，摘要越简略
- 越近期的阶段，摘要越详细
- 最近 3-5 轮保留完整消息，不摘要

---

### 5.6 L5: 激进重写策略

**目标**：Token 即将超限，最大化压缩比，仅保留最核心信息。

#### 5.6.1 核心信息提取

只保留：

1. System Prompt
2. 用户的**当前活跃目标**（可能原始目标已变更，保留最新的）
3. 不可变的约束条件（"不要修改 X 文件"、"使用 Y 框架"等）
4. **当前状态快照**：哪些文件被修改了、哪些测试通过/失败、错误是什么
5. 最近 2-3 轮对话
6. 明确的下一步方向

#### 5.6.2 生成新的精简上下文

```typescript
// L5 压缩后的上下文示例
const compressed = [
  systemPrompt,
  {
    role: 'system',
    content: `[上下文压缩 - 激进模式] 之前的对话已被大幅压缩。以下是关键信息摘要：

【当前目标】${goal}
【已完成】${completedTasks}
【已修改文件】${modifiedFiles}
【当前问题】${currentError}
【已尝试方法】${attemptedMethods}（均未成功，请换思路）
【关键约束】${constraints}

请基于以上信息继续，不要重复之前已失败的尝试。如需查看早期细节，可使用相关工具重新获取。`,
  },
  ...last3Messages,
];
```

---

## 6. 触发机制

### 6.1 触发器类型

| 触发器           | 触发条件                        | 默认压缩级别       | 说明                   |
| ---------------- | ------------------------------- | ------------------ | ---------------------- |
| **Token 阈值**   | token 使用量达到阈值            | 按阈值分级         | 最主要的触发器         |
| **停滞检测**     | APG 报告 suspicious/stuck       | light → aggressive | 配合 Progress Guard    |
| **循环检测**     | APG 检测到循环                  | moderate           | 丢弃无效循环历史       |
| **错误风暴**     | 连续 N 次工具调用失败           | light              | 清理失败尝试，重新开始 |
| **用户主动触发** | 用户要求"总结一下"/"压缩上下文" | 由用户指定         | 用户可控               |
| **阶段完成**     | 检测到一个子任务完成            | moderate           | 已完成的子任务可以摘要 |
| **时间窗口**     | 运行时间超过 M 分钟             | light              | 长时间运行预防性压缩   |
| **模型建议**     | 模型在回复中暗示上下文过长      | moderate           | 模型自我感知           |

### 6.2 Token 阈值触发（分级响应）

```typescript
interface TokenThresholdConfig {
  light: number; // 0.7  → L1 压缩
  moderate: number; // 0.85 → L2 压缩
  aggressive: number; // 0.95 → L4 压缩
  extreme: number; // 0.98 → L5 压缩
}

// 默认阈值（按模型 context window 的百分比）
const defaultThresholds: TokenThresholdConfig = {
  light: 0.7,
  moderate: 0.85,
  aggressive: 0.95,
  extreme: 0.98,
};
```

**触发逻辑**：

1. 每轮结束后计算当前 token 数
2. 如果超过某个阈值且距离上次压缩超过 N 轮（冷却期）→ 触发对应级别压缩
3. 采用**滞后区间**避免震荡：压缩后必须降到下一级阈值以下才停止

### 6.3 与 Progress Guard 联动

```typescript
// APG 事件 → 压缩动作映射
const apgTriggerMap = {
  suspicious: { level: 'light', strategy: 'failed_attempts_fold' },
  stuck: { level: 'moderate', strategy: 'loop_cleaning + anchored_window' },
  failed: { level: 'aggressive', strategy: 'core_extraction' },
};

// 当 APG 触发反思时，同时做一次轻量压缩清理无效历史
progressGuard.on('intervention', (event) => {
  if (event.level === 'L1') {
    compressor.compress({
      level: 'light',
      reason: 'progress_guard_reflection',
      // 保留反思注入点之前的上下文，但折叠失败尝试
      strategies: ['deduplicate', 'truncate_outputs', 'fold_failed_attempts'],
    });
  }
});
```

---

## 7. 重要性评分策略

### 7.1 评分因素权重

```typescript
const defaultWeights = {
  recency: 0.2,
  roleWeight: 0.15,
  semanticType: 0.3,
  referenceCount: 0.15,
  stateChange: 0.15,
  toolSuccess: 0.05,
};
```

### 7.2 各因素计算逻辑

#### 7.2.1 时效性分 (Recency)

指数衰减：越新分数越高

```typescript
function recencyScore(msg: Message, currentTurn: number): number {
  const age = currentTurn - msg.turnIndex;
  const halfLife = 10; // 10 轮后半衰
  return Math.exp((-Math.LN2 * age) / halfLife);
}
```

#### 7.2.2 角色权重分 (Role Weight)

```typescript
const roleWeights = {
  system: 1.0,
  user: 0.9,
  assistant: 0.6,
  tool: 0.4, // 工具结果初始分低，但可被其他因素拉高
};
```

#### 7.2.3 语义类型分 (Semantic Type)

基于规则和关键词打标签并赋分：

| 标签                | 分数 | 识别方式                                       |
| ------------------- | ---- | ---------------------------------------------- |
| `goal`              | 1.0  | 用户消息包含"我需要"、"帮我"、"目标是"等意图词 |
| `constraint`        | 0.95 | "不要"、"必须"、"注意"、"记住"等约束词         |
| `key_decision`      | 0.9  | 决策性陈述，"决定"、"采用"、"选择"             |
| `error`             | 0.8  | 包含 Error/Exception/Traceback/失败 等         |
| `file_modification` | 0.8  | tool result 显示文件被成功修改                 |
| `success_result`    | 0.75 | 工具执行成功且产出结果                         |
| `reflection`        | 0.7  | 反思性内容、总结                               |
| `intermediate_step` | 0.3  | 普通读操作、搜索中间结果                       |
| `failed_attempt`    | 0.2  | 工具执行失败且错误重复                         |
| `temporary_output`  | 0.1  | 长日志、长列表、临时输出                       |
| `duplicate`         | 0.0  | 重复内容                                       |

#### 7.2.4 引用分 (Reference Count)

被后续消息引用则加分：

- 后续 assistant 消息提到"如你所说"、"根据之前的错误"等
- 工具调用操作的是之前某个 tool result 涉及的文件
- 用户回复提到之前的内容

#### 7.2.5 状态变化分 (State Change)

导致工作区状态变化的工具结果更重要：

- write_file / edit_file / delete_file 成功 → 高分
- 测试从失败变成功 → 高分
- 搜索找到了目标结果 → 中分
- 读操作未改变状态 → 基础分

---

## 8. 工具配对完整性保证

**核心约束**：`tool_call` 和对应的 `tool_result` 永远不能被分开——要么都保留，要么都移除。

### 8.1 配对检测

```typescript
function ensureToolPairing(messages: Message[]): Message[] {
  const toolCallToMsg = new Map<string, Message>();
  const toolResultToCall = new Map<string, string>();

  // 第一遍：建立映射
  for (const msg of messages) {
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        toolCallToMsg.set(tc.id, msg);
      }
    }
    if (msg.role === 'tool' && msg.toolCallId) {
      toolResultToCall.set(msg.toolCallId, msg.id);
    }
  }

  // 第二遍：验证配对，修复不完整
  const keepIds = new Set(messages.map((m) => m.id));

  // 保留的 tool_call 必须有对应的 result
  for (const [callId, callMsg] of toolCallToMsg) {
    if (keepIds.has(callMsg.id) && !toolResultToCall.has(callId)) {
      // 调用存在但结果被删了——要么找回结果，要么连调用一起删
      // 策略：优先找结果，如果找不到则删除调用
      keepIds.delete(callMsg.id);
    }
  }

  // 保留的 tool_result 必须有对应的 call
  for (const [resultId, callId] of toolResultToCall) {
    const callMsg = toolCallToMsg.get(callId);
    if (callMsg && keepIds.has(resultId) && !keepIds.has(callMsg.id)) {
      keepIds.add(callMsg.id); // 补回调用
    }
  }

  return messages.filter((m) => keepIds.has(m.id));
}
```

---

## 9. 记忆系统协同

### 9.1 压缩前自动提取值得记忆的内容

压缩不是简单删除——重要信息在压缩前写入持久化记忆：

```typescript
interface MemoryWrite {
  content: string;
  type: 'fact' | 'preference' | 'decision' | 'error_pattern' | 'file_state';
  importance: number;
  source: string; // 来源消息 ID
  ttl?: number; // 过期时间
}

async function extractMemories(messages: Message[]): Promise<MemoryWrite[]> {
  const memories: MemoryWrite[] = [];

  for (const msg of messages) {
    // 用户明确要求记住的
    if (
      msg.role === 'user' &&
      /记住|别忘了|note that|remember/i.test(msg.content as string)
    ) {
      memories.push({
        content: extractFact(msg.content as string),
        type: 'fact',
        importance: 0.9,
        source: msg.id,
      });
    }

    // 关键决策
    if (msg.tags?.includes('key_decision')) {
      memories.push({
        content: msg.content as string,
        type: 'decision',
        importance: 0.85,
        source: msg.id,
      });
    }

    // 用户偏好
    if (msg.role === 'user') {
      const preference = extractPreference(msg.content as string);
      if (preference) {
        memories.push({
          content: preference,
          type: 'preference',
          importance: 0.8,
          source: msg.id,
        });
      }
    }

    // 文件最终状态（修改成功的文件，记录其最终 hash 和摘要）
    if (msg.tags?.includes('file_modification') && msg.role === 'tool') {
      memories.push({
        content: summarizeFileModification(msg),
        type: 'file_state',
        importance: 0.7,
        source: msg.id,
        ttl: 24 * 60 * 60 * 1000, // 文件状态记忆 24 小时过期
      });
    }
  }

  return memories;
}
```

### 9.2 压缩后注入记忆提示

压缩完成后，提醒模型可以从记忆中检索信息：

```
[系统提示] 历史上下文已压缩。如果需要回忆之前的细节，可以使用 memory_search 工具检索长期记忆。
```

---

## 10. 场景化配置（Profile）

不同场景使用不同的压缩策略组合和参数。

### 10.1 Coding 场景（默认）

```typescript
const codingProfile: CompressionProfile = {
  name: 'coding',

  // 重要性权重调整
  importanceWeights: {
    semanticType: 0.35, // 错误和文件修改更重要
    stateChange: 0.2, // 状态变化是核心
    recency: 0.2,
    referenceCount: 0.15,
    roleWeight: 0.08,
    toolSuccess: 0.02,
  },

  // 语义类型权重
  tagWeights: {
    error: 0.9,
    file_modification: 0.9,
    goal: 0.95,
    failed_attempt: 0.15, // 失败尝试在 coding 中价值不高（可以重看git）
  },

  // 策略启用
  strategies: {
    deduplicate: true,
    truncateToolOutputs: {
      enabled: true,
      maxTokensPerToolResult: 3000,
      preserveHeadRatio: 0.7, // 错误信息通常在尾部
    },
    anchoredWindow: {
      recentMessages: 15,
      anchorTags: ['goal', 'constraint', 'error', 'file_modification'],
    },
    foldFailedAttempts: true,
    semanticSummarization: true,
  },

  // 触发器
  triggers: {
    tokenThresholds: { light: 0.75, moderate: 0.88, aggressive: 0.96 },
    onProgressGuardSuspicious: true,
    onProgressGuardStuck: true,
  },

  // 工具输出特殊处理
  toolSpecificRules: [
    {
      tool: 'shell',
      truncateAt: 2000,
      preservePatterns: [
        'error',
        'fail',
        'pass',
        'success',
        'Expected',
        'Received',
      ],
    },
    {
      tool: 'read_file',
      // 如果是大文件，提示"文件已在磁盘，请按需读取"
      hintIfTruncated:
        '文件内容较长已截断，如需查看完整内容或特定部分，请重新使用 read_file 并指定行范围。',
    },
  ],
};
```

### 10.2 Research 场景

```typescript
const researchProfile: CompressionProfile = {
  name: 'research',

  importanceWeights: {
    semanticType: 0.3,
    infoGain: 0.25, // 信息增益是核心
    recency: 0.15,
    referenceCount: 0.15,
    roleWeight: 0.1,
    toolSuccess: 0.05,
  },

  tagWeights: {
    goal: 1.0,
    key_finding: 0.9, // 关键发现
    source: 0.8, // 引用来源
    failed_attempt: 0.3, // 调研中"查过什么没有"也有价值
    intermediate_step: 0.4, // 搜索过程比 coding 中更重要
  },

  strategies: {
    deduplicate: true,
    truncateToolOutputs: {
      enabled: true,
      maxTokensPerToolResult: 4000,
      // Web 内容保留关键段落
    },
    // Research 场景摘要更详细，保留更多信息来源
    semanticSummarization: {
      preserveSources: true,
      summaryDetail: 'high',
    },
    foldFailedAttempts: false, // 调研中"什么没找到"也是信息
  },
};
```

### 10.3 Assistant / 对话场景

```typescript
const assistantProfile: CompressionProfile = {
  name: 'assistant',

  importanceWeights: {
    roleWeight: 0.25, // 用户消息权重高
    recency: 0.25, // 对话更看重近期
    preference: 0.2, // 用户偏好
    semanticType: 0.15,
    referenceCount: 0.1,
    emotionalState: 0.05, // 情感状态
  },

  tagWeights: {
    goal: 0.95,
    preference: 0.95,
    personal_info: 0.9, // 用户个人信息
    key_decision: 0.85,
    intermediate_step: 0.4,
  },

  // 对话场景压缩更温和，更依赖记忆系统
  strategies: {
    deduplicate: true,
    truncateToolOutputs: { enabled: true, maxTokensPerToolResult: 2000 },
    anchoredWindow: { recentMessages: 25 }, // 保留更多对话历史
    // 对话场景摘要时保留语气和上下文连贯性
  },

  // 更积极地写入记忆
  memoryIntegration: {
    autoExtractPreferences: true,
    autoExtractFacts: true,
    writeBeforeCompression: true,
  },
};
```

---

## 11. 压缩后过渡与平滑

### 11.1 过渡消息注入

压缩后注入一条简短的系统级提示，避免模型困惑：

**L1-L2 轻量压缩后**：

```
[系统] 为保持上下文简洁，部分冗余内容已被清理（重复内容、过长输出已截断）。不影响继续执行。
```

**L3 中度压缩后**：

```
[系统] 部分中间步骤已被总结折叠（如失败的尝试、重复读取）。关键信息和最近的上下文已保留。
如果需要回顾早期内容，可以重新执行相关工具或检索记忆。
```

**L4-L5 激进压缩后**：

```
[系统] 上下文已进行深度压缩。以下是关键状态摘要：
- 当前目标：{goal}
- 已完成：{completed}
- 当前问题：{currentIssue}
- 已尝试方法：{attempts}（未成功，请换思路）
请基于以上信息继续，避免重复已失败的尝试。
```

### 11.2 避免压缩震荡

**冷却机制**：压缩后 N 轮内不再触发同级别的压缩（默认 5 轮）

**压缩预算**：单次会话总压缩次数限制（默认 10 次），超过后只做 L1 级无损压缩

**渐进升级**：不跳级——从 L1 开始，逐步升级到更高级别，除非 token 已经到 extreme 阈值

---

## 12. 可观测性

### 12.1 Metrics

| 指标名                           | 类型      | 标签                             | 说明                |
| -------------------------------- | --------- | -------------------------------- | ------------------- |
| `ccs_compression_total`          | Counter   | level, strategy, trigger, reason | 压缩次数总计        |
| `ccs_tokens_before`              | Histogram | level                            | 压缩前 token 数分布 |
| `ccs_tokens_after`               | Histogram | level                            | 压缩后 token 数分布 |
| `ccs_tokens_saved_total`         | Counter   | level, strategy                  | 累计节省 token 数   |
| `ccs_compression_ratio`          | Histogram | level                            | 压缩比分布          |
| `ccs_messages_removed`           | Histogram | level                            | 移除消息数分布      |
| `ccs_messages_summarized`        | Histogram | level                            | 摘要合并消息数      |
| `ccs_compression_duration_ms`    | Histogram | level                            | 压缩耗时分布        |
| `ccs_memory_writes_total`        | Counter   | type                             | 写入记忆的条目数    |
| `ccs_trigger_checks_total`       | Counter   | trigger                          | 触发检查次数        |
| `ccs_trigger_hits_total`         | Counter   | trigger, level                   | 触发命中次数        |
| `ccs_compression_failures_total` | Counter   | reason                           | 压缩失败次数        |

### 12.2 结构化日志

每次压缩输出结构化日志：

```json
{
  "msg": "Context compressed",
  "level": "info",
  "compressionId": "cmp_abc123",
  "sessionId": "sess_xyz",
  "level": "moderate",
  "trigger": "token_threshold",
  "reason": "tokens_reached_85_percent",
  "strategiesUsed": [
    "deduplicate",
    "truncate_tool_outputs",
    "anchored_window",
    "fold_failed_attempts"
  ],
  "tokensBefore": 105000,
  "tokensAfter": 42000,
  "tokensSaved": 63000,
  "compressionRatio": 0.6,
  "messagesBefore": 87,
  "messagesAfter": 32,
  "messagesRemoved": 48,
  "messagesSummarized": 15,
  "durationMs": 23,
  "memoryWrites": 5,
  "compressionCountThisSession": 3,
  "cooldownUntil": 1234567890
}
```

### 12.3 Debug 模式

开启 `debug: true` 后，每轮输出压缩决策详情：

```
[CCS] Turn 42
  Tokens: 98500 / 128000 (77%)
  Should compress: yes (level: light, trigger: token_threshold)
  Cooldown: ok (last compression was 8 turns ago)
  Strategies to run: deduplicate, truncate_outputs
  Estimated savings: ~15000 tokens
  Proceeding...
[CCS] Compression complete (cmp_abc123)
  Tokens: 98500 → 82000 (saved 16500, ratio: 17%)
  Messages: 72 → 68 (removed 4 duplicates)
  Tool outputs truncated: 3 (shell outputs)
  Memories written: 2
  Duration: 8ms
```

### 12.4 压缩历史审计

保留压缩历史链，支持调试和回溯：

```typescript
interface CompressionHistoryEntry {
  compressionId: string;
  timestamp: number;
  level: CompressionLevel;
  trigger: string;
  tokensBefore: number;
  tokensAfter: number;
  strategiesUsed: string[];
  beforeHash: string;
  afterHash: string;
}
```

---

## 13. 配置设计

```yaml
context_compression:
  # 总开关
  enabled: true

  # 场景 profile: coding / research / assistant / custom
  profile: coding

  # 是否与 Progress Guard 联动
  integrate_with_progress_guard: true

  # 触发器配置
  triggers:
    token_threshold:
      enabled: true
      light: 0.70 # 70% 触发 L1
      moderate: 0.85 # 85% 触发 L2-L3
      aggressive: 0.95 # 95% 触发 L4
      extreme: 0.98 # 98% 触发 L5

    progress_guard:
      enabled: true
      on_suspicious: light
      on_stuck: moderate
      on_failed: aggressive

    error_storm:
      enabled: true
      consecutive_failures: 5
      level: light

    phase_completion:
      enabled: true
      level: moderate

    user_trigger:
      enabled: true

  # 冷却与防震荡
  cooldown:
    min_turns_between_compressions: 5
    max_compressions_per_session: 15
    allow_level_jump: false # 不跳级，必须逐步升级
    hysteresis_ratio: 0.10 # 必须降到下一级阈值以下 10% 才停止

  # 策略配置
  strategies:
    # L1: 无损清理
    deduplicate:
      enabled: true
      deduplicate_tool_results: true
      deduplicate_assistant_messages: true
      deduplicate_user_messages: false # 用户消息不去重
      deduplicate_system_messages: false

    truncate_tool_outputs:
      enabled: true
      max_tokens_per_result: 3500
      preserve_head_ratio: 0.6
      preserve_tail_ratio: 0.4
      preserve_patterns: # 包含这些模式的行优先保留
        - 'error'
        - 'Error'
        - 'fail'
        - 'FAIL'
        - 'success'
        - 'pass'
        - 'Pass'
        - 'Expected'
        - 'Received'
        - '✓'
        - '✗'

    remove_empty_messages:
      enabled: true

    # L2: 滑窗 + 锚点
    anchored_window:
      enabled: true
      recent_messages_to_keep: 15
      anchor_roles: ['system']
      anchor_tags:
        - goal
        - constraint
        - key_decision
        - error
      ensure_tool_paring: true

    # L3: 中间步骤总结
    fold_failed_attempts:
      enabled: true
      min_attempts_to_fold: 3
      max_attempts_in_summary: 10
      use_llm_summary: false # P0 用模板，P1 可开

    merge_repeated_reads:
      enabled: true
      min_reads_to_merge: 3

    # L4: 语义摘要（需 LLM）
    semantic_segmentation:
      enabled: false # P1 开启
      target_segment_tokens: 8000
      min_segment_messages: 8

    hierarchical_summary:
      enabled: false # P1 开启
      recent_turns_keep_full: 5
      summary_model: 'fast' # 用快速小模型做摘要
      max_summary_tokens: 200

    # L5: 激进重写
    core_extraction:
      enabled: true
      keep_recent_turns: 3
      preserve_goals: true
      preserve_constraints: true
      preserve_current_error: true
      preserve_modified_files: true

  # 重要性评分配置
  importance_scoring:
    enabled: true
    weights:
      recency: 0.20
      role_weight: 0.15
      semantic_type: 0.30
      reference_count: 0.15
      state_change: 0.15
      tool_success: 0.05

    tag_weights:
      goal: 1.0
      constraint: 0.95
      key_decision: 0.9
      error: 0.85
      file_modification: 0.8
      success_result: 0.75
      reflection: 0.7
      intermediate_step: 0.3
      failed_attempt: 0.2
      temporary_output: 0.1
      duplicate: 0.0

  # 记忆集成
  memory:
    enabled: true
    auto_extract_before_compression: true
    extract_types:
      - fact
      - preference
      - decision
      - error_pattern
      - file_state
    min_importance_to_write: 0.7
    inject_memory_hint: true

  # 过渡消息
  transition_messages:
    enabled: true
    levels:
      light: '[系统] 部分冗余内容已清理（重复/过长输出），不影响继续。'
      moderate: '[系统] 部分中间步骤已总结折叠，关键信息保留。可重新调用工具查看细节。'
      aggressive: '[系统] 上下文已深度压缩，仅保留核心状态。避免重复已失败的尝试。'
      extreme: '[系统] 上下文已极限压缩。请基于摘要信息换思路继续。'

  # 工具特殊规则
  tool_rules:
    - tool: shell
      max_tokens: 2500
      truncation_hint: 'Shell 输出过长已截断，错误信息已优先保留。'
    - tool: read_file
      max_tokens: 4000
      truncation_hint: '文件内容已截断，请按需重新读取特定行范围。'
    - tool: web_fetch
      max_tokens: 3500
    - tool: grep
      max_tokens: 2000

  # 可观测性
  observability:
    debug: false
    log_compressions: true
    log_strategy_details: false
    emit_metrics: true
    keep_compression_history: 20 # 保留最近 20 次压缩记录

  # Profile 覆盖
  profiles:
    coding:
      # ... 覆盖默认配置 ...
    research:
      # ...
    assistant:
      # ...
```

---

## 14. 实现路线图

| 阶段        | 内容                                                                                                                               | 代码量  | 依赖                         | 价值                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------- | ------------------------------------- |
| **P0 核心** | L0-L2 策略（去重/截断/锚点滑窗）+ Token 阈值触发 + 工具配对保证 + 基础 Metrics + Hook 集成 + 单元测试                              | ~500 行 | 无额外依赖                   | 解决 80% 场景，token 超限问题基本解决 |
| **P1 增强** | L3 策略（失败尝试折叠/重复读取合并/规则总结）+ APG 联动 + 重要性评分引擎 + 记忆集成 + 冷却/防震荡 + 完整日志                       | ~500 行 | 现有 memory 模块             | 误报率低，压缩更智能，与 APG 协同     |
| **P2 进阶** | L4 策略（语义分段/分层摘要，轻量 LLM 调用）+ 场景 Profile + 工具特殊规则 + Debug 模式 + 压缩历史审计                               | ~600 行 | LLM 调用（复用现有 AI 模块） | 支持长会话，压缩质量高                |
| **P3 高级** | L5 激进压缩 + 自适应阈值（根据模型/任务动态调参）+ 压缩质量评估（压缩后验证任务是否可继续）+ 语义标签自动标注（小模型）+ Dashboard | ~500 行 | embedding/小模型（可选）     | 生产级完备，智能自适应                |

### P0 交付物

```
src/context-compression/
├── index.ts                 # 主入口 ContextCompressor 类
├── types.ts                 # 类型定义
├── compressor.ts            # 编排器
├── triggers/
│   ├── token-threshold.ts   # Token 阈值触发器
│   └── base.ts              # 触发器基类
├── strategies/
│   ├── deduplicate.ts       # L1: 去重
│   ├── truncate-outputs.ts  # L1: 输出截断
│   ├── anchored-window.ts   # L2: 锚点滑窗
│   └── base.ts              # 策略基类
├── scoring/
│   └── importance.ts        # 重要性评分（P1 完整实现，P0 简化版）
├── utils/
│   ├── token-counter.ts     # Token 计数
│   ├── tool-pairing.ts      # 工具配对完整性
│   └── hashing.ts           # 内容哈希
├── observability/
│   ├── metrics.ts           # Metrics
│   └── logger.ts            # 结构化日志
└── memory-integration.ts    # 记忆联动（P1 完整实现）

tests/
└── context-compression.test.ts
```

---

## 15. 验证与测试策略

### 15.1 功能测试用例

| 测试场景                        | 预期结果                               |
| ------------------------------- | -------------------------------------- |
| Token 达 70% → 触发 L1          | 去重 + 截断，压缩比 10-20%，无信息丢失 |
| Token 达 85% → 触发 L2          | 锚点滑窗，最近消息保留，目标/错误保留  |
| 压缩后 tool_call 与 tool_result | 始终配对，无孤立消息                   |
| 用户原始目标消息                | 永远保留，不被压缩                     |
| 连续 5 次测试失败               | 折叠为一条总结                         |
| 同一文件读 4 次                 | 合并为一条提示                         |
| 压缩后立刻再次检查              | 冷却期内不重复压缩                     |
| Token 达 98% → L5               | 仅保留核心摘要 + 最近 3 轮             |
| 压缩前有关键约束                | 约束信息保留或写入记忆                 |

### 15.2 正确性验证

**配对完整性不变式**：

```
对于压缩后的任意 m:
  如果 m 包含 toolCalls，则所有 toolCall 对应的 tool_result 一定存在
  如果 m.role === 'tool'，则对应的 tool_call 消息一定存在
```

**锚点保留不变式**：

```
被标记为 goal/constraint/key_decision 的消息，如果在压缩前存在，压缩后一定存在（或被写入记忆并在过渡消息中明确提及）
```

**消息序不变式**：

```
压缩后消息顺序与压缩前一致，没有重排
```

---

## 16. 风险与缓解

| 风险                        | 影响                                            | 缓解措施                                                                                               |
| --------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **压缩过度丢失关键信息**    | 任务无法继续，模型困惑                          | 多级渐进式压缩 + 锚点保护 + 工具配对保证 + 记忆备份 + 冷却防震荡                                       |
| **压缩后模型忘记目标**      | 偏离用户原始需求                                | System Prompt 永远保留 + 第一条 user 消息永远锚定 + 激进压缩后在过渡消息中重述目标                     |
| **工具配对断裂**            | 模型看到 tool_result 不知道对应哪个调用，或反之 | 强制配对检查，不完整则补回或一起删除                                                                   |
| **摘要质量差/信息失真**     | L3+ 摘要引入错误信息                            | P0/P1 不用 LLM 做摘要，用模板；P2+ 用小模型但限制长度；过渡消息明确说明"已压缩，可重新获取"            |
| **压缩震荡（反复压缩）**    | 每轮都压缩浪费性能                              | 冷却机制 + 压缩次数限制 + 滞后区间                                                                     |
| **额外 LLM 成本（摘要时）** | 压缩本身消耗 token                              | P0-P1 无额外 LLM；P2+ 用小模型/快速模型做摘要，控制摘要长度在 200 tokens 以内；只有必要时才做 LLM 摘要 |
| **误判重要信息**            | 重要内容被错误删除                              | 保守策略（不确定重要的保留）+ 重要性评分多因素加权 + 用户消息默认高权重                                |
| **压缩后反而超限**          | L5 压缩后仍然超 token                           | 压缩后重新计数，不够则再升级一级；极端情况清空历史只保留 System + 目标重述                             |
| **性能开销**                | 增加每轮延迟                                    | P0-L2 策略纯计算无 I/O，目标 < 20ms；可配置关闭高级策略                                                |

---

## 17. 与现有系统的协同

### 17.1 与 Progress Guard (APG) 协同

```
┌─────────────┐      suspicious/stuck       ┌──────────────────┐
│  Progress   │────────────────────────────→│ Context          │
│  Guard      │                             │ Compressor       │
│             │←────────────────────────────│                  │
└─────────────┘      压缩完成，重置检测窗口  └──────────────────┘
       │                                               │
       │                                               │ 关键信息
       │                                               ▼
       │                                    ┌──────────────────┐
       │                                    │ Persistent       │
       └───────────────────────────────────→│ Memory           │
            失败模式/错误模式写入记忆         └──────────────────┘
```

- APG 检测到停滞/循环 → 触发 CCS 清理无效历史
- CCS 压缩完成 → 通知 APG 重置检测窗口（压缩相当于给了 Agent 一个新起点）
- 两者共享标签体系（error/failed_attempt/stateChange 等）
- 两者都通过 Hook 零侵入接入

### 17.2 与 Memory 系统协同

- CCS 在删除消息前提取值得记忆的内容
- CCS 压缩后提示模型可以用 memory_search
- Memory 中的信息比上下文压缩后保留的内容更持久

### 17.3 与 Token 计数协同

- 使用与模型调用时相同的 token 计算逻辑（避免预估偏差）
- 压缩前后精确计数，基于实际数字而非估算

---

## 18. 核心设计原则总结

1. **渐进式，不跳级**：从无损到有损，从轻到重，给 Agent 适应机会
2. **保守删除，不确定就留**：重要性评分拿不准的内容优先保留
3. **结构永远大于内容**：可以丢内容，但消息结构、工具配对、时序关系不能破
4. **锚点永不删除**：目标、约束、系统提示、当前错误——这些是上下文的"压舱石"
5. **删除前先备份**：重要信息写入记忆，不依赖上下文存活
6. **压缩后打个招呼**：过渡消息让模型知道发生了压缩，避免困惑
7. **不依赖额外 LLM 起步**：P0 用规则就能解决 80% 问题，LLM 摘要作为可选项
8. **可观测不黑盒**：每次压缩都有日志、有指标、有原因、有审计
9. **场景化配置**：coding/research/dialog 不同场景不同策略
10. **与 APG 共生**：不做孤岛，与 Progress Guard 联动形成"检测→压缩→恢复"闭环

---

## 19. 最终定位

Context Compression Strategy 不只是"token 超限了才救急"的被动机制，而是 **Agent Context Window 的主动管理平面**。

它负责：

```
持续监控上下文健康度
    ↓
在问题出现前主动预防（轻量清理）
    ↓
问题出现时分级响应（多级策略）
    ↓
压缩时保护关键信息（锚点+记忆）
    ↓
压缩后平滑过渡（消息提示）
    ↓
全程可观测可审计
```

最终目标：

> 让 Agent 的上下文窗口永远保持高信息密度——既不超限，又不丢失关键信息，让模型始终能"看清"当前状态和目标。

**推荐作为 kobot Runtime 层的标准基础能力，与 Agent Progress Guard 配合形成 Runtime 控制平面的双支柱。**
