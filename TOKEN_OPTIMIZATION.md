# Nanobot Token 消耗分析与整改方案

> 生成时间：2026-07-19
> 分析范围：`src/` 全量代码、`.nanobot/config.json`、`skills/`、会话样本

## 一、概览

通过对项目代码与配置的静态分析，定位到 **5 大类、共 21 项** 导致 token 消耗过高的原因。按影响排序：

| 类别 | 主要问题 | 单次会话潜在浪费 |
|------|---------|------------------|
| 配置层 | 迭代次数过大、工具结果上限过高、输出 token 上限过大 | 极高 |
| 历史管理 | 全量历史重发、压缩阈值过晚、压缩估算严重失真 | 高 |
| 工具系统 | 30+ 工具 schema 每轮重发、`read_file` 豁免压缩 | 高 |
| 子代理与后台任务 | Subagent 全套工具加载、Dream 每 2h 后台跑 LLM | 中 |
| 错误处理与提示词 | 误把 429 当长度错误、空响应重试、标题生成额外调用 | 中 |

**估算**：当前一次中等复杂度任务（10 轮工具调用）在 DeepSeek-v4-flash 上可能消耗 **20 万～60 万 tokens**，其中 60% 以上属于可优化空间。

---

## 二、费 Token 原因清单

### 🔴 严重（P0）

#### 1. `max_tool_iterations` 默认 200 次，单任务可调用 LLM 200 次
- **位置**：[config.json:13](file:///Users/peroluo/Document/nanobot-ts/.nanobot/config.json#L13)、[schema.ts:78](file:///Users/peroluo/Document/nanobot-ts/src/config/schema.ts#L78)、[runner.ts:134](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L134)
- **问题**：`for (let iteration = 0; iteration < maxIterations; iteration++)` 每次迭代都是一次完整的 LLM 调用，且每次都重发完整历史 + 全部工具 schema。
- **影响**：若 LLM 卡在循环中（例如反复调用 `read_file` 查看文件），单任务理论消耗上限 ≈ 200 × (历史 + 工具 schema + 输出 8K)。
- **现状代码**：循环到 `maxIterations - 1` 时还会 push 一条 `buildGoalContinueMessage()`（[runner.ts:323](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L323)），等于变相鼓励继续。

#### 2. 每轮 LLM 调用都重发全部 30+ 工具 schema
- **位置**：[runner.ts:142](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L142)、[openai_compat_provider.ts:234](file:///Users/peroluo/Document/nanobot-ts/src/providers/openai_compat_provider.ts#L234)
- **问题**：`tools.getToolDefinitions()` 返回所有已注册工具（filesystem/shell/web/search/memory/cron/scheduler/exec_session/image_generation/long_task/utilities/cli_apps/...），共 **30+ 个工具**，每个工具都带完整 Zod schema 与 description。这些 schema 每次调用都重新发送。
- **影响**：仅工具 schema 估算约 **3K~6K tokens**，200 次迭代 = **60 万～120 万 tokens 的工具 schema 重复发送**（DeepSeek 不一定命中 prompt cache）。

#### 3. 历史消息原样重发，无主动截断
- **位置**：[loop.ts:299-316](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts#L299)、[loop.ts:141](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts#L141)
- **问题**：`sessionMessagesToProviderMessages` 把整个 `session.messages` 全量映射为 ProviderMessage 直接拼到 `[system, ...history, userMessage]` 中，**不做任何截断**。仅在 `context_governance.ts` 的 `snipHistory` 兜底时才截断（见第 5 项）。
- **影响**：会话越长，输入 token 线性增长。配合 200 次迭代，token 增长是 O(N²)。

#### 4. Token 估算严重失真（中文按 1/4 估算）
- **位置**：[helpers.ts:39-41](file:///Users/peroluo/Document/nanobot-ts/src/utils/helpers.ts#L39)、[context_governance.ts:418-430](file:///Users/peroluo/Document/nanobot-ts/src/agent/context_governance.ts#L418)
- **问题**：`estimateTokens = Math.ceil(text.length / 4)`。英文约 4 字符/token，但**中文 1.5~2 字符/token**，对于中文会话严重低估（实际 token 是估算的 2~3 倍）。
- **影响**：`snipHistory` 与 `compactInflightOverflow` 用此估算判断是否超预算。估算偏低 → 触发不了截断 → 真实 token 持续超额发送，可能直接撞到模型 context window 报错。

#### 5. 会话压缩阈值过晚 + 粗暴切片
- **位置**：[manager.ts:188, 223-238](file:///Users/peroluo/Document/nanobot-ts/src/session/manager.ts#L223)
- **问题**：`maxMessages = 200`，超过后 `keep = Math.floor(200 * 0.6) = 120`，然后 `messages.slice(toRemove)` 直接砍掉前 80 条。
  - 200 条消息可能已经几十万 tokens；
  - 切片可能切坏 `assistant.tool_calls` ↔ `tool` 配对（虽然 `dropOrphanToolResults` 会补救，但会插入 `[Tool result unavailable]` 占位，依然占 token）。
- **影响**：压缩触发前 token 已爆，触发后历史上下文丢失导致 LLM 重新探索。

### 🟠 高（P1）

#### 6. `read_file` 工具结果被豁免压缩
- **位置**：[context_governance.ts:16](file:///Users/peroluo/Document/nanobot-ts/src/agent/context_governance.ts#L16)
- **问题**：`TOOL_RESULT_OFFLOAD_EXEMPT_TOOLS = new Set(['read_file'])`，意味着所有 `read_file` 结果**永久驻留在历史中**，即便上下文已溢出也不被 `compactInflightOverflow` 压缩。
- **影响**：`read_file` 是最容易产生大结果（几 K~几十 K 字符）的工具，且常被反复调用。豁免它等于让历史只增不减。
- **现状**：`max_tool_result_chars = 16000` 上限也偏高（约 4K~5K tokens/次）。

#### 7. AutoCompact 只在会话闲置时压缩
- **位置**：[autocompact.ts:44-94](file:///Users/peroluo/Document/nanobot-ts/src/agent/autocompact.ts#L44)
- **问题**：`checkExpired` 只对 TTL 过期的 idle session 触发；活跃会话不压缩。
- **影响**：长会话（>200 轮）在活跃期间持续累积 token，依赖 `maybeCompact`（粗暴切片）与 `snipHistory`（兜底）。

#### 8. 子代理（Subagent）全套工具 + 全新会话
- **位置**：[subagent.ts:116-117](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts#L116)、[subagent.ts:84](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts#L84)
- **问题**：`_buildTools()` 调用 `createDefaultToolRegistry()` 加载全部 30+ 工具；`maxIterations ?? 200`。子代理本应是聚焦小任务，却用了与主代理同等的工具集和迭代上限。
- **影响**：每次 `spawn` 启动一个全新 LLM 会话（含完整工具 schema），且不继承父会话上下文，子代理需重新探索。

#### 9. `isLengthError` 把 429 rate limit 当作长度错误
- **位置**：[runner.ts:369-376](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L369)
- **问题**：
  ```ts
  return msg.includes('context length') || 
         msg.includes('maximum context') || 
         msg.includes('token limit') ||
         msg.includes('429') ||              // ❌ 429 是限流
         msg.includes('rate limit');
  ```
  触发后会 push `'The conversation is too long. Please summarize...'` 消息（[runner.ts:172](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L172)），反而增加 token。
- **影响**：限流时非但不退避，还多塞一条 user 消息继续请求，可能加重限流。

#### 10. WebUI 每个新会话额外调用 LLM 生成标题
- **位置**：[webui_turns.ts:84-150](file:///Users/peroluo/Document/nanobot-ts/src/session/webui_turns.ts#L84)
- **问题**：每个 WebUI 会话首次交互后调用一次 `provider.complete` 生成标题，单次约 1K~2K tokens。`TITLE_GENERATION_MAX_TOKENS = 96`，但 prompt 中 user/assistant 文本各截到 1000 字符。
- **影响**：单看不夸张，但叠加多会话场景累积显著。

### 🟡 中（P2）

#### 11. System prompt 重复包含运行时信息
- **位置**：[context.ts:73-92](file:///Users/peroluo/Document/nanobot-ts/src/agent/context.ts#L73)
- **问题**：`getDefaultIdentity` 已经写了 `Current time: ...`，`getRuntimeContext` 又写一遍 `Current date and time: ...`，重复占用 token。

#### 12. Dream 模式每 2 小时后台跑 LLM
- **位置**：[config.json:104-110](file:///Users/peroluo/Document/nanobot-ts/.nanobot/config.json#L104)
- **问题**：`memory.dream.enabled: true, interval_h: 2, max_iterations: 15`。每 2 小时后台触发一批 LLM 调用整理记忆，单批最多 15 轮迭代。
- **影响**：闲置时也在烧 token。若记忆量小，性价比低。

#### 13. 工具结果中的 metadata 字段未清理
- **位置**：[manager.ts:66-75](file:///Users/peroluo/Document/nanobot-ts/src/session/manager.ts#L66)
- **问题**：`SessionMessage` 包含 `metadata?` 字段，`appendMessage` 会持久化但 `sessionMessagesToProviderMessages` 不发送它（OK），不过部分工具调用 arguments 中可能携带冗余信息。

#### 14. 空响应/截断重试机制累加消息
- **位置**：[runner.ts:198-204, 215-222](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L198)
- **问题**：空响应时 push `'Your response was empty. Please provide a substantive reply.'`；length 截断时 push `'Your response was cut off. Please continue...'`。每次重试都增加一条 user 消息，且不清理前序失败的 assistant 消息。
- **影响**：`MAX_EMPTY_RETRIES = 2`、`MAX_LENGTH_RECOVERIES = 3`，最坏情况多 5 条消息。

#### 15. 流式与非流式两条路径，无统一上下文优化
- **位置**：[runner.ts:144-163](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L144)
- **问题**：stream 与 complete 走不同分支，但都全量发送 messages + tools。没有针对 provider 的 prompt cache 优化（如把静态 system + tools 放在前面，让 cache 命中）。

#### 16. `unified_session: false` 多对话不共享上下文
- **位置**：[config.json:22](file:///Users/peroluo/Document/nanobot-ts/.nanobot/config.json#L22)
- **问题**：每个对话独立会话，每次都重新建立 system prompt + 工具认知。对于个人助手场景，跨对话共享上下文可省 token。

#### 17. `max_tokens: 8192` 输出 token 上限偏高
- **位置**：[config.json:9](file:///Users/peroluo/Document/nanobot-ts/.nanobot/config.json#L9)
- **问题**：单次输出最多 8K tokens，配合 200 次迭代，最坏输出 = 1.6M tokens。多数任务 1K~2K 输出已足够。

#### 18. `tool_hint_max_length` 等次要配置
- **位置**：[config.json:18](file:///Users/peroluo/Document/nanobot-ts/.nanobot/config.json#L18)
- **问题**：`send_tool_hints: false` 已关闭工具提示，OK。但 `send_progress: true`、`show_reasoning: true` 可能间接影响（reasoning 计 token）。

### 🟢 低（P3）

#### 19. `executionHistory` 在 ToolRegistry 中无界增长
- **位置**：[registry.ts:99-105](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/registry.ts#L99)
- **问题**：每次工具调用都 push 到 `executionHistory`，无清理。虽然不直接计入 LLM token，但长期运行会导致内存占用。`clearHistory()` 存在但少有调用。

#### 20. Backfill 占位消息累积
- **位置**：[context_governance.ts:18, 183-228](file:///Users/peroluo/Document/nanobot-ts/src/agent/context_governance.ts#L183)
- **问题**：`BACKFILL_CONTENT = '[Tool result unavailable — call was interrupted or lost]'` 会在 tool_calls 缺失对应 tool result 时插入。频繁发生会累积占位消息。

#### 21. `temperature: 0.7` 偏高，增加重试概率
- **位置**：[config.json:11](file:///Users/peroluo/Document/nanobot-ts/.nanobot/config.json#L11)
- **问题**：温度高 → 输出不稳定 → 空响应/格式错误概率上升 → 触发重试 → 多耗 token。

---

## 三、整改方案

### P0 立即执行（预计降低 50%~70% token 消耗）

#### 整改 #1：调低 `max_tool_iterations`
```diff
// .nanobot/config.json
- "max_tool_iterations": 200,
+ "max_tool_iterations": 30,
```
- **理由**：99% 的任务 30 轮内可完成。200 轮是异常情况，应通过监控告警而非无限重试。
- **配套**：在 [runner.ts:323](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L323) 接近上限时不再 push `buildGoalContinueMessage`，改为 push `'You are approaching the iteration limit. Wrap up now.'`。

#### 整改 #2：工具 schema 按需注入 + 静态前置
**方案 A（推荐，改动小）**：调整 messages 顺序以命中 provider prompt cache
```ts
// runner.ts: 把 system + tools 放最前，历史在后
// 大多数 OpenAI 兼容 provider 对前缀稳定的 prompt 自动 cache
const orderedMessages = [
  { role: 'system', content: systemPrompt },
  ...history,        // 历史变化部分放后
  userMessage,
];
```
**方案 B（改动大，收益高）**：工具分组按需加载
```ts
// 新增 ToolGroup 概念：filesystem_tools, web_tools, memory_tools...
// 根据用户消息关键词（如"读取文件"→加载 filesystem）动态选择
// 或在首轮让 LLM 选择本次任务需要的工具组
```
**方案 C（最快）**：删除不常用工具
- 评估 `bwrap`、`task_*`、`generate_image`、`my`、`spawn` 等是否在主流程必要，移到子代理或按需注册。

#### 整改 #3：历史消息主动截断
```ts
// loop.ts: 在 sessionMessagesToProviderMessages 前增加
function selectHistory(messages: SessionMessage[], maxTokens = 16000): SessionMessage[] {
  // 1. 保留最近 N 条（N=20）
  // 2. 保留首条 user 消息（任务原意）
  // 3. 中间消息用 _last_summary 替换（若 AutoCompact 已生成）
  // 4. 估算超限时从中间开始丢弃 tool result（保留 tool_call 结构）
}
```
- **关键**：配合 `ContextGovernor` 的 `snipHistory`，让二者协作而非互斥。

#### 整改 #4：修正 token 估算
```ts
// utils/helpers.ts
export function estimateTokens(text: string): number {
  // 中文按 1.5 字符/token，英文按 4 字符/token
  let cjk = 0, other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}
```
- **配套**：把所有 `length / 4` 的地方统一调用此函数。

#### 整改 #5：会话压缩改为滑动窗口 + 摘要
```ts
// manager.ts: maybeCompact
private async maybeCompact(sessionKey: string): Promise<void> {
  const session = await this.store.getOrCreate(sessionKey);
  const tokenEst = estimateSessionTokens(session.messages);
  if (tokenEst > 24000) {  // 改为按 token 而非消息数
    // 1. 调用 LLM 生成前 N-K 条的摘要
    // 2. 用 summary + 最近 K 条替换
    // 3. 保持 tool_calls ↔ tool result 配对完整
  }
}
```
- **关键**：压缩阈值从「200 条消息」改为「24K tokens」，且按 token 估算触发。

---

### P1 尽快执行（预计再降 15%~25%）

#### 整改 #6：取消 `read_file` 豁免 + 调低结果上限
```diff
// context_governance.ts
- const TOOL_RESULT_OFFLOAD_EXEMPT_TOOLS = new Set(['read_file']);
+ const TOOL_RESULT_OFFLOAD_EXEMPT_TOOLS = new Set<string>([]);  // 全部纳入预算

// config.json
- "max_tool_result_chars": 16000,
+ "max_tool_result_chars": 6000,
```
- **配套**：`read_file` 工具自身支持 `offset` / `limit`，引导 LLM 分段读取而非一次性读全文。

#### 整改 #7：活跃会话也触发渐进式压缩
```ts
// runner.ts: 每 10 轮迭代检查一次
if (iteration > 0 && iteration % 10 === 0) {
  await this.autoCompact.compactActiveSession(sessionKey, runtime);
}
```
- 在迭代间穿插压缩，避免单次 LLM 调用前才发现超预算。

#### 整改 #8：子代理工具集精简
```ts
// subagent.ts
private _buildTools(task: string): ToolRegistry {
  const registry = new ToolRegistry();
  // 根据任务关键词选择工具
  if (/read|write|file|edit/i.test(task)) registry.registerMany(getFilesystemTools());
  if (/search|grep|find/i.test(task)) registry.registerMany(getSearchTools());
  // 默认只加载 filesystem + utilities
  return registry;
}
// maxIterations 默认改为 20
this.maxIterations = options.maxIterations ?? 20;
```

#### 整改 #9：修复 `isLengthError` 误判
```ts
// runner.ts
private isLengthError(err: unknown): boolean {
  const msg = (err as Error)?.message?.toLowerCase() || '';
  if (msg.includes('429') || msg.includes('rate limit')) return false;  // 限流单独处理
  return msg.includes('context length') || 
         msg.includes('maximum context') || 
         msg.includes('token limit');
}
// 新增 isRateLimitError，触发指数退避而非塞消息
```

#### 整改 #10：标题生成改为懒加载 + 缓存
```ts
// webui_turns.ts: 仅在用户主动查看会话列表时生成标题
// 或用规则提取（取首条 user 消息前 30 字符）替代 LLM
function ruleBasedTitle(userText: string): string {
  return userText.slice(0, 30).replace(/\n/g, ' ').trim() || 'New Chat';
}
```

---

### P2 计划执行（预计再降 5%~10%）

#### 整改 #11：去除 system prompt 重复
```diff
// context.ts: getDefaultIdentity 去掉 Current time 行
- Current time: ${new Date().toISOString()}
- Timezone: ${timezone}
```
保留 `getRuntimeContext` 中的版本即可。

#### 整改 #12：Dream 模式改为手动触发或拉长间隔
```diff
// config.json
- "interval_h": 2,
+ "interval_h": 24,
- "max_iterations": 15,
+ "max_iterations": 5,
```
或彻底关闭：`"enabled": false`，改为用户主动「整理记忆」时触发。

#### 整改 #13：metadata 字段持久化前清理
- 在 `appendMessage` 序列化前剥离 `metadata`（仅运行时使用）。

#### 整改 #14：重试机制清理失败消息
```ts
// runner.ts: 重试前移除空 assistant 消息
messages.pop();  // 移除空的 assistant
messages.push({ role: 'user', content: '...' });
```

#### 整改 #15：provider 层启用 prompt cache
- DeepSeek/OpenAI 兼容 provider 通常对前缀稳定的 prompt 自动 cache。确保 system + tools 放最前，且 system prompt 内容稳定（动态时间信息放最后或移到 user 消息）。

#### 整改 #16：按场景开启 `unified_session`
- 个人助手场景建议 `unified_session: true`，跨对话共享上下文。

#### 整改 #17：调低 `max_tokens`
```diff
- "max_tokens": 8192,
+ "max_tokens": 2048,
```
- 多数对话 2K 输出已足够；长文生成通过工具分片输出。

#### 整改 #18：调低 temperature
```diff
- "temperature": 0.7,
+ "temperature": 0.3,
```
- 工具调用场景温度低更稳定；创意场景在 model_preset 中单独调高。

---

### P3 长期优化

#### 整改 #19：ToolRegistry 历史限长
```ts
// registry.ts: executeTool 后
if (this.executionHistory.length > 100) {
  this.executionHistory = this.executionHistory.slice(-50);
}
```

#### 整改 #20：Backfill 机制改为合并到下一条
- 检测到缺失 tool result 时，不插入占位，而是把对应 tool_call 从 assistant 消息中移除（连带 ID）。

#### 整改 #21：建立 token 监控与告警
- 复用 `src/webui/token_usage.ts`，在单任务 token > 50K 时告警；
- 在 `AgentRunner.run` 结束时打印 `usage` 日志，便于后续分析。

---

## 四、优先级与实施排期

| 阶段 | 整改项 | 预计工时 | 预计收益 |
|------|--------|---------|---------|
| **Week 1** | #1, #4, #5, #6, #9 | 2~3 天 | 40%~55% |
| **Week 2** | #2, #3, #7, #8 | 3~5 天 | +15%~25% |
| **Week 3** | #10, #11, #12, #17, #18 | 1~2 天 | +5%~10% |
| **Month 2** | #13~#16, #19~#21 | 持续 | +5% |

---

## 五、验证方法

1. **基线测量**：在整改前用一组标准任务（如「读取 package.json 并总结」「修复一个 bug」）记录 token 消耗。
2. **回归测试**：每完成一项整改跑同一组任务，对比 `result.usage.total_tokens`。
3. **监控**：观察 `.nanobot/webui/token-usage.json` 趋势。
4. **质量验证**：确保整改不降低任务完成质量（迭代次数下降不等于失败）。

```ts
// 在 AgentRunner.run 返回前打印（临时调试用）
logger.info({
  iterations_used: iteration,
  total_tokens: totalUsage.total_tokens,
  input_tokens: totalUsage.input_tokens,
  output_tokens: totalUsage.output_tokens,
  tools_used: toolsUsed,
}, 'Turn token usage');
```

---

## 六、附录：关键文件索引

| 模块 | 文件 |
|------|------|
| Agent 主循环 | [src/agent/runner.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts) |
| 上下文构建 | [src/agent/context.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/context.ts) |
| 上下文治理 | [src/agent/context_governance.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/context_governance.ts) |
| 会话管理 | [src/session/manager.ts](file:///Users/peroluo/Document/nanobot-ts/src/session/manager.ts) |
| 自动压缩 | [src/agent/autocompact.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/autocompact.ts) |
| 工具注册 | [src/agent/tools/registry.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/registry.ts) |
| 子代理 | [src/agent/subagent.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/subagent.ts) |
| 主入口 | [src/agent/loop.ts](file:///Users/peroluo/Document/nanobot-ts/src/agent/loop.ts) |
| Token 估算 | [src/utils/helpers.ts](file:///Users/peroluo/Document/nanobot-ts/src/utils/helpers.ts#L39) |
| 默认配置 | [.nanobot/config.json](file:///Users/peroluo/Document/nanobot-ts/.nanobot/config.json) |
| 配置 schema | [src/config/schema.ts](file:///Users/peroluo/Document/nanobot-ts/src/config/schema.ts) |
| OpenAI 兼容 provider | [src/providers/openai_compat_provider.ts](file:///Users/peroluo/Document/nanobot-ts/src/providers/openai_compat_provider.ts) |
| WebUI 标题生成 | [src/session/webui_turns.ts](file:///Users/peroluo/Document/nanobot-ts/src/session/webui_turns.ts) |

---

## 七、附录：现有压缩策略深度剖析

> 本节通过 grep 全量扫描 `src/` 确认每条压缩路径的**实际生效情况**，而非仅看代码意图。

### 7.1 实际生效的压缩机制（仅 3 处，且都偏粗暴）

#### A. 工具结果字符截断 —— 唯一一道「事前」防线
- **位置**：[registry.ts:91-97](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/registry.ts#L91)
- **触发时机**：每次工具执行完毕，结果返回前
- **阈值**：`max_tool_result_chars`（配置默认 **16000 字符** ≈ 4K~5K tokens，中文更多）
- **实现**：
  ```ts
  if (result.content && result.content.length > maxChars) {
    result = {
      ...result,
      content: truncateText(result.content, maxChars) + `\n[truncated from ${result.content.length} chars]`,
    };
  }
  ```
  `truncateText` 只是 `content.slice(0, maxChars - 3) + '...'`，**简单硬切**，可能切坏 JSON / 代码块。
- **局限**：
  1. 按**字符数**而非 token，中文场景实际 token 更高；
  2. 每个工具结果独立截断，没有「全局预算」概念；
  3. 16K 字符对一个工具结果已经很大，长期累积仍爆。

#### B. 会话消息数切片 —— 唯一一处「真正触发」的会话压缩
- **位置**：[manager.ts:223-238](file:///Users/peroluo/Document/nanobot-ts/src/session/manager.ts#L223)
- **触发时机**：每次 `addMessage` / `addMessages` 后调用 `maybeCompact`
- **阈值**：`maxMessages = 200` 条消息（硬编码默认）
- **实现**：
  ```ts
  if (session.messages.length > this.maxMessages) {
    const keep = Math.floor(this.maxMessages * 0.6);  // = 120
    const toRemove = session.messages.length - keep;   // = 80
    session.messages = session.messages.slice(toRemove);
    // 直接砍掉前 80 条，保留后 120 条
  }
  ```
- **关键问题**：
  1. **不调用 LLM 生成摘要**，纯粹丢历史；
  2. **按消息条数**而非 token，200 条短消息 vs 200 条含大工具结果的消息，token 差 10 倍以上；
  3. **粗暴 slice 可能切坏 `tool_calls ↔ tool` 配对**：若第 80 条恰好是 `assistant.tool_calls`，第 81 条是 `tool`，切完后第 81 条变成孤儿 tool result。虽然 `dropOrphanToolResults` 能补救，但那条 tool 调用就永远丢失了；
  4. **不保留首条 user 消息**（任务原意），LLM 失去上下文锚点。

#### C. 上下文长度错误补救 —— 事后补救，非压缩
- **位置**：[runner.ts:169-177](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L169)、[runner.ts:215-222](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L215)
- **触发时机**：LLM provider 抛出被 `isLengthError` 判定为长度超限的错误时
- **实现**：往 messages 里 push 一条 user 消息：
  ```ts
  messages.push({
    role: 'user',
    content: 'The conversation is too long. Please summarize the key points and continue.',
  });
  ```
- **关键问题**：
  1. **这条消息本身也占 token**，反而让下一次请求更长；
  2. LLM 的「summarize」输出会被加回 history，后续轮次继续累积；
  3. `MAX_LENGTH_RECOVERIES = 3`，最坏情况连 push 3 条总结请求；
  4. **`isLengthError` 误把 429 / rate limit 当作长度错误**（[runner.ts:371](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L371)），限流时非但不退避，还多塞消息。

### 7.2 已编写但**从未生效**的压缩机制（死代码）⚠️

通过 grep 全量扫描确认，以下两套精心设计的压缩机制**没有任何外部调用方**，等于完全没生效：

#### D. ContextGovernor —— 完整的 inflight 压缩流水线（死代码）
- **位置**：[context_governance.ts:45-60](file:///Users/peroluo/Document/nanobot-ts/src/agent/context_governance.ts#L45)
- **设计意图**（看代码非常完整）：
  ```
  prepareForModel(messages):
    1. stripPlaceholderAssistantMessages     # 移除占位 assistant 消息
    2. stripMalformedToolCalls                # 清理格式错误的 tool_calls
    3. dropOrphanToolResults                  # 丢弃无主 tool result
    4. backfillMissingToolResults             # 回填缺失的 tool result 占位
    5. applyToolResultBudget                  # 工具结果按预算归一化
    6. compactInflightOverflow                # 超预算时压缩旧工具结果为摘要
    7. snipHistory                            # 兜底：从中间丢消息直至 fit budget
    8. dropOrphanToolResults + backfill       # 再次清理
  ```
- **关键能力（本应生效但没用上）**：
  - `inputBudget = contextWindow - maxTokens - 1024`（安全预算计算）
  - `compactInflightOverflow`：超预算时把旧 `read_file/grep/web_search` 等结果替换为 `[Prior X result compacted to fit context]`
  - `snipHistory`：从历史尾部反向保留，直到预算用尽
  - `MICROCOMPACT_KEEP_RECENT = 10`：最近 10 个工具结果不压缩
- **验证**：`grep -rn "prepareForModel\|new ContextGovernor" src/` 仅命中类内部，**0 个外部调用点**。
- **影响**：runner.ts 直接把 messages 原样发给 provider，**所有 inflight 压缩能力白写**。

#### E. AutoCompact —— 闲置会话 LLM 摘要（死代码）
- **位置**：[autocompact.ts:27](file:///Users/peroluo/Document/nanobot-ts/src/agent/autocompact.ts#L27)
- **设计意图**：
  - 周期性扫描所有会话，对 TTL 过期的 idle session 调用 LLM 生成摘要
  - 摘要存入 `session.metadata['_last_summary']`
  - 下次激活时把摘要作为 system 消息注入，保留近 8 条原文
- **关键能力（本应生效但没用上）**：
  - `RECENT_SUFFIX_MESSAGES = 8`：保留最近 8 条原文
  - `_hasCompactableIdleTail`：检查是否有可压缩的尾部
  - `prepareSession`：会话激活时返回 `[session, summary]` 供 ContextBuilder 注入
- **验证**：`grep -rn "new AutoCompact" src/` **0 个命中**。
- **影响**：长会话从激活到结束**全程不压缩**，只能等 `maybeCompact` 在第 200 条消息时粗暴切片。

#### F. TOOL_RESULT_OFFLOAD_EXEMPT / normalizeToolResult（连带死代码）
- **位置**：[context_governance.ts:16, 72-86](file:///Users/peroluo/Document/nanobot-ts/src/agent/context_governance.ts#L16)
- **设计意图**：`read_file` 工具结果豁免压缩（保留原文），其他工具按 `maxToolResultChars` 归一化。
- **现状**：因为 `ContextGovernor` 没被调用，这套豁免逻辑也从未执行。换句话说，前文整改 #6 提到的「`read_file` 豁免压缩」**在当前代码路径下其实没生效**——但也意味着没有任何工具结果被「智能压缩」，只有 registry.ts 的硬切。

#### G. ToolRegistry.executionHistory.clearHistory（未被调用）
- **位置**：[registry.ts:119-121](file:///Users/peroluo/Document/nanobot-ts/src/agent/tools/registry.ts#L119)
- 累积无界，但不影响 LLM token（不注入上下文），仅占内存。

### 7.3 现状压缩策略全景图

```
┌─────────────────────────────────────────────────────────────────┐
│                  一次 LLM 调用前的 messages 处理路径             │
└─────────────────────────────────────────────────────────────────┘

用户消息
   │
   ▼
[loop.ts] processDirect()
   │
   ├─ sessionManager.getMessages()        ← 读取持久化历史
   │     │
   │     └─ 历史可能已被 maybeCompact 切片（>200 条时砍前 80 条）
   │
   ├─ sessionMessagesToProviderMessages() ← 原样映射，无截断
   │
   ├─ new ContextBuilder().buildSystemPrompt()  ← 拼 system prompt
   │
   ├─ messages = [system, ...history, userMsg]  ← 简单拼接
   │
   ▼
[runner.ts] AgentRunner.run()
   │
   │  ❌ 未调用 ContextGovernor.prepareForModel()
   │     → inflight 压缩、snipHistory、tool budget 全部跳过
   │
   ▼
provider.complete / provider.stream(messages, toolDefs)
   │
   │  每轮迭代都重发完整 messages + 全部工具 schema
   │
   ▼
若 LLM 抛 length error:
   ├─ isLengthError() 误把 429 也算进来
   └─ push "请总结后继续" 消息 → 反而加 token


┌─────────────────────────────────────────────────────────────────┐
│                      压缩机制生效情况汇总                        │
└─────────────────────────────────────────────────────────────────┘

机制                         | 生效? | 触发时机        | 方式
-----------------------------|-------|-----------------|------------------
A. 工具结果字符截断           |  ✅   | 每次工具执行后  | 硬切到 16K 字符
B. 会话消息数切片            |  ✅   | >200 条消息时   | slice 砍前 80 条
C. 长度错误补救              |  ✅   | LLM 报错时      | push 总结请求（反效果）
D. ContextGovernor 全流水线  |  ❌   | （从未调用）    | 死代码
E. AutoCompact 闲置摘要      |  ❌   | （从未实例化）  | 死代码
F. read_file 豁免压缩        |  ❌   | （依赖 D）      | 死代码
G. executionHistory 清理     |  ❌   | （从未调用）    | 死代码
```

### 7.4 关键结论

1. **实际压缩 = 字符硬切 + 消息数切片 + 错误补救**，没有任何「智能」压缩生效。
2. **`ContextGovernor` 与 `AutoCompact` 是两套完整的死代码**，加起来约 600 行（443 + 164），设计完善但从未接入主流程。
3. **整改 #5、#7 的真正做法应是「接入 ContextGovernor / AutoCompact」**，而非重新设计：
   - 在 [runner.ts:142](file:///Users/peroluo/Document/nanobot-ts/src/agent/runner.ts#L142) 调用 LLM 前，插入 `contextGovernor.prepareForModel(config, messages, compactedToolCallIds)`；
   - 在 [nanobot.ts](file:///Users/peroluo/Document/nanobot-ts/src/nanobot.ts) 启动时实例化 `AutoCompact`，挂载到 `SessionManager`，并设置定时器或 TTL。
4. **接入后预期收益**：单次 LLM 调用前的 inflight 压缩可立即把超预算的工具结果折叠为单行摘要，配合 `snipHistory` 兜底，可避免 90% 以上的 length error，进而消除整改 #9 提到的 429 误判连锁反应。
5. **次要修复**：`maybeCompact` 的粗暴 slice 应改为调用 AutoCompact 的 LLM 摘要，至少保留首条 user 消息 + tool_calls 配对完整性。

### 7.5 推荐的接入路径（最小改动）

```ts
// 1. src/agent/runner.ts —— 在每次 LLM 调用前接入 ContextGovernor
const governor = new ContextGovernor();
const governorConfig: ContextGovernanceConfig = {
  provider,
  model: runtime.model,
  tools,
  workspace,
  sessionKey,
  maxToolResultChars,
  contextWindowTokens: runtime.context_window_tokens,
  maxTokens: runtime.max_tokens,
};
const preparedMessages = governor.prepareForModel(
  governorConfig,
  messages,
  this._compactedToolCallIds,  // 新增成员变量持久化已压缩的 ID
);
// 用 preparedMessages 替代 messages 调用 provider

// 2. src/nanobot.ts —— 启动时接入 AutoCompact
const autoCompact = new AutoCompact(sessionManager, consolidator, ttlMinutes);
// 注册到定时器或 in-memory checkExpired 调度
```

接入这两处后，前文整改 #3（历史主动截断）、#5（压缩策略）、#6（取消 read_file 豁免）、#7（活跃会话压缩）将**自动生效**，无需重新设计。
