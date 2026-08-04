# AgentPack 多级上下文压缩策略设计

## 一、架构总览

压缩系统作为**单个复合转换器** `ContextCompressionTransformer`（priority=40）插入现有 Pipeline，内部按序执行三级降级。这样避免了多转换器间的状态传递问题（`meta` 在 round-trip 中丢失），同时保持 Pipeline 的单一职责。

```
现有 Pipeline（按 priority 排序）:
  10  ToolPairingTransformer          ← 已有：清理孤立 tool_call/tool_result
  20  SystemMessageCleanerTransformer  ← 已有：保留最后一条 system message
  30  StateSnapshotTransformer         ← 已有：注入状态快照（pinned）
  40  ContextCompressionTransformer    ← 新增：三级复合压缩
       ├─ Level 0: MicroCompaction     （无损微压缩，缓存安全）
       ├─ Level 1: SummaryCompaction   （有损摘要压缩，Fork Agent）
       └─ Level 2: PTLRecovery         （保底丢弃，断路器保护）
  90  TruncationTransformer            ← 已有：按数量截断（最终兜底）
```

**核心设计原则**：每一级仅在前一级不足以将 token 用量降至阈值以下时才触发。级别之间通过复合转换器内部的共享状态直接传递，无需依赖 `meta` round-trip。

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
    const imageTokens = hasImage ? 1500 : 0;  // 单张图约 1500 token

    const total = tokens + imageTokens;
    this.cache.set(resource.id, total);
    return total;
  }

  estimateAll(resources: ContextResource[]): number {
    return resources.reduce((sum, r) => sum + this.estimate(r), 0);
  }
}
```

**策略**：默认使用字符启发式（零依赖、O(n) 复杂度），可配置切换为 `tiktoken`（OpenAI 模型）或 Anthropic tokenizer。估算结果按 `resource.id` 缓存，避免重复计算。

---

## 三、Level 0 - 微压缩（MicroCompaction）

### 目标
无损或极低损耗操作，专门设计为**不破坏 Prompt Cache 前缀**。

### 触发条件
`estimatedTokens > contextWindow × microThreshold`（默认 0.60）

### 缓存安全设计
所有操作只从**上下文尾部**（最近的消息）向头部扫描，一旦释放足够 token 即停止。这确保缓存前缀完全不变，下次 API 调用仍命中缓存。

```typescript
// compression/micro-compaction.ts

export class MicroCompaction {
  constructor(
    private estimator: TokenEstimator,
    private config: MicroCompactionConfig,
  ) {}

  async compress(
    resources: ContextResource[],
    contextWindow: number,
  ): Promise<{ resources: ContextResource[]; telemetry: CompressionTelemetry[] }> {
    const target = contextWindow * this.config.targetRatio; // 降至 50% 以下
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

## 四、Level 1 - 摘要压缩（SummaryCompaction）

### 目标
当微压缩不足以降级时，通过 Fork Agent 生成摘要替换旧消息块。

### 触发条件
Level 0 执行后 `estimatedTokens > contextWindow × summaryThreshold`（默认 0.75）

### Fork Agent 机制

```typescript
// compression/summary-compaction.ts

export class SummaryCompaction {
  constructor(
    private estimator: TokenEstimator,
    private streamFn: StreamFn,      // 复用 runtime 的 streamFn
    private model: Model,            // 可配置使用更便宜的模型
    private config: SummaryCompactionConfig,
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
    const protectedCount = this.config.protectedRecentCount; // 默认 6
    const compressible = this.identifyCompressible(resources, protectedCount);

    if (compressible.length < this.config.minResourcesToCompress) {
      return { resources, telemetry: [] };
    }

    // ── 提取文本 ──
    const transcript = compressible
      .map(r => this.formatResourceForSummary(r))
      .join('\n\n');

    // ── Fork Agent: 发起摘要请求 ──
    const summary = await this.forkSummarize(transcript, safety);

    if (!summary) {
      return { resources, telemetry: [] };
    }

    // ── 构建 compaction_summary 资源 ──
    const summaryResource: ContextResource = {
      id: `compaction_${Date.now()}`,
      type: 'compaction_summary',
      role: 'system',
      content: summary,
      timestamp: Date.now(),
      dependencies: [],
      meta: {
        _compressionDepth: safety.compressionDepth + 1,
        _sourceCount: compressible.length,
        _sourceRange: `${compressible[0].id}..${compressible[compressible.length - 1].id}`,
      },
      pinned: true,  // 摘要不可被后续压缩移除
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
      level: 'summary',
      action: 'fork_summarize',
      beforeTokens: this.estimator.estimateAll(resources),
      afterTokens: this.estimator.estimateAll(result),
      resourcesAffected: compressible.length,
      triggerReason: 'threshold_exceeded',
      cachePreserved: prefixEnd > 0,  // 前缀保留则缓存有效
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

    // 构建工具配对图
    const toolPairIds = this.buildToolPairIds(resources);

    return resources.filter(r => {
      if (r.pinned) return false;
      if (recentIds.has(r.id)) return false;
      if (r.type === 'compaction_summary') return false;  // 已有摘要不压缩
      // 不完整的工具对跳过
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
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `请将以下对话历史压缩为结构化摘要，保留：\n`
               + `1. 用户的核心意图与决策\n`
               + `2. 关键的工具调用及其结果（成功/失败）\n`
               + `3. 已确定的事实和约束条件\n`
               + `4. 待完成的任务状态\n\n`
               + `对话历史：\n${transcript}`,
        timestamp: Date.now(),
      }],
    };

    try {
      const result = await this.streamFn(forkModel, context, {
        signal: safety.abortSignal,
      });
      // 收集流式输出
      let summary = '';
      for await (const event of result) {
        if (event.type === 'text') summary += event.text;
      }
      return summary || null;
    } catch {
      return null;  // Fork 失败时降级到 Level 2
    }
  }
}

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context compression agent.
Summarize the conversation history into a concise, structured summary that
preserves all critical information for continued task execution.
Output in the following format:

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
- Fork Agent 使用与主对话相同的 `provider` 和 `baseUrl`，使得 API 端的缓存前缀可以共享
- 摘要替换位置在**前缀之后**，主对话的缓存前缀（system prompt + 早期消息）完全不变
- `compaction_summary` 资源被 `pinned: true`，不会被后续压缩移除

---

## 五、Level 2 - PTL Recovery（保底丢弃）

### 目标
当摘要压缩仍不足时的最后防线，按优先级丢弃整个资源块。

### 触发条件
Level 1 执行后 `estimatedTokens > contextWindow × ptlThreshold`（默认 0.90）

```typescript
// compression/ptl-recovery.ts

export class PTLRecovery {
  constructor(
    private estimator: TokenEstimator,
    private config: PTLRecoveryConfig,
  ) {}

  async compress(
    resources: ContextResource[],
    contextWindow: number,
    safety: CompressionSafetyState,
  ): Promise<{ resources: ContextResource[]; telemetry: CompressionTelemetry[] }> {
    const target = contextWindow * this.config.targetRatio; // 降至 80% 以下
    let current = [...resources];
    let currentTokens = this.estimator.estimateAll(current);
    const telemetry: CompressionTelemetry[] = [];

    if (currentTokens <= target) return { resources: current, telemetry };

    // ── 按丢弃优先级排序（最低价值优先丢弃） ──
    const dropOrder = this.config.dropOrder ?? [
      'tool_result',       // 冗长工具结果最先丢（已在摘要中）
      'tool_call',         // 配对的 tool_call 一起丢
      'user_message',      // 旧用户消息
      'assistant_message', // 旧助手消息
      // 永不丢弃: system_message, state_snapshot, compaction_summary
    ];

    // ── 保护最近 N 条消息 + pinned + 工具对完整性 ──
    const protectedSet = this.buildProtectedSet(current);

    for (const dropType of dropOrder) {
      for (let i = 0; i < current.length && currentTokens > target; i++) {
        const r = current[i];
        if (r.type !== dropType || protectedSet.has(r.id)) continue;

        // 工具配对检查：必须同时丢弃 tool_call + tool_result
        const pairIds = this.findPairIds(r, current);
        const toRemove = pairIds.size > 0
          ? current.filter(x => pairIds.has(x.id) || x === r)
          : [r];

        // 检查移除后不会留下孤立配对
        if (this.wouldCreateOrphan(r, current)) continue;

        const beforeTokens = currentTokens;
        current = current.filter(x => !toRemove.includes(x));
        currentTokens = this.estimator.estimateAll(current);

        telemetry.push({
          level: 'ptl',
          action: 'drop_resource',
          beforeTokens,
          afterTokens: currentTokens,
          resourcesAffected: toRemove.length,
          triggerReason: 'ptl_recovery',
          cachePreserved: i > 0,  // 非首条丢弃则前缀仍有效
        });
      }
    }

    // ── 断路器：如果仍然超限，硬截断 ──
    if (currentTokens > contextWindow * 0.95) {
      const keepCount = this.config.minKeepCount;
      const pinned = current.filter(r => r.pinned);
      const unpinned = current.filter(r => !r.pinned);
      const kept = unpinned.slice(-Math.max(keepCount - pinned.length, 0));
      current = [...pinned, ...kept].sort((a, b) => a.timestamp - b.timestamp);

      telemetry.push({
        level: 'ptl',
        action: 'hard_truncate',
        beforeTokens: currentTokens,
        afterTokens: this.estimator.estimateAll(current),
        resourcesAffected: current.length,
        triggerReason: 'circuit_breaker',
        cachePreserved: false,
      });

      safety.circuitBreakerTripped = true;
    }

    return { resources: current, telemetry };
  }

  /** 构建不可丢弃集合：pinned + 最近 N 条 + compaction_summary */
  private buildProtectedSet(resources: ContextResource[]): Set<string> {
    const protectedSet = new Set<string>();
    const recent = resources.slice(-this.config.minKeepCount);
    for (const r of recent) protectedSet.add(r.id);
    for (const r of resources) {
      if (r.pinned || r.type === 'compaction_summary') {
        protectedSet.add(r.id);
      }
    }
    return protectedSet;
  }
}
```

---

## 六、安全机制

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
}

export class CompressionSafetyGuard {
  constructor(private config: SafetyConfig) {}

  /** 检查是否允许执行压缩 */
  canCompress(state: CompressionSafetyState): boolean {
    if (state.circuitBreakerTripped) return false;
    if (state.cooldownRemaining > 0) {
      state.cooldownRemaining--;
      return false;
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

    // 每个 tool_result 的依赖必须在 tool_call 中存在
    for (const depId of toolResultIds) {
      if (!toolCallIds.has(depId)) return false;
    }
    // 每个 tool_call 应有对应的 tool_result（除非在最近保护区内）
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
    // 同一 message.id 的资源块必须整体保留或整体移除
    const beforeGroups = this.groupByMessageId(before);
    const afterGroups = this.groupByMessageId(after);

    for (const [msgId, group] of afterGroups) {
      const beforeGroup = beforeGroups.get(msgId);
      if (beforeGroup && beforeGroup.length !== group.length) {
        return false; // 部分移除，违反完整性
      }
    }
    return true;
  }

  private groupByMessageId(resources: ContextResource[]): Map<string, ContextResource[]> {
    const groups = new Map<string, ContextResource[]>();
    for (const r of resources) {
      // msg_0 -> assistant message; msg_0_result -> tool result
      // 但它们共享 toolCallId 关系，应作为一组
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

## 七、复合转换器：三级协调

```typescript
// compression/index.ts

export class ContextCompressionTransformer extends BaseTransformer {
  readonly name = 'context-compression';

  constructor(
    private estimator: TokenEstimator,
    private micro: MicroCompaction,
    private summary: SummaryCompaction,
    private ptl: PTLRecovery,
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

    const safetyState: CompressionSafetyState = this.loadOrCreateState(context);
    if (!this.safetyGuard.canCompress(safetyState)) return resources;

    const beforeTokens = this.estimator.estimateAll(resources);
    let current = resources;
    const allTelemetry: CompressionTelemetry[] = [];

    // ── Level 0: 微压缩 ──
    if (beforeTokens > this.contextWindow * this.config.micro.threshold) {
      const result = await this.micro.compress(current, this.contextWindow);
      current = result.resources;
      allTelemetry.push(...result.telemetry);
    }

    // ── Level 1: 摘要压缩 ──
    if (this.estimator.estimateAll(current) > this.contextWindow * this.config.summary.threshold) {
      const result = await this.summary.compress(current, this.contextWindow, safetyState);
      current = result.resources;
      allTelemetry.push(...result.telemetry);
    }

    // ── Level 2: PTL 丢弃 ──
    if (this.estimator.estimateAll(current) > this.contextWindow * this.config.ptl.threshold) {
      const result = await this.ptl.compress(current, this.contextWindow, safetyState);
      current = result.resources;
      allTelemetry.push(...result.telemetry);
    }

    // ── 安全验证 ──
    if (!this.safetyGuard.validateToolPairing(current)) {
      // 配对被破坏，回退到压缩前状态
      current = resources;
    }

    // ── 遥测上报 ──
    for (const t of allTelemetry) {
      this.emitTelemetry(t, context);
    }

    return current;
  }

  private loadOrCreateState(context: TransformContext): CompressionSafetyState {
    // 通过 runtime.config 或外部 Map 传递状态
    const key = `safety_${context.runtime.sessionKey}`;
    const existing = (context.runtime.config as any)?.[key];
    if (existing) return existing;

    const state: CompressionSafetyState = {
      compressionDepth: 0,
      attemptCount: 0,
      circuitBreakerTripped: false,
      cooldownRemaining: 0,
    };
    return state;
  }
}
```

---

## 八、配置系统

```typescript
// compression/config.ts

export interface CompressionConfig {
  enabled: boolean;

  // Token 估算
  estimator: 'char-heuristic' | 'tiktoken';
  charsPerToken: { ascii: number; cjk: number };

  // Level 0: 微压缩
  micro: {
    enabled: boolean;
    threshold: number;        // 0.60
    targetRatio: number;      // 0.50 - 降至 contextWindow 的 50%
    stripThinking: boolean;
    trimToolResults: boolean;
    toolResultMaxLines: number;
    toolResultHeadLines: number;
    toolResultTailLines: number;
    normalizeWhitespace: boolean;
  };

  // Level 1: 摘要压缩
  summary: {
    enabled: boolean;
    threshold: number;        // 0.75
    targetRatio: number;      // 0.60
    forkModel?: string;       // 可指定更便宜的模型
    forkMaxTokens: number;    // 2048
    minResourcesToCompress: number;  // 4
    protectedRecentCount: number;    // 6
    maxCompressionDepth: number;    // 3
  };

  // Level 2: PTL 丢弃
  ptl: {
    enabled: boolean;
    threshold: number;        // 0.90
    targetRatio: number;      // 0.80
    dropOrder: ResourceType[];
    minKeepCount: number;     // 4
  };

  // 安全
  safety: {
    maxAttempts: number;      // 3
    cooldownTurns: number;     // 5
  };

  // 遥测
  telemetry: {
    enabled: boolean;
    logTokenDelta: boolean;
    logTriggerReason: boolean;
    logRetryCount: boolean;
  };
}

/** 从环境变量加载配置，支持运行时覆盖 */
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
    micro: {
      enabled: env.AGENTPACK_COMPRESSION_MICRO !== 'false',
      threshold: Number(env.AGENTPACK_COMPRESSION_MICRO_THRESHOLD) || 0.60,
      targetRatio: Number(env.AGENTPACK_COMPRESSION_MICRO_TARGET) || 0.50,
      stripThinking: env.AGENTPACK_COMPRESSION_STRIP_THINKING !== 'false',
      trimToolResults: env.AGENTPACK_COMPRESSION_TRIM_TOOL_RESULTS !== 'false',
      toolResultMaxLines: Number(env.AGENTPACK_TOOL_RESULT_MAX_LINES) || 50,
      toolResultHeadLines: Number(env.AGENTPACK_TOOL_RESULT_HEAD_LINES) || 10,
      toolResultTailLines: Number(env.AGENTPACK_TOOL_RESULT_TAIL_LINES) || 10,
      normalizeWhitespace: env.AGENTPACK_COMPRESSION_NORMALIZE_WS !== 'false',
    },
    summary: {
      enabled: env.AGENTPACK_COMPRESSION_SUMMARY !== 'false',
      threshold: Number(env.AGENTPACK_COMPRESSION_SUMMARY_THRESHOLD) || 0.75,
      targetRatio: Number(env.AGENTPACK_COMPRESSION_SUMMARY_TARGET) || 0.60,
      forkModel: env.AGENTPACK_COMPRESSION_FORK_MODEL,
      forkMaxTokens: Number(env.AGENTPACK_COMPRESSION_FORK_MAX_TOKENS) || 2048,
      minResourcesToCompress: Number(env.AGENTPACK_COMPRESSION_MIN_RESOURCES) || 4,
      protectedRecentCount: Number(env.AGENTPACK_COMPRESSION_PROTECTED_RECENT) || 6,
      maxCompressionDepth: Number(env.AGENTPACK_COMPRESSION_MAX_DEPTH) || 3,
    },
    ptl: {
      enabled: env.AGENTPACK_COMPRESSION_PTL !== 'false',
      threshold: Number(env.AGENTPACK_COMPRESSION_PTL_THRESHOLD) || 0.90,
      targetRatio: Number(env.AGENTPACK_COMPRESSION_PTL_TARGET) || 0.80,
      dropOrder: ['tool_result', 'tool_call', 'user_message', 'assistant_message'],
      minKeepCount: Number(env.AGENTPACK_COMPRESSION_MIN_KEEP) || 4,
    },
    safety: {
      maxAttempts: Number(env.AGENTPACK_COMPRESSION_MAX_ATTEMPTS) || 3,
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

## 九、遥测系统

利用现有的 `afterTransform` hook 钩子，在转换完成后上报埋点：

```typescript
// compression/telemetry.ts

export interface CompressionTelemetry {
  timestamp: number;
  sessionKey: string;
  turn: number;
  level: 'micro' | 'summary' | 'ptl';
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

/** 通过 Extension 系统集成遥测 */
export class CompressionTelemetryExtension implements Extension {
  readonly name = 'compression-telemetry';

  apply(hooks: RuntimeHooks, context: ExtensionContext): void {
    // 在 afterTransform 钩子中收集压缩遥测
    hooks.afterTransform.tap('compression-telemetry', async (resources) => {
      const telemetry = (context.shared.get('compression_telemetry') as CompressionTelemetry[]) ?? [];
      if (telemetry.length === 0) return resources;

      for (const t of telemetry) {
        // 发送到可观测性后端（GrowthBook / Datadog / 自建）
        this.report(t);
      }
      context.shared.delete('compression_telemetry');
      return resources;
    });
  }

  private report(t: CompressionTelemetry): void {
    // 结构化日志
    console.log(JSON.stringify({
      event: 'tengu_compact',
      ...t,
      tokenDelta: t.beforeTokens - t.afterTokens,
      reductionRatio: t.beforeTokens > 0
        ? ((t.beforeTokens - t.afterTokens) / t.beforeTokens).toFixed(4)
        : 0,
    }));
  }
}
```

---

## 十、文件结构

```
packages/agentpack/compression/
  config.ts                  - CompressionConfig + env var 加载
  token-estimator.ts         - Token 估算（char heuristic / tiktoken）
  micro-compaction.ts        - Level 0: 无损微压缩
  summary-compaction.ts      - Level 1: Fork Agent 摘要压缩
  ptl-recovery.ts            - Level 2: 保底丢弃 + 断路器
  safety.ts                  - 安全守卫: 配对验证 + 递归保护 + 断路器
  telemetry.ts               - 埋点: CompressionTelemetry + Extension
  index.ts                    - 复合转换器 + 工厂函数
```

---

## 十一、集成方式

在 `transformer/index.ts` 的 `createDefaultTransformers` 工厂中接入：

```typescript
export function createDefaultTransformers(options?: {
  getStateSnapshot?: () => string | null;
  maxResources?: number;
  model?: Model;               // 新增：传入模型信息
  streamFn?: StreamFn;         // 新增：传入流式函数（用于 Fork Agent）
  compressionConfig?: Partial<CompressionConfig>;
}): ContextTransformer[] {
  const transformers: ContextTransformer[] = [
    new ToolPairingTransformer(),
    new SystemMessageCleanerTransformer(),
  ];

  if (options?.getStateSnapshot) {
    transformers.push(new StateSnapshotTransformer(options.getStateSnapshot));
  }

  // ── 新增：上下文压缩 ──
  if (options?.model) {
    const config = loadCompressionConfig(options?.compressionConfig);
    if (config.enabled) {
      transformers.push(createCompressionTransformer({
        config,
        model: options.model,
        streamFn: options.streamFn,
        contextWindow: options.model.contextWindow,
      }));
    }
  }

  transformers.push(new TruncationTransformer(options?.maxResources ?? 200));
  return transformers;
}
```

---

## 十二、降级流程图

```
                    ┌─────────────────┐
                    │  transformMessages()  │
                    │  每 tool-loop 迭代执行   │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  estimateTokens()  │
                    └────────┬────────┘
                             │
              ┌──────────────▼──────────────┐
              │ tokens > ctxWindow × 0.60?  │
              └──────┬───────────┬──────────┘
                     │ Yes       │ No -> 直接返回
              ┌──────▼──────┐
              │  Level 0     │
              │  MicroComp   │
              │  (无损,缓存安全) │
              └──────┬──────┘
                     │
              ┌──────▼──────────────────┐
              │ tokens > ctxWindow × 0.75?│
              └──────┬───────────┬──────┘
                     │ Yes       │ No -> 返回微压缩结果
              ┌──────▼──────┐
              │  Level 1     │
              │  SummaryComp │
              │  (Fork Agent) │
              └──────┬──────┘
                     │
              ┌──────▼──────────────────┐
              │ tokens > ctxWindow × 0.90?│
              └──────┬───────────┬──────┘
                     │ Yes       │ No -> 返回摘要结果
              ┌──────▼──────┐
              │  Level 2     │
              │  PTL Recovery│
              │  (保底丢弃)   │
              └──────┬──────┘
                     │
              ┌──────▼──────────────┐
              │  断路器检查           │
              │  仍超限 -> 硬截断     │
              │  + 标记 circuitBreak  │
              │  + 冷却 5 轮          │
              └─────────────────────┘
```

---

## 十三、安全保证总结

| 安全规则 | 实现位置 | 机制 |
|---------|---------|------|
| **不切断 tool_use/tool_result 配对** | `PTLRecovery.findPairIds()` | 丢弃时同时移除配对的两个资源 |
| **不分离共享 message.id 的块** | `SafetyGuard.validateMessageIntegrity()` | 后验证，不通过则回退 |
| **防止递归压缩** | `SummaryCompaction` 入口检查 `compressionDepth >= maxDepth` | 深度计数器，默认 maxDepth=3 |
| **断路器** | `SafetyGuard.canCompress()` + `PTLRecovery` 硬截断 | maxAttempts=3，触发后冷却 5 轮 |
| **最小上下文保证** | `PTLRecovery.buildProtectedSet()` | 永远保留最近 4 条 + 所有 pinned + compaction_summary |
| **缓存前缀保护** | `MicroCompaction` 尾部优先 + `SummaryCompaction` 前缀保留 | 所有操作从尾部向头部扫描 |

---

## 十四、设计哲学映射

### 1. 渐进式降级（Progressive Degradation）

| 层级 | 操作 | 损耗 | 代价 |
|------|------|------|------|
| Level 0 | thinking 剥离 + tool_result 裁剪 + 空白规范化 | 无损/极低 | O(n) 字符扫描 |
| Level 1 | Fork Agent 摘要替换旧消息块 | 有损（语义保留） | 一次 LLM 调用 |
| Level 2 | 按优先级丢弃资源块 | 有损（信息丢失） | O(n) 过滤 |
| 断路器 | 硬截断 + 冷却 | 高损耗 | O(1) 截断 |

### 2. 缓存优先（Cache-First）

- **Level 0**：所有操作从尾部向头部扫描，前缀缓存完全不变
- **Level 1**：Fork Agent 与主对话共享 provider/baseUrl；摘要插入位置在缓存前缀之后
- **Level 2**：从尾部丢弃，前缀保留；硬截断时标记 `cachePreserved: false`

### 3. 严格的安全性与配对保证

- `tool_use` / `tool_result` 逻辑配对通过 `dependencies` 字段追踪，丢弃时成对移除
- 共享 `message.id` 的消息块通过 `validateMessageIntegrity()` 后验证
- 断路器：`maxAttempts=3`，触发后冷却 `cooldownTurns=5` 轮
- 递归保护：`compressionDepth` 计数器，`maxCompressionDepth=3` 时拒绝进一步摘要

### 4. 高度的可观测性与可配置性

- **所有阈值**支持环境变量覆盖（`AGENTPACK_COMPRESSION_*` 前缀）
- **动态调整**可通过 `compressionConfig` 参数运行时注入（GrowthBook 远程配置接入点）
- **每个压缩动作埋点**：包含 `beforeTokens` / `afterTokens` / `triggerReason` / `retryCount` / `cachePreserved` / `compressionDepth`
- 通过 `afterTransform` hook 自动上报，无需修改 Runtime 核心

---

## 十五、与现有架构的契合点

| 现有基础设施 | 压缩策略复用方式 |
|------------|----------------|
| `ContextResource.pinned` | 标记 compaction_summary、state_snapshot 为不可移除 |
| `ContextResource.dependencies` | 追踪 tool_call ↔ tool_result 配对关系 |
| `ContextResource.type: 'compaction_summary'` | 已定义未使用，正是 Level 1 摘要的落点 |
| `BaseTransformer` + `Pipeline` | 复合转换器以 priority=40 插入 |
| `Model.contextWindow` | 提供 token 上限基准 |
| `StreamFn` | Fork Agent 复用同一流式接口 |
| `Extension.afterTransform` hook | 遥测上报的天然集成点 |
| `TransformContext.runtime.config` | 传递安全状态（绕过 meta round-trip 丢失） |
| `TruncationTransformer`（priority=90） | 作为最终兜底，位于所有压缩之后 |
