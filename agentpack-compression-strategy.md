# AgentPack 多级上下文压缩策略设计

> **实现状态（2026-08-05）**：本文档为**设计初稿**，以下内容已落地于
> `packages/agentpack-compression`，但实现与设计存在差异，以源码为准：
> - fork 超时改为 **per-fork AbortController**（`createForkAbortController`），不再使用 `safety.abortSignal`
> - fork 调用带**指数退避重试**（`retry.ts`），瞬时错误与生成失败分离
> - L3 JSON 解析失败时**记失败遥测并跳过**，不再把自由文本塞进 `originalRequest`
> - L4 检查点通过追加 `__checkpointMeta` system message 持久化 `taskState` 等结构化字段
> - L5 完成后**复检窗口**，超窗时对 handoff 文档硬截断（`hardTruncateIfOverWindow`）
> - 新增 `dryRun` 模式、`validateConfig` 配置校验、同 session 串行化、`sessionAbortController` 生命周期管理
> - 所有 level 构造签名已扩展为 `(estimator, streamFn, model, config, forkTimeoutMs, retry)`

## 一、架构总览

压缩系统作为**单个复合转换器** `ContextCompressionTransformer`（priority=40）插入现有 Pipeline，内部按序执行**五级渐进式降级**。每一级比上一级代价更高、信息损耗更大，确保不到万不得已不丢失信息。

```
现有 Pipeline（按 priority 排序）:
  10  ToolPairingTransformer          ← 已有：清理孤立 tool_call/tool_result
  20  SystemMessageCleanerTransformer  ← 已有：保留最后一条 system message
  30  StateSnapshotTransformer         ← 已有：注入状态快照（pinned）
  40  ContextCompressionTransformer    ← 新增：五级复合压缩
       ├─ L1: ToolOutputTrim           （工具输出裁剪，无损，缓存安全）
       ├─ L2: MessageSummarize         （旧消息摘要，有损，Fork Agent）
       ├─ L3: TaskStateExtraction      （任务状态提取，结构化降级）
       ├─ L4: SessionCheckpoint         （会话检查点，持久化后激进缩减）
       └─ L5: NewSessionHandoff        （新会话交接，保底重置）
  90  TruncationTransformer            ← 已有：按数量截断（最终兜底）
```

**核心设计原则**：每一级仅在前一级不足以将 token 用量降至阈值以下时才触发。级别之间通过复合转换器内部的共享状态直接传递，无需依赖 `meta` round-trip。

### 五级降级总览

| 级别 | 名称 | 操作类型 | 信息损耗 | 触发阈值 | 缓存影响 |
|------|------|---------|---------|---------|---------|
| L1 | ToolOutputTrim | 工具输出裁剪 + thinking 剥离 | 无损/极低 | >60% | 尾部操作，前缀不变 |
| L2 | MessageSummarize | 旧消息块摘要替换 | 有损（语义保留） | >75% | 前缀保留 |
| L3 | TaskStateExtraction | 任务状态结构化提取 | 有损（结构化降级） | >85% | 重建上下文 |
| L4 | SessionCheckpoint | 持久化检查点 + 激进缩减 | 有损（可恢复） | >92% | 缓存失效 |
| L5 | NewSessionHandoff | 新会话交接 + 旧会话归档 | 高损耗（保底重置） | >95% | 完全重置 |

### 降级流程图

```
                    ┌─────────────────┐
                    │ transformMessages() │
                    │ 每 tool-loop 迭代执行  │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │ estimateTokens()  │
                    └────────┬────────┘
                             │
              ┌──────────────▼──────────────┐
              │ tokens > ctxWindow × 0.60?  │── No ──→ 直接返回
              └──────┬──────────────────────┘
                     │ Yes
              ┌──────▼──────┐
              │  L1: Trim    │
              │  工具输出裁剪  │
              │  (无损,缓存安全)│
              └──────┬──────┘
                     │
              ┌──────▼──────────────────┐
              │ tokens > ctxWindow × 0.75?│── No ──→ 返回 L1 结果
              └──────┬──────────────────────┘
                     │ Yes
              ┌──────▼──────┐
              │  L2: Summarize│
              │  旧消息摘要    │
              │  (Fork Agent) │
              └──────┬──────┘
                     │
              ┌──────▼──────────────────┐
              │ tokens > ctxWindow × 0.85?│── No ──→ 返回 L2 结果
              └──────┬──────────────────────┘
                     │ Yes
              ┌──────▼──────┐
              │  L3: Extract │
              │  任务状态提取 │
              │  (结构化降级) │
              └──────┬──────┘
                     │
              ┌──────▼──────────────────┐
              │ tokens > ctxWindow × 0.92?│── No ──→ 返回 L3 结果
              └──────┬──────────────────────┘
                     │ Yes
              ┌──────▼──────┐
              │  L4: Checkpoint│
              │  会话检查点    │
              │  (持久化+激进缩减)│
              └──────┬──────┘
                     │
              ┌──────▼──────────────────┐
              │ tokens > ctxWindow × 0.95?│── No ──→ 返回 L4 结果
              └──────┬──────────────────────┘
                     │ Yes
              ┌──────▼──────┐
              │  L5: Handoff │
              │  新会话交接    │
              │  (保底重置)    │
              └──────┬──────┘
                     │
              ┌──────▼──────────────┐
              │  断路器: 冷却 5 轮    │
              │  旧会话归档          │
              └─────────────────────┘
```

---

## 二、Token 估算层

现有代码库**没有 token 计数**。`Model.contextWindow` 存在于 `ai/catalog.ts` 但从未被用于主动管理。需要新增轻量估算器：

```typescript
// compression/token-estimator.ts

export interface TokenEstimator {
  estimate(resource: ContextResource): number;
  estimateAll(resources: ContextResource[]): number;
}

export class CharHeuristicEstimator implements TokenEstimator {
  private cache = new Map<string, number>();

  constructor(
    private charsPerTokenAscii = 4,   // 英文约 4 字符/token
    private charsPerTokenCJK = 1.5,    // 中文约 1.5 字符/token
  ) {}

  estimate(resource: ContextResource): number {
    if (this.cache.has(resource.id)) return this.cache.get(resource.id)!;

    const text = extractTextFromResource(resource);
    let asciiChars = 0, cjkChars = 0;
    for (const ch of text) {
      if (ch.charCodeAt(0) > 0x2e80) cjkChars++;
      else asciiChars++;
    }
    const tokens = Math.ceil(asciiChars / this.charsPerTokenAscii)
                 + Math.ceil(cjkChars / this.charsPerTokenCJK);
    // Image block: 固定开销估算
    const hasImage = JSON.stringify(resource.content).includes('"type":"image"');
    const imageTokens = hasImage ? 1500 : 0;

    const total = tokens + imageTokens;
    this.cache.set(resource.id, total);
    return total;
  }

  estimateAll(resources: ContextResource[]): number {
    return resources.reduce((sum, r) => sum + this.estimate(r), 0);
  }
}
```

---

## 三、L1 - 工具输出裁剪（ToolOutputTrim）

### 目标
无损或极低损耗操作，专门设计为**不破坏 Prompt Cache 前缀**。

### 触发条件
`estimatedTokens > contextWindow × L1_THRESHOLD`（默认 0.60）

### 缓存安全设计
所有操作只从**上下文尾部**（最近的消息）向头部扫描，一旦释放足够 token 即停止。这确保缓存前缀完全不变，下次 API 调用仍命中缓存。

```typescript
// compression/l1-tool-output-trim.ts

export interface L1Config {
  enabled: boolean;
  threshold: number;           // 0.60
  targetRatio: number;         // 0.50 - 降至 contextWindow 的 50%
  stripThinking: boolean;
  trimToolResults: boolean;
  toolResultMaxLines: number;  // 50
  toolResultHeadLines: number; // 10
  toolResultTailLines: number; // 10
  normalizeWhitespace: boolean;
}

export class ToolOutputTrim {
  constructor(
    private estimator: TokenEstimator,
    private config: L1Config,
  ) {}

  async compress(
    resources: ContextResource[],
    contextWindow: number,
  ): Promise<{ resources: ContextResource[]; telemetry: CompressionTelemetry[] }> {
    const target = contextWindow * this.config.targetRatio;
    const telemetry: CompressionTelemetry[] = [];
    let current = [...resources];
    let currentTokens = this.estimator.estimateAll(current);

    if (currentTokens <= target) return { resources: current, telemetry };

    // ── 操作 1: 剥离 thinking 块 ──
    // thinking 内容在生成回合结束后不再需要，剥离不影响语义
    if (this.config.stripThinking) {
      current = this.stripThinkingBlocks(current);
      currentTokens = this.estimator.estimateAll(current);
      telemetry.push(this.makeTelemetry('strip_thinking', resources, current));
      if (currentTokens <= target) return { resources: current, telemetry };
    }

    // ── 操作 2: 工具结果智能裁剪 ──
    // 从尾部向头部扫描，裁剪冗长的 tool_result
    if (this.config.trimToolResults) {
      current = this.trimToolResults(current, target - currentTokens);
      currentTokens = this.estimator.estimateAll(current);
      telemetry.push(this.makeTelemetry('trim_tool_result', resources, current));
      if (currentTokens <= target) return { resources: current, telemetry };
    }

    // ── 操作 3: 空白规范化 ──
    if (this.config.normalizeWhitespace) {
      current = this.normalizeWhitespace(current);
      telemetry.push(this.makeTelemetry('normalize_whitespace', resources, current));
    }

    return { resources: current, telemetry };
  }

  /** 剥离 assistant_message 中的 thinking 内容块 */
  private stripThinkingBlocks(resources: ContextResource[]): ContextResource[] {
    return resources.map(r => {
      if (r.type !== 'assistant_message') return r;
      const content = r.content as ContentBlock[];
      if (!Array.isArray(content)) return r;
      const filtered = content.filter(b => b.type !== 'thinking');
      if (filtered.length === content.length) return r;
      return { ...r, content: filtered };
    });
  }

  /** 从尾部向头部裁剪 tool_result，保留首尾行 + 关键行 */
  private trimToolResults(
    resources: ContextResource[],
    tokensToFree: number,
  ): ContextResource[] {
    let freed = 0;
    const result = [...resources];

    // 从尾部向头部扫描（保护缓存前缀）
    for (let i = result.length - 1; i >= 0 && freed < tokensToFree; i--) {
      const r = result[i];
      if (r.type !== 'tool_result' || r.pinned) continue;

      const text = extractTextFromResource(r);
      const lines = text.split('\n');
      if (lines.length <= this.config.toolResultMaxLines) continue;

      const headLines = lines.slice(0, this.config.toolResultHeadLines);
      const tailLines = lines.slice(-this.config.toolResultTailLines);
      const keyLines = lines.filter(l =>
        /^(error|warning|result|summary|fail)/i.test(l.trim())
      ).slice(0, 3);

      const truncated = [
        ...headLines,
        `\n[... truncated ${lines.length - headLines.length - tailLines.length} lines ...]`,
        ...keyLines,
        ...tailLines,
      ].join('\n');

      const beforeTokens = this.estimator.estimate(r);
      result[i] = {
        ...r,
        content: [{ type: 'text', text: truncated }],
        meta: { ...r.meta, _trimmed: true, _originalLines: lines.length },
      };
      freed += beforeTokens - this.estimator.estimate(result[i]);
    }

    return result;
  }
}
```

### 关键点
- `stripThinkingBlocks`：thinking 块在回合结束后是"废弃"信息，剥离无损
- `trimToolResults`：文件读取、搜索结果等通常数百行，保留首尾 + 错误行即可保留语义
- 两者都从尾部操作，前缀缓存完全不受影响

---

## 四、L2 - 旧消息摘要（MessageSummarize）

### 目标
当 L1 不足以降级时，通过 Fork Agent 生成摘要替换旧消息块。

### 触发条件
L1 执行后 `estimatedTokens > contextWindow × L2_THRESHOLD`（默认 0.75）

### Fork Agent 机制

```typescript
// compression/l2-message-summarize.ts

export interface L2Config {
  enabled: boolean;
  threshold: number;                // 0.75
  targetRatio: number;              // 0.60
  forkModel?: string;               // 可指定更便宜的模型
  forkMaxTokens: number;            // 2048
  minResourcesToCompress: number;    // 4
  protectedRecentCount: number;     // 6
  maxCompressionDepth: number;     // 3
}

export class MessageSummarize {
  constructor(
    private estimator: TokenEstimator,
    private streamFn: StreamFn,
    private model: Model,
    private config: L2Config,
  ) {}

  async compress(
    resources: ContextResource[],
    contextWindow: number,
    safety: CompressionSafetyState,
  ): Promise<{ resources: ContextResource[]; telemetry: CompressionTelemetry[] }> {
    // ── 递归保护：防止"压缩压缩的压缩" ──
    if (safety.compressionDepth >= this.config.maxCompressionDepth) {
      return { resources, telemetry: [] };
    }

    // ── 识别可压缩块 ──
    const compressible = this.identifyCompressible(
      resources, this.config.protectedRecentCount,
    );

    if (compressible.length < this.config.minResourcesToCompress) {
      return { resources, telemetry: [] };
    }

    // ── 提取文本 ──
    const transcript = compressible
      .map(r => this.formatResourceForSummary(r))
      .join('\n\n');

    // ── Fork Agent: 发起摘要请求 ──
    const summary = await this.forkSummarize(transcript, safety);
    if (!summary) return { resources, telemetry: [] };

    // ── 构建 compaction_summary 资源 ──
    const summaryResource: ContextResource = {
      id: `compaction_${Date.now()}`,
      type: 'compaction_summary',
      role: 'system',
      content: summary,
      timestamp: Date.now(),
      dependencies: [],
      meta: {
        _compressionLevel: 2,
        _compressionDepth: safety.compressionDepth + 1,
        _sourceCount: compressible.length,
        _sourceRange: `${compressible[0].id}..${compressible[compressible.length - 1].id}`,
      },
      pinned: true,
    };

    // ── 替换：保留前缀 + 摘要 + 最近消息 ──
    const prefixEnd = resources.indexOf(compressible[0]);
    const suffixStart = resources.indexOf(compressible[compressible.length - 1]) + 1;
    const result = [
      ...resources.slice(0, prefixEnd),
      summaryResource,
      ...resources.slice(suffixStart),
    ];

    const telemetry: CompressionTelemetry = {
      level: 'L2',
      action: 'message_summarize',
      beforeTokens: this.estimator.estimateAll(resources),
      afterTokens: this.estimator.estimateAll(result),
      resourcesAffected: compressible.length,
      triggerReason: 'threshold_exceeded',
      cachePreserved: prefixEnd > 0,
      compressionDepth: safety.compressionDepth + 1,
    };

    safety.compressionDepth++;
    return { resources: result, telemetry: [telemetry] };
  }

  /** 识别可压缩块：排除 pinned、最近 N 条、不完整工具对 */
  private identifyCompressible(
    resources: ContextResource[],
    protectedCount: number,
  ): ContextResource[] {
    const recent = resources.slice(-protectedCount);
    const recentIds = new Set(recent.map(r => r.id));
    const toolPairIds = this.buildToolPairIds(resources);

    return resources.filter(r => {
      if (r.pinned) return false;
      if (recentIds.has(r.id)) return false;
      if (r.type === 'compaction_summary') return false;
      if (r.type === 'task_state') return false;  // L3 产物也不压缩
      if (toolPairIds.has(r.id) && !this.isPairComplete(r, resources, toolPairIds)) {
        return false;
      }
      return true;
    });
  }

  /** Fork Agent: 使用 streamFn 发起摘要请求 */
  private async forkSummarize(
    transcript: string,
    safety: CompressionSafetyState,
  ): Promise<string | null> {
    const forkModel = this.config.forkModel
      ? this.lookupModel(this.config.forkModel)
      : this.model;

    const context: Context = {
      systemPrompt: L2_SUMMARIZATION_PROMPT,
      messages: [{
        role: 'user',
        content: `请将以下对话历史压缩为结构化摘要：\n${transcript}`,
        timestamp: Date.now(),
      }],
    };

    try {
      const result = await this.streamFn(forkModel, context, {
        signal: safety.abortSignal,
      });
      let summary = '';
      for await (const event of result) {
        if (event.type === 'text') summary += event.text;
      }
      return summary || null;
    } catch {
      return null;  // Fork 失败时降级到 L3
    }
  }
}

const L2_SUMMARIZATION_PROMPT = `You are a context compression agent.
Summarize the conversation history into a concise, structured summary.
Preserve all critical information for continued task execution.

## Output Format

## Context Summary
[Core user intent and current task state]

## Key Decisions
- [Decision 1]
- [Decision 2]

## Tool Results
- [Tool name]: [Key result/outcome]

## Pending Actions
- [Action 1]
- [Action 2]`;
```

### 缓存共享设计
- Fork Agent 使用与主对话相同的 `provider` 和 `baseUrl`，API 端缓存前缀可共享
- 摘要替换位置在**前缀之后**，主对话的缓存前缀完全不变
- `compaction_summary` 资源被 `pinned: true`，不会被后续压缩移除

---

## 五、L3 - 任务状态提取（TaskStateExtraction）

### 目标
当 L2 摘要仍不足以降级时，将整个对话历史**结构化提取**为任务状态对象，用极紧凑的结构化表示替换所有历史上下文。

### 与 L2 的区别
- L2 生成**自然语言摘要**，保留对话叙事结构
- L3 生成**结构化任务状态**，只保留执行所需的关键事实，丢弃叙事细节
- L3 输出体积远小于 L2，但信息密度更高、损失更大

### 触发条件
L2 执行后 `estimatedTokens > contextWindow × L3_THRESHOLD`（默认 0.85）

```typescript
// compression/l3-task-state-extraction.ts

export interface L3Config {
  enabled: boolean;
  threshold: number;            // 0.85
  targetRatio: number;          // 0.40 - 激进缩减至 40%
  forkModel?: string;
  forkMaxTokens: number;        // 1024
  protectedRecentCount: number; // 4 - 比L2更少保护
}

export interface TaskState {
  originalRequest: string;       // 用户原始请求
  currentPhase: string;          // 当前执行阶段
  completedSteps: string[];      // 已完成步骤
  pendingSteps: string[];         // 待执行步骤
  keyDecisions: string[];        // 关键决策
  constraints: string[];          // 约束条件
  toolResults: {                  // 工具调用结果摘要
    tool: string;
    status: 'success' | 'failure' | 'partial';
    summary: string;
  }[];
  errors: string[];               // 错误记录
  variables: Record<string, unknown>; // 上下文变量
}

export class TaskStateExtraction {
  constructor(
    private estimator: TokenEstimator,
    private streamFn: StreamFn,
    private model: Model,
    private config: L3Config,
  ) {}

  async compress(
    resources: ContextResource[],
    contextWindow: number,
    safety: CompressionSafetyState,
  ): Promise<{ resources: ContextResource[]; telemetry: CompressionTelemetry[] }> {
    // ── 提取全部对话内容（包括已有的 compaction_summary） ──
    const allContent = this.extractAllContent(resources);

    // ── Fork Agent: 结构化任务状态提取 ──
    const taskState = await this.forkExtract(allContent, safety);
    if (!taskState) return { resources, telemetry: [] };

    // ── 构建 task_state 资源 ──
    const taskStateResource: ContextResource = {
      id: `task_state_${Date.now()}`,
      type: 'custom',           // 使用 custom 类型，role 标记为 taskState
      role: 'taskState',
      content: taskState,
      timestamp: Date.now(),
      dependencies: [],
      meta: {
        _compressionLevel: 3,
        _sourceResourceCount: resources.length,
      },
      pinned: true,
    };

    // ── 激进替换：只保留 task_state + 最近 N 条消息 ──
    const recent = resources.slice(-this.config.protectedRecentCount);
    const result = [taskStateResource, ...recent];

    const telemetry: CompressionTelemetry = {
      level: 'L3',
      action: 'task_state_extraction',
      beforeTokens: this.estimator.estimateAll(resources),
      afterTokens: this.estimator.estimateAll(result),
      resourcesAffected: resources.length - recent.length,
      triggerReason: 'threshold_exceeded',
      cachePreserved: false,  // 上下文重建，缓存失效
      compressionDepth: safety.compressionDepth + 1,
    };

    safety.compressionDepth++;
    return { resources: result, telemetry: [telemetry] };
  }

  /** 提取所有资源的内容文本，包括已有的摘要 */
  private extractAllContent(resources: ContextResource[]): string {
    return resources
      .filter(r => r.type !== 'system_message' && r.type !== 'state_snapshot')
      .map(r => {
        const text = extractTextFromResource(r);
        const prefix = `[${r.type}]`;
        return `${prefix} ${text}`;
      })
      .join('\n\n');
  }

  /** Fork Agent: 结构化任务状态提取 */
  private async forkExtract(
    allContent: string,
    safety: CompressionSafetyState,
  ): Promise<TaskState | null> {
    const forkModel = this.config.forkModel
      ? this.lookupModel(this.config.forkModel)
      : this.model;

    const context: Context = {
      systemPrompt: L3_EXTRACTION_PROMPT,
      messages: [{
        role: 'user',
        content: `从以下对话历史中提取结构化任务状态：\n\n${allContent}`,
        timestamp: Date.now(),
      }],
    };

    try {
      const result = await this.streamFn(forkModel, context, {
        signal: safety.abortSignal,
      });
      let output = '';
      for await (const event of result) {
        if (event.type === 'text') output += event.text;
      }
      // 尝试解析 JSON，失败则将纯文本作为 originalRequest
      try {
        return JSON.parse(output) as TaskState;
      } catch {
        return {
          originalRequest: output.slice(0, 500),
          currentPhase: 'unknown',
          completedSteps: [],
          pendingSteps: [],
          keyDecisions: [],
          constraints: [],
          toolResults: [],
          errors: [],
          variables: {},
        };
      }
    } catch {
      return null;
    }
  }
}

const L3_EXTRACTION_PROMPT = `You are a task state extraction agent.
Extract a structured JSON object representing the current task state from the conversation history.
Be extremely concise. Only include information necessary for continued execution.

Output valid JSON matching this schema:
{
  "originalRequest": "用户原始请求的核心描述（1-2句）",
  "currentPhase": "当前执行阶段",
  "completedSteps": ["已完成的步骤1", "已完成的步骤2"],
  "pendingSteps": ["待执行的步骤1"],
  "keyDecisions": ["关键决策1"],
  "constraints": ["约束条件1"],
  "toolResults": [
    {"tool": "工具名", "status": "success|failure|partial", "summary": "结果摘要"}
  ],
  "errors": ["错误记录1"],
  "variables": {"key": "value"}
}`;
```

### 关键区别
- L2 保留**对话叙事**（谁说了什么、按什么顺序）
- L3 只保留**执行所需事实**（做了什么、还要做什么、约束是什么）
- L3 的 `TaskState` 是结构化 JSON，可以被 agent 直接解析使用，而非人类阅读的摘要

---

## 六、L4 - 会话检查点（SessionCheckpoint）

### 目标
当 L3 仍不足以降级时，先将完整会话状态**持久化到存储**（不丢失任何信息），然后激进缩减上下文到最小工作集。

### 与 L3 的区别
- L3 提取任务状态但仍保留最近 N 条消息
- L4 先保存完整快照（可恢复），然后只保留**最小执行上下文**：system prompt + task_state + 最近 2 条消息
- L4 是"安全网"--信息不会真正丢失，只是从内存移到磁盘

### 触发条件
L3 执行后 `estimatedTokens > contextWindow × L4_THRESHOLD`（默认 0.92）

```typescript
// compression/l4-session-checkpoint.ts

export interface L4Config {
  enabled: boolean;
  threshold: number;            // 0.92
  targetRatio: number;          // 0.25 - 缩减至 25%
  checkpointStorage: 'file' | 'memory' | 'custom';
  minWorkingSet: number;        // 2 - 最小保留消息数
}

export interface SessionCheckpoint {
  checkpointId: string;
  sessionId: string;
  timestamp: number;
  fullMessages: Message[];           // 完整消息快照
  taskState?: TaskState;             // L3 提取的任务状态
  compactionHistory: CompressionTelemetry[];  // 压缩历史
  resourceCount: number;
  estimatedTokens: number;
}

export class SessionCheckpointLevel {
  constructor(
    private estimator: TokenEstimator,
    private sessionStorage: SessionStorage,
    private config: L4Config,
  ) {}

  async compress(
    resources: ContextResource[],
    contextWindow: number,
    safety: CompressionSafetyState,
    sessionKey: string,
  ): Promise<{ resources: ContextResource[]; telemetry: CompressionTelemetry[] }> {
    // ── 步骤 1: 创建完整检查点 ──
    const messages = resourcesToMessages(resources);
    const checkpoint: SessionCheckpoint = {
      checkpointId: `ckpt_${Date.now()}`,
      sessionId: sessionKey,
      timestamp: Date.now(),
      fullMessages: messages,
      taskState: this.findTaskState(resources),
      compactionHistory: safety.telemetryHistory,
      resourceCount: resources.length,
      estimatedTokens: this.estimator.estimateAll(resources),
    };

    // ── 步骤 2: 持久化检查点 ──
    await this.persistCheckpoint(checkpoint);

    // ── 步骤 3: 激进缩减到最小工作集 ──
    const workingSet = this.buildMinimalWorkingSet(resources);
    const checkpointRef: ContextResource = {
      id: `checkpoint_ref_${checkpoint.checkpointId}`,
      type: 'custom',
      role: 'system',
      content: `[Session Checkpoint: ${checkpoint.checkpointId}]\n`
             + `Full context saved at ${checkpoint.timestamp}.\n`
             + `Resource count: ${checkpoint.resourceCount}, Tokens: ${checkpoint.estimatedTokens}.\n`
             + `Recovery: load checkpoint ${checkpoint.checkpointId} to restore full context.`,
      timestamp: Date.now(),
      dependencies: [],
      meta: {
        _compressionLevel: 4,
        _checkpointId: checkpoint.checkpointId,
        _recoverable: true,
      },
      pinned: true,
    };

    const result = [checkpointRef, ...workingSet];

    const telemetry: CompressionTelemetry = {
      level: 'L4',
      action: 'session_checkpoint',
      beforeTokens: checkpoint.estimatedTokens,
      afterTokens: this.estimator.estimateAll(result),
      resourcesAffected: resources.length - workingSet.length,
      triggerReason: 'threshold_exceeded',
      cachePreserved: false,
      compressionDepth: safety.compressionDepth + 1,
    };

    safety.compressionDepth++;
    safety.hasCheckpoint = true;
    safety.checkpointId = checkpoint.checkpointId;
    return { resources: result, telemetry: [telemetry] };
  }

  /** 构建最小工作集：pinned + task_state + 最近 2 条消息 */
  private buildMinimalWorkingSet(resources: ContextResource[]): ContextResource[] {
    const pinned = resources.filter(r => r.pinned);
    const unpinned = resources.filter(r => !r.pinned);
    const recent = unpinned.slice(-this.config.minWorkingSet);

    // 去重：pinned 中可能已有 task_state，不重复加入
    const pinnedIds = new Set(pinned.map(r => r.id));
    const newRecent = recent.filter(r => !pinnedIds.has(r.id));

    return [...pinned, ...newRecent].sort((a, b) => a.timestamp - b.timestamp);
  }

  private async persistCheckpoint(checkpoint: SessionCheckpoint): Promise<void> {
    const key = `checkpoint_${checkpoint.checkpointId}`;
    await this.sessionStorage.save(checkpoint.sessionId, {
      messages: checkpoint.fullMessages,
      checkpoint,
    });
  }

  private findTaskState(resources: ContextResource[]): TaskState | undefined {
    const taskStateRes = resources.find(r => r.role === 'taskState');
    return taskStateRes?.content as TaskState | undefined;
  }
}
```

### 恢复机制
当 agent 需要回溯被 L4 移除的上下文时，可通过 `checkpointId` 从 `SessionStorage` 加载完整快照。这确保 L4 虽然激进缩减了上下文，但信息从未真正丢失。

---

## 七、L5 - 新会话交接（NewSessionHandoff）

### 目标
**最终保底手段**：当所有压缩级别都无法有效降级时，创建一个全新的干净会话，通过交接文档传递关键上下文。旧会话归档保留。

### 触发条件
L4 执行后 `estimatedTokens > contextWindow × L5_THRESHOLD`（默认 0.95）
或断路器触发（`safety.circuitBreakerTripped`）

```typescript
// compression/l5-new-session-handoff.ts

export interface L5Config {
  enabled: boolean;
  threshold: number;            // 0.95
  forkModel?: string;
  forkMaxTokens: number;        // 2048
}

export interface SessionHandoff {
  handoffId: string;
  originalSessionId: string;
  newSessionId: string;
  timestamp: number;
  handoffDocument: string;      // 交接文档（自然语言）
  taskState?: TaskState;         // L3 提取的任务状态
  checkpointId?: string;        // L4 的检查点 ID
  compactionSummary: string;     // 所有压缩历史摘要
  reason: string;               // 触发原因
}

export class NewSessionHandoff {
  constructor(
    private estimator: TokenEstimator,
    private streamFn: StreamFn,
    private model: Model,
    private config: L5Config,
  ) {}

  async compress(
    resources: ContextResource[],
    contextWindow: number,
    safety: CompressionSafetyState,
    sessionKey: string,
  ): Promise<{ resources: ContextResource[]; telemetry: CompressionTelemetry[]; handoff?: SessionHandoff }> {
    // ── 收集所有可用上下文 ──
    const allContext = this.collectContext(resources, safety);

    // ── Fork Agent: 生成交接文档 ──
    const handoffDoc = await this.forkHandoff(allContext, safety);
    if (!handoffDoc) {
      // Fork 失败：用硬编码模板兜底
      return this.fallbackHandoff(resources, safety, sessionKey);
    }

    // ── 构建交接数据 ──
    const handoff: SessionHandoff = {
      handoffId: `handoff_${Date.now()}`,
      originalSessionId: sessionKey,
      newSessionId: `${sessionKey}_h${Date.now()}`,
      timestamp: Date.now(),
      handoffDocument: handoffDoc,
      taskState: this.findTaskState(resources),
      checkpointId: safety.checkpointId,
      compactionSummary: this.summarizeCompactionHistory(safety.telemetryHistory),
      reason: safety.circuitBreakerTripped
        ? 'circuit_breaker_triggered'
        : 'threshold_exceeded',
    };

    // ── 构建新会话初始上下文 ──
    // 只有 system prompt + 交接文档作为首条 user message
    const handoffResource: ContextResource = {
      id: `handoff_${handoff.handoffId}`,
      type: 'user_message',
      role: 'user',
      content: this.formatHandoffAsUserMessage(handoff),
      timestamp: Date.now(),
      dependencies: [],
      meta: {
        _compressionLevel: 5,
        _isHandoff: true,
        _originalSessionId: sessionKey,
      },
      pinned: true,
    };

    // 保留原始 system message
    const systemMessages = resources.filter(r => r.type === 'system_message');

    const result = [...systemMessages, handoffResource];

    const telemetry: CompressionTelemetry = {
      level: 'L5',
      action: 'new_session_handoff',
      beforeTokens: this.estimator.estimateAll(resources),
      afterTokens: this.estimator.estimateAll(result),
      resourcesAffected: resources.length,
      triggerReason: handoff.reason,
      cachePreserved: false,
      compressionDepth: safety.compressionDepth + 1,
    };

    safety.compressionDepth++;
    safety.circuitBreakerTripped = true;
    safety.handoffCompleted = true;

    return { resources: result, telemetry: [telemetry], handoff };
  }

  /** Fork Agent: 生成交接文档 */
  private async forkHandoff(
    allContext: string,
    safety: CompressionSafetyState,
  ): Promise<string | null> {
    const forkModel = this.config.forkModel
      ? this.lookupModel(this.config.forkModel)
      : this.model;

    const context: Context = {
      systemPrompt: L5_HANDOFF_PROMPT,
      messages: [{
        role: 'user',
        content: `为以下对话生成交接文档：\n\n${allContext}`,
        timestamp: Date.now(),
      }],
    };

    try {
      const result = await this.streamFn(forkModel, context, {
        signal: safety.abortSignal,
      });
      let output = '';
      for await (const event of result) {
        if (event.type === 'text') output += event.text;
      }
      return output || null;
    } catch {
      return null;
    }
  }

  /** 将交接文档格式化为新会话的首条用户消息 */
  private formatHandoffAsUserMessage(handoff: SessionHandoff): string {
    return `## Session Handoff

This session was continued from a previous session that exceeded context limits.

**Original Session:** ${handoff.originalSessionId}
**Handoff Time:** ${new Date(handoff.timestamp).toISOString()}
**Reason:** ${handoff.reason}

---

${handoff.handoffDocument}

---

${handoff.checkpointId
  ? `**Note:** Full context from the previous session is available as checkpoint \`${handoff.checkpointId}\`. `
  : ''}Please continue the task based on the information above.`;
  }

  /** Fork 失败时的硬编码兜底 */
  private fallbackHandoff(
    resources: ContextResource[],
    safety: CompressionSafetyState,
    sessionKey: string,
  ): { resources: ContextResource[]; telemetry: CompressionTelemetry[]; handoff: SessionHandoff } {
    // 提取最后的用户消息和 task_state
    const lastUserMsg = [...resources].reverse().find(r => r.type === 'user_message');
    const taskState = this.findTaskState(resources);

    const handoffDoc = `## Fallback Handoff

Original request: ${taskState?.originalRequest ?? extractTextFromResource(lastUserMsg!)}

Completed steps:
${taskState?.completedSteps.map(s => `- ${s}`).join('\n') ?? '- (unknown)'}

Pending steps:
${taskState?.pendingSteps.map(s => `- ${s}`).join('\n') ?? '- (unknown)'}

Please continue from where the previous session left off.`;

    const handoff: SessionHandoff = {
      handoffId: `handoff_fallback_${Date.now()}`,
      originalSessionId: sessionKey,
      newSessionId: `${sessionKey}_h${Date.now()}`,
      timestamp: Date.now(),
      handoffDocument: handoffDoc,
      taskState,
      checkpointId: safety.checkpointId,
      compactionSummary: 'fallback - no compaction history available',
      reason: 'fallback_handoff',
    };

    const systemMessages = resources.filter(r => r.type === 'system_message');
    const handoffResource: ContextResource = {
      id: `handoff_${handoff.handoffId}`,
      type: 'user_message',
      role: 'user',
      content: this.formatHandoffAsUserMessage(handoff),
      timestamp: Date.now(),
      dependencies: [],
      meta: { _compressionLevel: 5, _isHandoff: true, _fallback: true },
      pinned: true,
    };

    const result = [...systemMessages, handoffResource];
    safety.circuitBreakerTripped = true;

    return {
      resources: result,
      telemetry: [{
        level: 'L5',
        action: 'fallback_handoff',
        beforeTokens: this.estimator.estimateAll(resources),
        afterTokens: this.estimator.estimateAll(result),
        resourcesAffected: resources.length,
        triggerReason: 'fork_failure_fallback',
        cachePreserved: false,
        compressionDepth: safety.compressionDepth + 1,
      }],
      handoff,
    };
  }
}

const L5_HANDOFF_PROMPT = `You are a session handoff agent.
A previous agent session has exhausted its context window after multiple compression attempts.
Generate a concise handoff document that allows a fresh session to continue the task seamlessly.

The handoff document MUST include:
1. **Original Task**: What the user originally asked for
2. **What Was Done**: Summary of completed work and key results
3. **Current State**: Where the task currently stands
4. **What Remains**: Specific next steps to complete the task
5. **Critical Context**: Any constraints, decisions, or facts that must be preserved
6. **Errors/Issues**: Any errors encountered that the new session should be aware of

Be concise but complete. The new session will have NO other context besides this document.`;
```

### 交接后行为
- 旧会话标记为 `archived`，可通过 `checkpointId` 恢复
- 新会话以交接文档作为首条 user message 开始
- 断路器触发：`safety.circuitBreakerTripped = true`，冷却 5 轮内不再尝试压缩

---

## 八、安全机制

```typescript
// compression/safety.ts

export interface CompressionSafetyState {
  /** 当前压缩深度（防止递归压缩） */
  compressionDepth: number;
  /** 本轮压缩尝试次数 */
  attemptCount: number;
  /** 断路器是否已触发 */
  circuitBreakerTripped: boolean;
  /** 冷却期剩余轮次 */
  cooldownRemaining: number;
  /** 中止信号 */
  abortSignal?: AbortSignal;
  /** 是否已创建检查点（L4） */
  hasCheckpoint: boolean;
  /** 检查点 ID */
  checkpointId?: string;
  /** 是否已完成会话交接（L5） */
  handoffCompleted: boolean;
  /** 压缩历史记录（用于遥测和交接） */
  telemetryHistory: CompressionTelemetry[];
}

export class CompressionSafetyGuard {
  constructor(private config: SafetyConfig) {}

  /** 检查是否允许执行压缩 */
  canCompress(state: CompressionSafetyState): boolean {
    if (state.handoffCompleted) return false;  // 已交接，不再压缩
    if (state.circuitBreakerTripped) {
      if (state.cooldownRemaining > 0) {
        state.cooldownRemaining--;
        return false;
      }
      // 冷却结束，重置断路器
      state.circuitBreakerTripped = false;
      state.attemptCount = 0;
    }
    if (state.attemptCount >= this.config.maxAttempts) {
      state.cooldownRemaining = this.config.cooldownTurns;
      return false;
    }
    return true;
  }

  /** 验证工具配对完整性 */
  validateToolPairing(resources: ContextResource[]): boolean {
    const toolCallIds = new Set<string>();
    const toolResultIds = new Set<string>();

    for (const r of resources) {
      if (r.type === 'tool_call') toolCallIds.add(r.id);
      if (r.type === 'tool_result') {
        for (const dep of r.dependencies) toolResultIds.add(dep);
      }
    }

    for (const depId of toolResultIds) {
      if (!toolCallIds.has(depId)) return false;
    }
    for (const callId of toolCallIds) {
      if (!toolResultIds.has(callId)) return false;
    }
    return true;
  }

  /** 验证 message.id 不可分离性 */
  validateMessageIntegrity(
    before: ContextResource[],
    after: ContextResource[],
  ): boolean {
    const beforeGroups = this.groupByMessageId(before);
    const afterGroups = this.groupByMessageId(after);

    for (const [msgId, group] of afterGroups) {
      const beforeGroup = beforeGroups.get(msgId);
      if (beforeGroup && beforeGroup.length !== group.length) {
        return false;
      }
    }
    return true;
  }

  private groupByMessageId(resources: ContextResource[]): Map<string, ContextResource[]> {
    const groups = new Map<string, ContextResource[]>();
    for (const r of resources) {
      const groupId = r.meta.toolCallId
        ? r.meta.toolCallId as string
        : r.id;
      if (!groups.has(groupId)) groups.set(groupId, []);
      groups.get(groupId)!.push(r);
    }
    return groups;
  }
}
```

---

## 九、复合转换器：五级协调

```typescript
// compression/index.ts

export class ContextCompressionTransformer extends BaseTransformer {
  readonly name = 'context-compression';

  constructor(
    private estimator: TokenEstimator,
    private l1: ToolOutputTrim,
    private l2: MessageSummarize,
    private l3: TaskStateExtraction,
    private l4: SessionCheckpointLevel,
    private l5: NewSessionHandoff,
    private safetyGuard: CompressionSafetyGuard,
    private config: CompressionConfig,
    private contextWindow: number,
  ) {
    super({ priority: 40 });
  }

  protected async run(
    resources: ContextResource[],
    context: TransformContext,
  ): Promise<ContextResource[]> {
    if (!this.config.enabled) return resources;

    const safetyState = this.loadOrCreateState(context);
    if (!this.safetyGuard.canCompress(safetyState)) return resources;

    let current = resources;
    const allTelemetry: CompressionTelemetry[] = [];
    const currentTokens = this.estimator.estimateAll(current);

    // ── L1: 工具输出裁剪 ──
    if (currentTokens > this.contextWindow * this.config.l1.threshold) {
      const result = await this.l1.compress(current, this.contextWindow);
      current = result.resources;
      allTelemetry.push(...result.telemetry);
      safetyState.attemptCount++;
    }

    // ── L2: 旧消息摘要 ──
    if (this.estimator.estimateAll(current) > this.contextWindow * this.config.l2.threshold) {
      const result = await this.l2.compress(current, this.contextWindow, safetyState);
      current = result.resources;
      allTelemetry.push(...result.telemetry);
      safetyState.attemptCount++;
    }

    // ── L3: 任务状态提取 ──
    if (this.estimator.estimateAll(current) > this.contextWindow * this.config.l3.threshold) {
      const result = await this.l3.compress(current, this.contextWindow, safetyState);
      current = result.resources;
      allTelemetry.push(...result.telemetry);
      safetyState.attemptCount++;
    }

    // ── L4: 会话检查点 ──
    if (this.estimator.estimateAll(current) > this.contextWindow * this.config.l4.threshold) {
      const result = await this.l4.compress(
        current, this.contextWindow, safetyState, context.runtime.sessionKey,
      );
      current = result.resources;
      allTelemetry.push(...result.telemetry);
      safetyState.attemptCount++;
    }

    // ── L5: 新会话交接 ──
    if (this.estimator.estimateAll(current) > this.contextWindow * this.config.l5.threshold) {
      const result = await this.l5.compress(
        current, this.contextWindow, safetyState, context.runtime.sessionKey,
      );
      current = result.resources;
      allTelemetry.push(...result.telemetry);
      safetyState.attemptCount++;
    }

    // ── 安全验证 ──
    if (!this.safetyGuard.validateToolPairing(current)) {
      current = resources;  // 配对被破坏，回退
    }

    // ── 遥测上报 ──
    safetyState.telemetryHistory.push(...allTelemetry);
    for (const t of allTelemetry) {
      this.emitTelemetry(t, context);
    }

    return current;
  }

  private loadOrCreateState(context: TransformContext): CompressionSafetyState {
    const key = `safety_${context.runtime.sessionKey}`;
    const existing = (context.runtime.config as any)?.[key];
    if (existing) return existing;

    return {
      compressionDepth: 0,
      attemptCount: 0,
      circuitBreakerTripped: false,
      cooldownRemaining: 0,
      hasCheckpoint: false,
      handoffCompleted: false,
      telemetryHistory: [],
    };
  }
}
```

---

## 十、配置系统

```typescript
// compression/config.ts

export interface CompressionConfig {
  enabled: boolean;

  // Token 估算
  estimator: 'char-heuristic' | 'tiktoken';
  charsPerToken: { ascii: number; cjk: number };

  // L1: 工具输出裁剪
  l1: {
    enabled: boolean;
    threshold: number;            // 0.60
    targetRatio: number;          // 0.50
    stripThinking: boolean;
    trimToolResults: boolean;
    toolResultMaxLines: number;   // 50
    toolResultHeadLines: number;  // 10
    toolResultTailLines: number;  // 10
    normalizeWhitespace: boolean;
  };

  // L2: 旧消息摘要
  l2: {
    enabled: boolean;
    threshold: number;            // 0.75
    targetRatio: number;          // 0.60
    forkModel?: string;
    forkMaxTokens: number;        // 2048
    minResourcesToCompress: number; // 4
    protectedRecentCount: number;   // 6
    maxCompressionDepth: number;    // 3
  };

  // L3: 任务状态提取
  l3: {
    enabled: boolean;
    threshold: number;            // 0.85
    targetRatio: number;          // 0.40
    forkModel?: string;
    forkMaxTokens: number;        // 1024
    protectedRecentCount: number; // 4
  };

  // L4: 会话检查点
  l4: {
    enabled: boolean;
    threshold: number;            // 0.92
    targetRatio: number;          // 0.25
    checkpointStorage: 'file' | 'memory' | 'custom';
    minWorkingSet: number;        // 2
  };

  // L5: 新会话交接
  l5: {
    enabled: boolean;
    threshold: number;            // 0.95
    forkModel?: string;
    forkMaxTokens: number;        // 2048
  };

  // 安全
  safety: {
    maxAttempts: number;          // 5 - 每级算一次
    cooldownTurns: number;         // 5
  };

  // 遥测
  telemetry: {
    enabled: boolean;
    logTokenDelta: boolean;
    logTriggerReason: boolean;
    logRetryCount: boolean;
  };
}

/** 从环境变量加载配置 */
export function loadCompressionConfig(
  overrides?: Partial<CompressionConfig>,
): CompressionConfig {
  const env = process.env;
  return {
    enabled: env.AGENTPACK_COMPRESSION_ENABLED !== 'false',
    estimator: (env.AGENTPACK_COMPRESSION_ESTIMATOR as any) ?? 'char-heuristic',
    charsPerToken: {
      ascii: Number(env.AGENTPACK_CHARS_PER_TOKEN_ASCII) || 4,
      cjk: Number(env.AGENTPACK_CHARS_PER_TOKEN_CJK) || 1.5,
    },
    l1: {
      enabled: env.AGENTPACK_L1_ENABLED !== 'false',
      threshold: Number(env.AGENTPACK_L1_THRESHOLD) || 0.60,
      targetRatio: Number(env.AGENTPACK_L1_TARGET) || 0.50,
      stripThinking: env.AGENTPACK_L1_STRIP_THINKING !== 'false',
      trimToolResults: env.AGENTPACK_L1_TRIM_TOOL_RESULTS !== 'false',
      toolResultMaxLines: Number(env.AGENTPACK_L1_TOOL_MAX_LINES) || 50,
      toolResultHeadLines: Number(env.AGENTPACK_L1_TOOL_HEAD_LINES) || 10,
      toolResultTailLines: Number(env.AGENTPACK_L1_TOOL_TAIL_LINES) || 10,
      normalizeWhitespace: env.AGENTPACK_L1_NORMALIZE_WS !== 'false',
    },
    l2: {
      enabled: env.AGENTPACK_L2_ENABLED !== 'false',
      threshold: Number(env.AGENTPACK_L2_THRESHOLD) || 0.75,
      targetRatio: Number(env.AGENTPACK_L2_TARGET) || 0.60,
      forkModel: env.AGENTPACK_L2_FORK_MODEL,
      forkMaxTokens: Number(env.AGENTPACK_L2_FORK_MAX_TOKENS) || 2048,
      minResourcesToCompress: Number(env.AGENTPACK_L2_MIN_RESOURCES) || 4,
      protectedRecentCount: Number(env.AGENTPACK_L2_PROTECTED_RECENT) || 6,
      maxCompressionDepth: Number(env.AGENTPACK_L2_MAX_DEPTH) || 3,
    },
    l3: {
      enabled: env.AGENTPACK_L3_ENABLED !== 'false',
      threshold: Number(env.AGENTPACK_L3_THRESHOLD) || 0.85,
      targetRatio: Number(env.AGENTPACK_L3_TARGET) || 0.40,
      forkModel: env.AGENTPACK_L3_FORK_MODEL,
      forkMaxTokens: Number(env.AGENTPACK_L3_FORK_MAX_TOKENS) || 1024,
      protectedRecentCount: Number(env.AGENTPACK_L3_PROTECTED_RECENT) || 4,
    },
    l4: {
      enabled: env.AGENTPACK_L4_ENABLED !== 'false',
      threshold: Number(env.AGENTPACK_L4_THRESHOLD) || 0.92,
      targetRatio: Number(env.AGENTPACK_L4_TARGET) || 0.25,
      checkpointStorage: (env.AGENTPACK_L4_STORAGE as any) ?? 'file',
      minWorkingSet: Number(env.AGENTPACK_L4_MIN_WORKING_SET) || 2,
    },
    l5: {
      enabled: env.AGENTPACK_L5_ENABLED !== 'false',
      threshold: Number(env.AGENTPACK_L5_THRESHOLD) || 0.95,
      forkModel: env.AGENTPACK_L5_FORK_MODEL,
      forkMaxTokens: Number(env.AGENTPACK_L5_FORK_MAX_TOKENS) || 2048,
    },
    safety: {
      maxAttempts: Number(env.AGENTPACK_COMPRESSION_MAX_ATTEMPTS) || 5,
      cooldownTurns: Number(env.AGENTPACK_COMPRESSION_COOLDOWN_TURNS) || 5,
    },
    telemetry: {
      enabled: env.AGENTPACK_COMPRESSION_TELEMETRY !== 'false',
      logTokenDelta: true,
      logTriggerReason: true,
      logRetryCount: true,
    },
    ...overrides,
  };
}
```

---

## 十一、遥测系统

```typescript
// compression/telemetry.ts

export interface CompressionTelemetry {
  timestamp: number;
  sessionKey: string;
  turn: number;
  level: 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
  action: string;
  beforeTokens: number;
  afterTokens: number;
  tokenDelta: number;
  resourcesAffected: number;
  triggerReason: string;
  retryCount: number;
  cachePreserved: boolean;
  compressionDepth: number;
  duration: number;
}

export class CompressionTelemetryExtension implements Extension {
  readonly name = 'compression-telemetry';

  apply(hooks: RuntimeHooks, context: ExtensionContext): void {
    hooks.afterTransform.tap('compression-telemetry', async (resources) => {
      const telemetry = (context.shared.get('compression_telemetry') as CompressionTelemetry[]) ?? [];
      if (telemetry.length === 0) return resources;

      for (const t of telemetry) {
        this.report(t);
      }
      context.shared.delete('compression_telemetry');
      return resources;
    });
  }

  private report(t: CompressionTelemetry): void {
    console.log(JSON.stringify({
      event: 'tengu_compact',
      level: t.level,
      action: t.action,
      beforeTokens: t.beforeTokens,
      afterTokens: t.afterTokens,
      tokenDelta: t.beforeTokens - t.afterTokens,
      reductionRatio: t.beforeTokens > 0
        ? ((t.beforeTokens - t.afterTokens) / t.beforeTokens).toFixed(4)
        : 0,
      triggerReason: t.triggerReason,
      cachePreserved: t.cachePreserved,
      compressionDepth: t.compressionDepth,
      duration: t.duration,
    }));
  }
}
```

---

## 十二、文件结构

```
packages/agentpack/compression/
  config.ts                       - CompressionConfig + env var 加载
  token-estimator.ts              - Token 估算（char heuristic / tiktoken）
  l1-tool-output-trim.ts          - L1: 工具输出裁剪
  l2-message-summarize.ts         - L2: 旧消息摘要（Fork Agent）
  l3-task-state-extraction.ts     - L3: 任务状态提取（结构化降级）
  l4-session-checkpoint.ts        - L4: 会话检查点（持久化 + 激进缩减）
  l5-new-session-handoff.ts       - L5: 新会话交接（保底重置）
  safety.ts                       - 安全守卫: 配对验证 + 递归保护 + 断路器
  telemetry.ts                    - 埋点: CompressionTelemetry + Extension
  index.ts                        - 复合转换器 + 工厂函数
```

---

## 十三、集成方式

在 `transformer/index.ts` 的 `createDefaultTransformers` 工厂中接入：

```typescript
export function createDefaultTransformers(options?: {
  getStateSnapshot?: () => string | null;
  maxResources?: number;
  model?: Model;
  streamFn?: StreamFn;
  sessionStorage?: SessionStorage;
  compressionConfig?: Partial<CompressionConfig>;
}): ContextTransformer[] {
  const transformers: ContextTransformer[] = [
    new ToolPairingTransformer(),
    new SystemMessageCleanerTransformer(),
  ];

  if (options?.getStateSnapshot) {
    transformers.push(new StateSnapshotTransformer(options.getStateSnapshot));
  }

  // ── 新增：五级上下文压缩 ──
  if (options?.model) {
    const config = loadCompressionConfig(options?.compressionConfig);
    if (config.enabled) {
      transformers.push(createCompressionTransformer({
        config,
        model: options.model,
        streamFn: options.streamFn,
        sessionStorage: options.sessionStorage,
        contextWindow: options.model.contextWindow,
      }));
    }
  }

  transformers.push(new TruncationTransformer(options?.maxResources ?? 200));
  return transformers;
}
```

---

## 十四、安全保证总结

| 安全规则 | 实现位置 | 机制 |
|---------|---------|------|
| **不切断 tool_use/tool_result 配对** | L4/L5 `findPairIds()` | 丢弃时同时移除配对的两个资源 |
| **不分离共享 message.id 的块** | `SafetyGuard.validateMessageIntegrity()` | 后验证，不通过则回退 |
| **防止递归压缩** | L2 入口检查 `compressionDepth >= maxDepth` | 深度计数器，默认 maxDepth=3 |
| **断路器** | `SafetyGuard.canCompress()` + L5 触发 | maxAttempts=5，触发后冷却 5 轮 |
| **最小上下文保证** | L4 `buildMinimalWorkingSet()` | 永远保留 system + task_state + 最近 2 条 |
| **信息可恢复** | L4 检查点持久化 | 完整消息快照写入 SessionStorage |
| **缓存前缀保护** | L1 尾部优先 + L2 前缀保留 | L1/L2 不破坏缓存；L3+ 标记 `cachePreserved: false` |

---

## 十五、设计哲学映射

### 1. 渐进式降级（Progressive Degradation）

| 级别 | 操作 | 信息损耗 | 代价 | 可恢复性 |
|------|------|---------|------|---------|
| L1 | thinking 剥离 + tool_result 裁剪 | 无损 | O(n) 字符扫描 | N/A（无损） |
| L2 | Fork Agent 摘要替换旧消息 | 有损（语义保留） | 1 次 LLM 调用 | 不可恢复 |
| L3 | 结构化任务状态提取 | 有损（叙事丢失） | 1 次 LLM 调用 | 不可恢复 |
| L4 | 检查点持久化 + 激进缩减 | 有损（可恢复） | 1 次写入 + 0 LLM | **可恢复**（检查点） |
| L5 | 新会话交接 + 旧会话归档 | 高损耗 | 1 次 LLM + 1 次写入 | **可恢复**（归档） |

### 2. 缓存优先（Cache-First）

- **L1**：所有操作从尾部向头部扫描，前缀缓存完全不变
- **L2**：Fork Agent 与主对话共享 provider/baseUrl；摘要插入在缓存前缀之后
- **L3**：上下文重建，标记 `cachePreserved: false`
- **L4/L5**：缓存完全失效，但已通过检查点/归档保证信息不丢

### 3. 严格的安全性与配对保证

- `tool_use` / `tool_result` 逻辑配对通过 `dependencies` 字段追踪，丢弃时成对移除
- 共享 `message.id` 的消息块通过 `validateMessageIntegrity()` 后验证
- 断路器：`maxAttempts=5`，触发后冷却 `cooldownTurns=5` 轮
- 递归保护：`compressionDepth` 计数器，`maxCompressionDepth=3`
- L4 检查点确保即使激进缩减，信息也可恢复

### 4. 高度的可观测性与可配置性

- **所有阈值**支持环境变量覆盖（`AGENTPACK_L1_*` ~ `AGENTPACK_L5_*` 前缀）
- **动态调整**可通过 `compressionConfig` 参数运行时注入
- **每个压缩动作埋点**：包含 `level` / `beforeTokens` / `afterTokens` / `triggerReason` / `cachePreserved` / `compressionDepth`
- L4/L5 额外记录 `checkpointId` / `handoffId` 用于可恢复性追踪

---

## 十六、与现有架构的契合点

| 现有基础设施 | 压缩策略复用方式 |
|------------|----------------|
| `ContextResource.pinned` | 标记 compaction_summary、task_state、checkpoint_ref、handoff 为不可移除 |
| `ContextResource.dependencies` | 追踪 tool_call ↔ tool_result 配对关系 |
| `ContextResource.type: 'compaction_summary'` | L2 摘要的落点（已定义未使用） |
| `ContextResource.type: 'custom'` + `role` | L3 task_state、L4 checkpoint_ref、L5 handoff 均使用 custom 类型 |
| `BaseTransformer` + `Pipeline` | 复合转换器以 priority=40 插入 |
| `Model.contextWindow` | 提供 token 上限基准 |
| `StreamFn` | L2/L3/L5 Fork Agent 复用同一流式接口 |
| `SessionStorage` | L4 检查点持久化的天然存储层 |
| `Extension.afterTransform` hook | 遥测上报的集成点 |
| `TransformContext.runtime.config` | 传递安全状态（绕过 meta round-trip 丢失） |
| `TruncationTransformer`（priority=90） | 作为最终兜底，位于所有压缩之后 |
