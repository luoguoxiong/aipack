# Agent 开发工程师 面试题（含答案）

> 基于 aipack 项目技术栈（自研 Agent 框架：Runtime + Extension + Transformer、多模型适配、流式处理、混合检索记忆、多级上下文压缩、全链路可观测性）编写。
> 难度标记：🟢 基础 / 🟡 进阶 / 🔴 高级 / 🟣 架构设计

---

## 一、Agent 基础概念

### Q1 🟢 什么是 AI Agent？它与单纯的 LLM 调用有什么本质区别？

**考察点**：对 Agent 范式的理解

**参考答案**：

| 维度 | LLM 调用 | AI Agent |
|------|----------|----------|
| 执行模式 | 单轮「输入 → 输出」无状态映射 | 自主决策循环（perception → reasoning → action → observation） |
| 状态 | 无状态，每次调用独立 | 有状态，跨轮次维持上下文 |
| 外部交互 | 无，知识截止于训练数据 | 能调用工具获取实时信息、执行副作用操作 |
| 终止条件 | 一次调用即结束 | 由模型自主决定何时完成（不再调用工具） |

Agent 的三个核心要素：
- **模型（大脑）**：LLM 作为推理引擎，决定下一步动作
- **工具（手脚）**：搜索、代码执行、数据库查询、API 调用等
- **记忆/上下文（短期记忆）**：维护对话历史与任务状态

Agent 的本质是「以 LLM 为推理引擎的循环控制系统」。典型执行流程：
```
用户输入 → 模型推理（Thought）→ 决定调用工具（Action）→ 执行工具 → 观察结果（Observation）→ 继续推理 → ... → 给出最终答案
```

ReAct、Plan-Execute、Reflexion 等是其不同的决策范式。与 LLM 调用的根本区别在于：Agent 有**循环**和**自主性**——它能根据工具返回的结果决定下一步做什么，而非一次性返回。

### Q2 🟢 解释 ReAct 范式，并说明它相比纯 Chain-of-Thought 的优势。

**考察点**：推理-行动交错范式

**参考答案**：

**CoT（Chain-of-Thought）**：模型在内部「想」——逐步推理后给出答案。局限是：
- 无法与外部世界交互，知识截止于训练数据
- 无法执行副作用操作（如发邮件、写文件）
- 推理出错时无法用外部信息纠正

**ReAct（Reasoning + Acting）**：推理与行动交错执行：
```
Thought 1: 用户问北京天气，我需要查实时天气
Action 1: get_weather("北京")
Observation 1: 北京今天 25°C，晴
Thought 2: 我拿到了天气信息，可以回答了
Answer: 北京今天 25°C，晴天。
```

优势：
1. **实时信息**：能调用工具获取训练数据截止后的信息
2. **副作用操作**：能执行代码、操作数据库、发送消息等
3. **自我纠错**：基于 observation 修正推理路径（工具报错后换方案）
4. **可解释性**：Thought 链路清晰可审计，便于调试

典型实现：模型输出中同时包含 reasoning 文本和 tool_call（结构化），框架解析 tool_call 执行后，把结果作为 observation 回填到 messages，进入下一轮，直到模型不再产出 tool_call 即终止。

### Q3 🟡 Agent 的「自主性」边界在哪里？如何防止 Agent 失控？

**考察点**：安全性与可控性

**参考答案**：

Agent 的自主性必须有明确边界，失控场景包括：无限循环、调用危险工具、成本爆炸、产生有害操作。防护需分层设计：

1. **循环上限（硬兜底）**：
   - `max iterations`：限制最大循环轮次（如 25 轮）
   - `max tokens`：限制单次 run 总 token 消耗
   - `timeout`：墙钟超时（如 120s）
   - 三者取最早触发者

2. **权限分级（ApprovalManager）**：
   - 只读工具（搜索、查询）→ `autoApprove`，自动执行
   - 有副作用工具（删文件、发消息、付款）→ `requireApproval`
   - 审批可以是同步阻塞（CLI 弹窗确认）或异步（Web 端 pending 状态，人工回调）

3. **成本约束（CostCalculator）**：
   - 单次 run 的 token/调用次数预算
   - 超阈值熔断，返回「预算耗尽」提示

4. **工具沙箱**：
   - 文件系统路径白名单（只允许 `/workspace/*`）
   - 网络域名白名单（只允许 `api.example.com`）
   - 命令执行黑名单（禁用 `rm -rf` / `sudo`）

5. **死循环检测**：
   - 记录最近 K 步的 `(tool_name, args_hash)`
   - 连续重复触发 → 强制终止

6. **可观测与审计**：
   - 全链路 trace，记录每次模型调用与工具执行
   - 危险操作二次确认 + 事后回放审计

---

## 二、Agent 框架架构

### Q4 🟡 请设计一个 Agent 框架的核心抽象，说明各模块职责。

**考察点**：架构设计能力（对应本项目 Runtime + Extension + Transformer）

**参考答案**：

采用三段式架构，核心是**调度与扩展解耦**：

```
┌─────────────────────────────────────────────────┐
│                   Runtime                        │
│  主循环: model call → tool exec → observe → ...  │
│  入口: run() 同步 / stream() 流式                │
├─────────────────────────────────────────────────┤
│            Extension (Tapable Hooks)             │
│  beforeModelCall / afterModelCall               │
│  beforeToolCall / afterToolCall                 │
│  onTurnEnd / onSessionEnd                       │
│  → 工具注册 / 记忆捕获 / 可观测性埋点 / 权限检查 │
├─────────────────────────────────────────────────┤
│           Transformer (Messages 变换)            │
│  beforeModel: 记忆注入 / 上下文压缩 / PII 脱敏   │
│  afterModel:  输出格式化 / 安全过滤              │
└─────────────────────────────────────────────────┘
```

各模块职责：

- **Runtime（执行入口）**：编排主循环，协调模型调用、工具执行、上下文管理。暴露 `run()`（一次性返回完整结果）与 `stream()`（流式返回增量事件）两个入口。不包含业务逻辑，只负责调度。

- **Extension（扩展插件）**：通过 Tapable 钩子挂载到生命周期的各个节点（如 `beforeModelCall` / `afterToolCall` / `onTurnEnd`），实现工具注册、记忆捕获、可观测性埋点、权限检查等可插拔能力。插件互不感知，通过 hook 协作。

- **Transformer（上下文转换）**：在每轮循环前后对 messages 做变换。模型调用前：记忆注入、上下文压缩、PII 脱敏；模型调用后：输出格式化、安全过滤。Transformer 是无状态的纯函数链。

分层好处：
- 核心调度与业务扩展解耦，插件可热插拔
- 便于单元测试（各层独立 mock）
- 新增能力（如记忆、压缩）无需改动 Runtime 核心

### Q5 🟡 为什么选择 Tapable 钩子机制而不是简单的中间件洋葱模型？

**考察点**：生命周期管理方案选型

**参考答案**：

**洋葱模型（Koa/Express 风格）的局限**：
- 适合线性请求流（请求进来 → 经过多层中间件 → 响应出去）
- Agent 循环有多个不同阶段的 hook 点（模型前/后、工具前/后、轮次结束），不是单一请求流
- 洋葱模型的 `next()` 语义难以表达「并行执行多个插件」或「链式修改数据后传递」

**Tapable 的优势**：

| 特性 | 洋葱模型 | Tapable |
|------|----------|---------|
| 触发语义 | 串行 `next()` | SyncHook / AsyncParallelHook / AsyncSeriesWaterfallHook 等多种 |
| 数据传递 | ctx 对象共享 | Waterfall 钩子链式传递返回值 |
| 并行 | 难 | AsyncParallelHook 原生支持 |
| 拦截 | 需自己实现 | Interceptor 原生支持 |
| 优先级 | 靠注册顺序 | 可显式设 stage/优先级 |

关键场景：Waterfall 钩子让多个 Transformer 链式修改 messages：
```
beforeModelCall (WaterfallHook<Messages>)
  → Transformer 1: PII 脱敏（messages in → 脱敏后 messages out）
  → Transformer 2: 上下文压缩（脱敏后 messages in → 压缩后 messages out）
  → Transformer 3: 记忆注入（压缩后 messages in → 注入后 messages out）
  → 最终 messages 传给模型
```

每个 Transformer 只关心输入输出，不需要知道前后还有谁。洋葱模型要实现同样的链式数据变换需要每层手动传参，代码更冗长。

### Q6 🔴 如何保证 Agent 主循环中「模型调用 → 工具执行 → 结果回填」的可靠性？有哪些异常需要处理？

**考察点**：健壮性设计

**参考答案**：

主循环每一步都可能出错，需分类处理：

**1. 模型调用异常**：
- `网络超时` → 重试 + 指数退避（如 3 次，1s/2s/4s + jitter）
- `429 限流` → 读取 `Retry-After` header，按指定时间等待后重试
- `400 上下文超长` → 触发上下文压缩（裁剪旧消息），压缩后重试
- `5xx 服务端错误` → 重试 + 降级（换备用模型）
- 重试耗尽 → 把错误信息作为 observation 回填，让模型决定换方案

**2. 工具执行异常**：
```typescript
try {
  const result = await tool.execute(args, { timeout: 30000 });
  // 回填 ToolMessage: result
} catch (err) {
  // 回填 ToolMessage: `Error: ${err.message}`
  // 让模型看到错误，自行决定重试或换方案
  messages.push({ role: 'tool', content: `Error: ${err.message}`, isError: true });
}
```
- 关键：工具错误**不能中断循环**，而是作为 observation 让模型处理
- 但要区分「可恢复错误」（API 超时）和「不可恢复错误」（参数非法）——后者重试无意义

**3. JSON 解析异常**：
- 模型输出的 tool_call arguments 可能是 partial JSON（流式时尤其常见）：`{"path": "/tmp/`
- 使用 partial-json 增量解析器，对不完整 JSON 做最佳推断
- 真正执行工具前必须等到 `finish_reason: "tool_calls"` 确认参数完整
- 非流式场景如果模型返回的 JSON 完全无法解析 → 回填「请输出合法 JSON」让模型重试

**4. 死循环检测**：
```
维护最近 K=5 步的 (tool_name, args_hash) 队列
若新步骤的 hash 已在队列中 → 判定为死循环 → 强制终止
```

**5. 状态一致性**：
- 工具执行与消息持久化必须在同一个检查点内
- 流程：`执行工具 → 构造 ToolMessage → 写入持久化 → 进入下一轮`
- 若在「执行完工具但未持久化」间崩溃，恢复时会重执行该工具 → **工具需尽量幂等**
- 副作用工具（如扣款）需带 idempotency key，避免重复执行

---

## 三、LLM 与多模型适配

### Q7 🟢 主流大模型 API 有哪些差异？如何抽象才能同时支持 OpenAI / Anthropic / DeepSeek 等？

**考察点**：多模型适配层设计

**参考答案**：

**厂商差异点**：

| 维度 | OpenAI | Anthropic | DeepSeek |
|------|--------|-----------|----------|
| system 消息 | messages[0] 为 `{role: "system"}` | 顶层 `system` 字段，不在 messages 内 | 兼容 OpenAI 格式 |
| 工具调用 | `tool_calls` 数组 + `function` | `content` 内 `tool_use` block | 兼容 OpenAI 格式 |
| 流式协议 | SSE，`delta` 增量 | SSE，`content_block_delta` 事件 | 兼容 OpenAI 格式 |
| 多模态 | `content` 数组含 `image_url` | `content` 数组含 `image` + base64 | 部分支持 |
| 最大上下文 | 128K (GPT-4) | 200K (Claude) | 64K-128K |

**适配层设计**：

```typescript
// 统一内部模型
interface ChatRequest {
  messages: Message[];        // 统一消息格式
  tools?: ToolSchema[];        // 统一工具 schema (JSON Schema)
  model: string;
  stream?: boolean;
}

interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: { promptTokens: number; completionTokens: number };
}

// Provider Adapter 接口
interface ProviderAdapter {
  toProviderRequest(req: ChatRequest): any;     // 内部 → 厂商格式
  fromProviderResponse(res: any): ChatResponse;  // 厂商格式 → 内部
  parseStreamChunk(chunk: any): StreamChunk;      // 厂商流式 → 统一流式
}
```

**兼容性处理要点**：
- Anthropic 的 system 消息需从 messages 数组提取到顶层字段
- 工具调用结果回填：OpenAI 用 `{role: "tool"}`，Anthropic 用 `{role: "user", content: [{type: "tool_result"}]}`
- DeepSeek 兼容 OpenAI 格式，可直接复用 OpenAI Adapter
- 流式解析各厂商事件结构不同，需各自实现 SSE parser

### Q8 🟡 流式输出时，如何处理工具调用（tool_call）的增量解析？

**考察点**：流式工具调用处理（对应本项目 partial-json + sse-parser）

**参考答案**：

流式场景下，工具调用的 arguments 是逐 token 到达的，可能是残缺 JSON：
```
chunk 1: {"path": "/tm
chunk 2: p/test.txt", "mo
chunk 3: de": "read"}
```

**处理方案**：

```typescript
import { parse as parsePartialJson } from 'partial-json';

class ToolCallAccumulator {
  private buffer = '';
  private toolName?: string;
  private toolCallId?: string;

  // 每个 chunk 到达时调用
  onDelta(delta: { toolName?: string; argumentsDelta?: string }) {
    if (delta.toolName) this.toolName = delta.toolName;
    if (delta.argumentsDelta) this.buffer += delta.argumentsDelta;

    // 增量解析，提取已完整字段用于 UI 预览
    const partial = parsePartialJson(this.buffer);
    return { toolName: this.toolName, partialArgs: partial };
  }

  // finish_reason 到达时调用，确认参数完整
  onComplete(): { toolName: string; args: any } {
    return { toolName: this.toolName!, args: JSON.parse(this.buffer) };
  }
}
```

**关键要点**：
1. **累积 buffer**：每个 chunk 的 arguments 增量拼接到 buffer
2. **partial-json 解析**：对不完整 JSON 做容错推断（如 `{"path": "/tm` → `{path: "/tm"}`，未闭合字符串返回已接收部分）
3. **UI 预览**：增量解析提取已完整字段（如先显示工具名，再逐步显示参数字段）
4. **执行时机**：工具调用真正执行必须等到该 tool_call 的 `finish_reason: "tool_calls"` 到达，确保参数完整
5. **多工具并行**：同一消息可能含多个 tool_call，需按 `tool_call_id` 分别维护 accumulator

### Q9 🟡 如何降低多模型场景下的 token 成本？

**考察点**：成本优化

**参考答案**：

```typescript
// 成本计算示例
class CostCalculator {
  private priceCache: Map<string, ModelPrice> = new Map(); // 5 分钟缓存

  calculate(model: string, usage: TokenUsage): number {
    const price = this.getPrice(model); // per 1K tokens
    return (usage.prompt / 1000 * price.input)
         + (usage.completion / 1000 * price.output);
  }
}
```

**降本策略**：

1. **模型路由**：
   - 简单任务（分类、提取、格式转换）→ 小模型（DeepSeek-V3 / Claude Haiku / GPT-4o-mini）
   - 复杂推理（代码生成、多步规划）→ 大模型（Claude Opus / GPT-4）
   - 判定方式：规则（任务类型标记）或路由模型（轻量分类器）

2. **Prompt 压缩**：
   - 裁剪冗余 system prompt（去除示例、合并重复指令）
   - 历史消息摘要化（旧对话压缩为 summary）
   - 工具描述精简（只保留当前轮可能用到的工具）

3. **缓存**：
   - 精确匹配缓存：相同 `(model, messages, tools)` 哈希 → 命中缓存直接返回
   - 语义缓存：嵌入 query 向量，相似度 > 阈值命中（适合 FAQ 场景）
   - Anthropic Prompt Caching：固定 system prompt 部分自动缓存，降低重复输入成本

4. **工具输出裁剪**：
   - 长输出截断（如命令行输出只保留前 100 行 + 后 10 行）
   - 大输出摘要化后再回填上下文

5. **预算控制**：
   - `CostCalculator` 实时累计单次 run 花费
   - 超阈值熔断，返回「预算耗尽」提示

6. **批量请求**：
   - 支持时用 batch API（如 OpenAI Batch）降低 50% 单价，适合非实时场景

---

## 四、工具调用（Tool Calling）

### Q10 🟡 设计一个工具注册与执行系统，要支持参数校验、权限控制、并发执行。

**考察点**：工具系统设计（对应本项目 tool-hooks + permission）

**参考答案**：

```typescript
// 工具定义
interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;        // 参数 schema
  handler: (args: any, ctx: ToolContext) => Promise<any>;
  requiredPermission?: Permission; // 权限标记
  autoApprove: boolean;           // 是否自动执行
  timeout: number;                // ms
}

// 工具注册表
class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool) { this.tools.set(tool.name, tool); }
  get(name: string) { return this.tools.get(name); }
  getSchemas(): JSONSchema[] { /* 返回给模型可见的 schema 列表 */ }
}

// 工具执行器
class ToolExecutor {
  constructor(
    private registry: ToolRegistry,
    private approvalManager: ApprovalManager,
    private validator: SchemaValidator,
  ) {}

  async execute(toolCalls: ToolCall[], ctx: RunContext): Promise<ToolMessage[]> {
    // 1. 并发执行无依赖的 tool_calls
    return Promise.all(toolCalls.map(tc => this.executeOne(tc, ctx)));
  }

  private async executeOne(tc: ToolCall, ctx: RunContext): Promise<ToolMessage> {
    const tool = this.registry.get(tc.name);
    if (!tool) return this.errorMsg(tc, `未知工具: ${tc.name}`);

    // 2. 参数校验
    const valid = this.validator.validate(tc.args, tool.parameters);
    if (!valid.success) return this.errorMsg(tc, `参数校验失败: ${valid.error}`);

    // 3. 权限检查
    if (!tool.autoApprove && tool.requiredPermission) {
      const approved = await this.approvalManager.requestApproval({
        toolName: tc.name, args: tc.args, permission: tool.requiredPermission,
      }, ctx);
      if (!approved) return this.errorMsg(tc, '用户拒绝执行');
    }

    // 4. 超时执行
    try {
      const result = await withTimeout(tool.handler(tc.args, ctx), tool.timeout);
      return { role: 'tool', toolCallId: tc.id, content: JSON.stringify(result) };
    } catch (err) {
      return this.errorMsg(tc, `执行失败: ${err.message}`);
    }
  }
}
```

**设计要点**：
- **参数校验**：用 JSON Schema（typebox / ajv）校验，失败回填错误让模型修正
- **权限控制**：`autoApprove` 的只读工具自动执行；`requireApproval` 的副作用工具经 ApprovalManager 异步等待人工确认
- **并发执行**：同一轮多个无依赖 tool_call 用 `Promise.all` 并行；有依赖需 TaskGraph 拓扑排序
- **超时**：每个工具独立 timeout，避免单个工具卡死整个循环
- **错误不中断**：工具错误转为 ToolMessage 回填，让模型决定下一步

### Q11 🔴 模型生成的工具调用参数不符合 schema 时如何处理？

**考察点**：鲁棒性

**参考答案**：

**处理流程（多层防御）**：

```
模型输出 tool_call args
    ↓
[第 1 层: 宽松解析] 字符串数字转 number / 枚举模糊匹配
    ↓
[第 2 层: Schema 校验] ajv 校验
    ↓ 失败
[第 3 层: 错误回填] 把校验错误信息作为 observation 返回模型
    ↓
[第 4 层: 重试限制] 同一工具参数错误 ≤ 2 次，否则降级提示用户
```

**1. 校验失败回填**：
```typescript
const result = ajv.validate(schema, args);
if (!result) {
  const errorMsg = ajv.errorsText(); // "data.path is required, data.mode must be one of ..."
  return { role: 'tool', content: `参数错误: ${errorMsg}。请修正后重新调用。` };
  // 模型下一轮看到错误后通常会修正参数重试
}
```

**2. 宽松解析（容错常见错误）**：
- 字符串数字：`"42"` → `42`（模型常把数字输出为字符串）
- 枚举模糊匹配：`"READ"` → `"read"`（大小写容错）
- 多余字段：strip 而非拒绝（模型可能加无用字段）
- 缺失可选字段：填默认值

**3. 重试限制**：
- state 中记录 `(tool_name, retry_count)`
- 同一工具参数错误重试 ≤ 2 次
- 超限降级为提示用户「无法自动完成，请手动提供参数」

**4. 预防措施**：
- **few-shot 引导**：工具 description 中附带正确调用示例
- **强约束模型**：优先用支持 `structured output` / `JSON mode` 的模型，输出保证合法 JSON
- **schema 清晰**：参数 description 写清楚类型、枚举值、示例

### Q12 🟡 如何实现工具调用的依赖编排（A 的输出是 B 的输入）？

**考察点**：任务图调度（对应本项目 task-graph）

**参考答案**：

**两种模式**：

**模式 1：模型自主编排（默认）**
- 大多数场景依赖由模型在多轮对话中自行决定
- A 完成后，模型看到 A 的结果，决定下一步调 B 并把 A 的结果作为参数
- 无需框架支持，但依赖模型推理能力

**模式 2：DAG 预编排（固定流程）**：
```typescript
class TaskGraph {
  private nodes = new Map<string, TaskNode>();
  private edges: [string, string][] = []; // [from, to]

  addTask(name: string, tool: string, argsTemplate: any) { /* ... */ }
  addDependency(from: string, to: string) { this.edges.push([from, to]); }

  async execute(ctx: RunContext): Promise<Map<string, any>> {
    // 拓扑排序
    const layers = this.topoSort();
    const results = new Map<string, any>();

    for (const layer of layers) {
      // 同层无依赖，并行执行
      await Promise.all(layer.map(async (nodeName) => {
        const node = this.nodes.get(nodeName)!;
        // 变量替换：{{toolA.result.path}} → results.get('toolA').path
        const args = this.resolveArgs(node.argsTemplate, results);
        const result = await this.executor.execute(node.tool, args, ctx);
        results.set(nodeName, result);
      }));
    }
    return results;
  }
}

// 示例：搜索文件 → 读取文件 → 分析内容
graph.addTask('search', 'search_files', { pattern: '*.log' });
graph.addTask('read', 'read_file', { path: '{{search.result[0].path}}' });
graph.addTask('analyze', 'analyze', { content: '{{read.result}}' });
graph.addDependency('search', 'read');
graph.addDependency('read', 'analyze');
```

**关键要点**：
- DAG（有向无环图）描述依赖，节点 = 工具调用，边 = 数据依赖
- 拓扑排序后分层执行，同层并行
- 数据传递：上游输出通过变量引用 `{{node.result.field}}` 注入下游参数
- DAG 适用于预先编排的固定流程（如 ETL、数据处理管线）
- 动态依赖（取决于运行时结果）仍应由模型自主编排

---

## 五、会话与上下文管理

### Q13 🟡 Agent 会话上下文持续增长会导致什么问题？如何管理？

**考察点**：上下文窗口管理

**参考答案**：

**问题**：
1. **超出窗口报错**：messages 总 token 超过模型上下文上限（如 128K）→ API 返回 400
2. **成本线性增长**：每轮都把全部历史发给模型，token 费用随轮次线性增长
3. **延迟增加**：输入越长，模型首 token 延迟（TTFT）越高
4. **信息遗忘**：长上下文中早期信息被「中间遗忘」（lost in the middle），模型注意力衰减

**管理策略（分层压缩，对应本项目 L1-L5）**：

| 层级 | 策略 | 触发时机 |
|------|------|----------|
| L1 | 工具输出裁剪：长输出截断/摘要 | 单条工具输出 > 阈值 |
| L2 | 旧消息摘要：N 轮前的对话压缩成 summary | 总 token > 60% 窗口 |
| L3 | 任务状态提取：提取当前进度、关键变量 | L2 后仍超阈值 |
| L4 | 会话检查点：持久化完整快照 | 压缩前/定期 |
| L5 | 新会话交接：跨会话传递关键信息 | 会话结束 |

**触发机制**：
- 按阈值触发，而非每轮触发（避免每轮压缩的开销）
- 阈值设为窗口大小的 60-70%，预留空间给新内容
```typescript
if (estimateTokens(messages) > windowSize * 0.6) {
  messages = await compress(messages); // L1→L2→L3 逐级触发
}
```

### Q14 🔴 设计一个会话持久化方案，支持多会话切换、过期清理、并发安全。

**考察点**：会话存储设计（对应本项目 session-manager）

**参考答案**：

```typescript
// 会话结构
interface Session {
  sessionId: string;
  messages: Message[];
  metadata: Record<string, any>;
  createdAt: number;
  lastActiveAt: number;
  version: number; // 乐观锁
}

// 存储抽象
interface SessionStore {
  get(sessionId: string): Promise<Session | null>;
  save(session: Session): Promise<void>;
  list(userId: string): Promise<Session[]>;
  delete(sessionId: string): Promise<void>;
}

// 实现：内存版 + 文件版
class InMemorySessionStore implements SessionStore { /* Map 存储 */ }
class FileSessionStore implements SessionStore { /* JSON 文件持久化 */ }

// 会话管理器
class SessionManager {
  private store: SessionStore;
  private locks = new KeyedMutex<string>(); // 每会话一把锁
  private activeSessions = new Map<string, Session>(); // LRU 缓存

  // 同一会话串行化，避免 messages 竞态
  async run(sessionId: string, fn: (session: Session) => Promise<Session>): Promise<void> {
    return this.locks.runExclusive(sessionId, async () => {
      let session = await this.store.get(sessionId) ?? this.createSession(sessionId);
      session = await fn(session);
      session.lastActiveAt = Date.now();
      session.version++;
      await this.store.save(session);
    });
  }

  // 过期清理：惰性 + 定时
  startCleanup(intervalMs: number, maxAgeMs: number) {
    setInterval(() => this.sweep(maxAgeMs), intervalMs);
  }
  private async sweep(maxAgeMs: number) {
    const now = Date.now();
    for (const session of await this.store.list()) {
      if (now - session.lastActiveAt > maxAgeMs) {
        await this.store.delete(session.sessionId);
      }
    }
  }
}

// 每会话一把锁（避免全局锁阻塞其它会话）
class KeyedMutex<K> {
  private locks = new Map<K, Promise<void>>();
  async runExclusive<T>(key: K, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(r => release = r);
    this.locks.set(key, prev.then(() => next));
    await prev;
    try { return await fn(); } finally { release(); }
  }
}
```

**设计要点**：
- **并发安全**：KeyedMutex 每会话一把锁，同一会话的 run 串行化（避免并发修改 messages 竞态），不同会话并行
- **过期清理**：惰性清理（访问时检查 lastActiveAt）+ 定时巡检双策略
- **多会话切换**：SessionManager 维护 active session 映射，切换时持久化当前、加载目标
- **版本号**：乐观锁，防止并发写覆盖（save 时检查 version 是否变化）

### Q15 🟡 上下文压缩时，如何避免丢失关键信息？

**考察点**：压缩质量保证

**参考答案**：

**压缩 ≠ 简单截断**，而是结构化信息提取：

```typescript
async function compressMessages(messages: Message[]): Promise<Message[]> {
  // 1. 保留近期原文（recency window）
  const recentK = 6;
  const recent = messages.slice(-recentK);
  const old = messages.slice(0, -recentK);

  // 2. 结构化摘要（非简单截断）
  const summary = await llm.invoke({
    system: `提取以下对话的关键信息，输出 JSON：
    {
      "user_intent": "用户意图",
      "completed_steps": ["已完成的步骤"],
      "pending_tasks": ["待办任务"],
      "key_variables": {"变量名": "值"},
      "unresolved_issues": ["未解决问题"]
    }`,
    messages: old,
  });

  // 3. 标记不可压缩的关键数据
  // 工具返回的文件路径、查询结果等标记为 important，压缩时保留原文

  // 4. 压缩前保存完整快照（可回溯）
  await checkpoint.save(messages);

  // 5. 摘要验证（自检）
  const verified = await llm.invoke({
    system: `检查摘要是否遗漏关键信息，补充遗漏项`,
    messages: [{ role: 'user', content: summary }],
  });

  return [{ role: 'system', content: `[历史摘要]\n${verified}` }, ...recent];
}
```

**关键策略**：
1. **结构化摘要**：提取「用户意图 / 已完成步骤 / 待办任务 / 关键变量 / 未解决问题」，而非简单截断
2. **保留近期原文**：最近 K 轮保留原文（recency window），只压缩更早的部分
3. **保留工具关键结果**：文件路径、查询结果等标记为 `important`，不可压缩
4. **可逆检查点**：压缩前保存完整快照，需要时能回溯（时间旅行调试）
5. **摘要验证**：压缩后用模型自检摘要是否覆盖关键信息，遗漏则补充

---

## 六、记忆系统

### Q16 🟡 Agent 的「记忆」和「上下文」有什么区别？为什么需要长期记忆？

**考察点**：记忆 vs 上下文

**参考答案**：

| 维度 | 上下文 (Context) | 记忆 (Memory) |
|------|------------------|---------------|
| 范围 | 当前会话内 | 跨会话持久化 |
| 存储 | 内存中的 messages 数组 | 外部存储（文件/DB/向量库） |
| 生命周期 | 会话结束即丢失 | 永久保存（除非显式删除） |
| 容量 | 受模型上下文窗口限制 | 无上限（按需检索注入） |
| 传递方式 | 全量传给模型 | 按相关性检索后注入 |

**为什么需要长期记忆**：
- **记住用户偏好**：「我对花生过敏」「我用 TypeScript」——避免每次重复询问
- **跨会话任务延续**：上次讨论到一半的任务，新会话能接着做
- **避免重复工作**：已查过的信息不用再查，已得出的结论不用再推
- **个性化**：根据历史交互定制响应风格与内容

**记忆生命周期（四阶段）**：
```
捕获 (Capture) → 检索 (Retrieval) → 注入 (Injection) → 整合 (Consolidation)
   ↓                ↓                  ↓                   ↓
从对话提取      按相关性召回        注入 system prompt    去重/合并/衰减
值得记忆的      相关记忆            或作为 context        旧记忆
信息
```

### Q17 🔴 比较 BM25 与向量检索的优劣，如何结合？

**考察点**：混合检索（对应本项目 hybrid-retriever）

**参考答案**：

| 维度 | BM25 | 向量检索 |
|------|------|----------|
| 原理 | 词频 (TF) + 逆文档频率 (IDF) | 语义嵌入相似度 (cosine) |
| 优势 | 精确关键词匹配、无需模型、可解释、速度快 | 语义近似匹配、抗同义词/近义词 |
| 劣势 | 无法理解语义、对拼写错误敏感 | 需 embedding 模型、精确匹配弱、维度高时慢 |
| 适合 | 代码、文件路径、专有名词、API 名 | 自然语言意图、概念查询 |
| 无模型 | ✅ 纯算法 | ❌ 需 embedding 模型 |

**混合检索方案**：
```typescript
class HybridRetriever {
  constructor(
    private bm25: BM25Index,
    private vectorIndex: VectorIndex,
    private alpha = 0.5, // BM25 权重，1-alpha 为向量权重
  ) {}

  async retrieve(query: string, topK = 10): Promise<Memory[]> {
    // 1. 双路召回各取 TopK
    const bm25Results = this.bm25.search(query, topK * 2);
    const vectorResults = await this.vectorIndex.search(query, topK * 2);

    // 2. 分数归一化（RRF - Reciprocal Rank Fusion）
    const scores = new Map<string, number>();
    const rrf = (rank: number) => 1 / (60 + rank); // RRF 公式

    bm25Results.forEach((m, i) => {
      scores.set(m.id, (scores.get(m.id) ?? 0) + this.alpha * rrf(i));
    });
    vectorResults.forEach((m, i) => {
      scores.set(m.id, (scores.get(m.id) ?? 0) + (1 - this.alpha) * rrf(i));
    });

    // 3. 融合重排，取最终 TopN
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([id]) => this.getById(id));
  }
}
```

**关键要点**：
- 双路召回扩大候选集，互补优势
- **RRF（Reciprocal Rank Fusion）** 比 min-max 归一化更鲁棒（不依赖原始分数量纲）
- 权重 `alpha` 可调：关键词密集场景（代码搜索）调高 BM25 权重；自然语言场景调高向量权重
- 进阶：召回后加 cross-encoder rerank（如 BGE Reranker）进一步提升精度

### Q18 🟡 如何自动从对话中捕获值得记忆的信息？

**考察点**：记忆捕获（对应本项目 capture-extension + extractor）

**参考答案**：

```typescript
class CaptureExtension {
  // 挂载到 onTurnEnd 钩子
  async onTurnEnd(ctx: TurnContext) {
    const lastTurn = ctx.messages.slice(-2); // user + assistant
    const candidates = await this.extract(lastTurn);
    for (const memory of candidates) {
      await this.consolidate(memory); // 去重合并
    }
  }

  private async extract(messages: Message[]): Promise<Memory[]> {
    return await llm.invoke({
      system: `分析以下对话，提取值得长期记忆的信息。
      只提取：用户偏好、事实陈述、任务结论、纠错信息。
      不要提取：临时性信息、闲聊、已存在的重复信息。
      输出 JSON 数组：[{"type": "preference", "content": "...", "confidence": 0.9}]`,
      messages,
    });
  }

  private async consolidate(newMemory: Memory) {
    // 1. 与已有记忆做相似度比对
    const existing = await this.store.search(newMemory.content, 3);
    const duplicate = existing.find(m => similarity(m, newMemory) > 0.85);

    if (duplicate) {
      // 2. 重复则合并更新（保留更高置信度的版本）
      await this.store.update(duplicate.id, mergeMemories(duplicate, newMemory));
    } else {
      // 3. 新记忆则写入
      await this.store.put(newMemory);
    }
  }
}
```

**关键要点**：
1. **触发时机**：在 `onTurnEnd` 钩子中异步执行，不阻塞主循环
2. **抽取策略**：LLM 信息抽取，prompt 引导提取「偏好 / 事实 / 结论 / 纠错」
3. **去重与合并**：新记忆与已有记忆做相似度比对，重复则合并更新（保留高置信度版本）
4. **记忆衰减**：按访问频率和时间衰减，低价值记忆定期清理
5. **用户显式控制**：提供 `remember` / `forget` 工具让用户主动管理记忆

---

## 七、流式处理

### Q19 🟡 设计一个流式输出方案，要求支持文本流、工具调用流、错误流。

**考察点**：流式协议设计（对应本项目 runtime.stream + sse-parser）

**参考答案**：

```typescript
// 统一事件类型
type StreamEvent =
  | { type: 'text-delta'; content: string }
  | { type: 'tool-call-start'; toolCallId: string; toolName: string }
  | { type: 'tool-call-delta'; toolCallId: string; argsDelta: string }
  | { type: 'tool-call-end'; toolCallId: string; args: any }
  | { type: 'tool-result'; toolCallId: string; result: any; isError?: boolean }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; totalTokens?: number };

// Runtime 流式入口
async function* stream(input: string, ctx: RunContext): AsyncIterable<StreamEvent> {
  try {
    while (true) {
      // 1. 调用模型（流式）
      for await (const chunk of model.stream(ctx.messages)) {
        if (chunk.textDelta) yield { type: 'text-delta', content: chunk.textDelta };
        if (chunk.toolCallDelta) yield { type: 'tool-call-delta', ...chunk.toolCallDelta };
      }

      // 2. 检查是否有工具调用
      if (lastMessage.toolCalls.length === 0) {
        yield { type: 'done' };
        return;
      }

      // 3. 执行工具
      for (const tc of lastMessage.toolCalls) {
        yield { type: 'tool-call-start', toolCallId: tc.id, toolName: tc.name };
        try {
          const result = await executor.execute(tc);
          yield { type: 'tool-result', toolCallId: tc.id, result };
        } catch (err) {
          yield { type: 'tool-result', toolCallId: tc.id, result: err.message, isError: true };
        }
      }
      // 工具结果回填，进入下一轮
    }
  } catch (err) {
    // 错误不中断流，作为 error 事件下发后正常结束
    yield { type: 'error', code: 'RUNTIME_ERROR', message: err.message };
    yield { type: 'done' };
  }
}
```

**设计要点**：
1. **统一事件流抽象**：`AsyncIterable<StreamEvent>`，所有事件类型通过 discriminated union 区分
2. **事件生命周期**：工具调用有 `start → delta → end → result` 完整生命周期，UI 可据此渲染调用气泡
3. **错误不中断流**：错误作为 `error` 事件下发后正常 `done`，前端不会遇到流突然断开
4. **文本与工具调用交错**：同一轮模型输出可能既有文本又有 tool_call，按事件类型分发
5. **UI 侧应用**：可据此实现「打字机效果 + 工具调用气泡 + 错误提示 + 最终结果」

### Q20 🔴 流式输出过程中如果连接中断，如何恢复？

**考察点**：断线重连

**参考答案**：

**方案 1：断点续传（精确恢复，复杂）**：
```
1. 每个 run 有 runId，流式过程中每个 chunk 持久化（带自增 eventId）
2. 客户端断线后带 Last-Event-ID 重连
3. 服务端从该 id 之后重放未发送的 chunk
4. 工具调用用 tool_call_id 去重，避免重连后重复执行副作用工具
```

```typescript
// 服务端
app.get('/stream/:runId', async (req, res) => {
  const lastEventId = parseInt(req.headers['last-event-id'] ?? '0');
  const events = await eventStore.getEventsAfter(runId, lastEventId);
  for (const event of events) {
    res.write(`id: ${event.id}\ndata: ${JSON.stringify(event.data)}\n\n`);
  }
  // 继续推送新事件...
});
```

**方案 2：简单重跑（简单，多数场景够用）**：
```
1. 客户端断线后用相同 input 重新 invoke
2. 服务端从 Checkpointer 恢复到最近 checkpoint 继续执行
3. 已执行的工具调用因幂等性不会造成副作用
```

**关键考量**：
- **幂等性**：工具调用需幂等（带 idempotency key），避免重连后重复执行副作用工具
- **超时终止**：长时间无 chunk 视为断连，服务端主动终止 run，释放资源
- **成本权衡**：断点续传需持久化每个 chunk，开销大；多数场景简单重跑更可行
- **Checkpoint 辅助**：即使简单重跑，Checkpointer 也能避免从零开始（跳过已完成节点）

**实践建议**：短任务（< 30s）用简单重跑；长任务（> 5min）值得断点续传。

---

## 八、可观测性

### Q21 🟡 Agent 系统应该采集哪些可观测性指标？

**考察点**：可观测性设计（对应本项目 observability + observability-server）

**参考答案**：

**1. Trace（链路）**：
- 一次 run 的完整调用链，呈树状结构
- 根 span：run 级（runId / appId / sessionId / userId / status / 耗时 / 总 token / 成本）
- 子 span：每次 LLM 调用、每次工具调用
- 工具调用的 observation 回填也是 span
- W3C Trace Context：parentTraceId 支持跨系统链路跳转

**2. Metrics（指标）**：

| 类别 | 指标 |
|------|------|
| 业务 | run 数量、成功率、平均轮次、平均耗时 |
| 成本 | token 用量、调用花费（按模型统计）、cost_cents |
| 性能 | 首 token 延迟 (TTFT)、总延迟、工具执行耗时分布 |
| 错误 | 错误率、错误类型分布 (ErrorClass)、工具失败率 |

**3. Logs（日志）**：
- 关键节点日志（轮次开始/结束、工具调用）
- 模型输入输出原文（脱敏后，用于调试与回放）
- 结构化日志（JSON），便于检索与聚合

**采集架构**：
```
Agent Runtime
  → 埋点 SDK (收集 spans/metrics/logs)
  → 异步队列 (不阻塞主循环)
  → 收集服务 (observability-server)
  → 存储 (ClickHouse for traces, MySQL for metrics)
  → Dashboard (可视化)
```

### Q22 🟡 如何在不影响主流程性能的前提下实现全链路埋点？

**考察点**：埋点性能优化

**参考答案**：

```typescript
// 异步批量上报器
class TraceReporter {
  private queue: Span[] = [];
  private flushTimer: NodeJS.Timeout;

  constructor(private ingestUrl: string, private batchSize = 50, private flushIntervalMs = 1000) {
    this.flushTimer = setInterval(() => this.flush(), flushIntervalMs);
  }

  // 非阻塞入队
  report(span: Span) {
    this.queue.push(span);
    if (this.queue.length >= this.batchSize) this.flush();
  }

  // 批量 flush
  private async flush() {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.batchSize);
    try {
      await fetch(this.ingestUrl, { method: 'POST', body: JSON.stringify(batch) });
    } catch (err) {
      // 上报失败静默丢弃，不影响主流程
    }
  }
}
```

**性能优化策略**：

1. **异步上报**：埋点数据写入内存队列，worker 异步批量上报，主循环只做入队操作（< 0.1ms）
2. **采样**：高 QPS 场景按比例采样（如 10%），但**错误链路 100% 采样**（错误更需分析）
3. **批量 flush**：spans 攒批（如 50 条）后一次性写入 ClickHouse，减少 IO 次数
4. **轻量 span**：span 只记录 `id / parent / 时间戳 / 类型 / name`，大 payload（模型输入输出）单独存储或截断
5. **成本计算异步**：CostCalculator 在 flush 前批量计算，model_prices 数据 5 分钟内存缓存，避免每次查 DB
6. **失败静默**：上报失败不重试不告警，埋点绝不能影响主流程

### Q23 🔴 如何设计一个 Agent 链路的 Trace 数据模型？

**考察点**：Trace 模型设计

**参考答案**：

```sql
-- Run（根 span，一次完整 Agent 执行）
CREATE TABLE trace_runs (
  runId        String,         -- ULID
  parentTraceId String,        -- W3C 跨系统 trace 关联
  appId        String,
  sessionId    String,
  userId      String,
  status      Enum('running','success','error','timeout'),
  startTime   DateTime64(3),
  endTime     DateTime64(3),
  totalTokens UInt32,
  costCents   UInt32,          -- 成本（分）
  errorClass  LowCardinality(String),  -- 错误类型分类
  metadata    Map(String, String)
) ENGINE = MergeTree() ORDER BY (appId, startTime);

-- Span（子调用，模型调用/工具调用）
CREATE TABLE trace_spans (
  spanId       String,
  parentSpanId String,
  runId        String,
  type         Enum('model_call','tool_call','transformer'),
  name         String,          -- 模型名或工具名
  startTime    DateTime64(3),
  endTime      DateTime64(3),
  attributes   Map(String, String),  -- 输入输出摘要
  costCents    UInt32
) ENGINE = MergeTree() ORDER BY (runId, startTime);

-- 冷存储（91-180 天，S3 Parquet）
CREATE TABLE trace_archive AS trace_runs
ENGINE = S3('s3://bucket/trace_archive/', 'Parquet');
```

**数据模型设计要点**：

1. **两级结构**：Run（根 span）+ Span（子调用），形成树
2. **关系**：一个 Run 含多个 Span；Span 通过 `parentSpanId` 形成父子关系
3. **Span 类型**：`model_call`（模型调用）/ `tool_call`（工具调用）/ `transformer`（上下文变换）
4. **成本追踪**：每个 span 记录 `costCents`，由 CostCalculator 按 `model + tokens + model_prices` 计算
5. **冷热分层**：
   - 热数据 ClickHouse（90 天）→ 快速查询
   - 冷数据归档 S3 Parquet（91-180 天）→ 低成本存储
   - `queryRuns` 时间范围 > 90 天路由到 `trace_archive` 表
6. **查询**：支持按 `时间范围 / appId / status / errorClass` 过滤
7. **W3C 兼容**：`parentTraceId` 支持跨系统链路跳转（如从业务系统跳到 Agent trace）

---

## 九、工程实践

### Q24 🟡 如何对 Agent 进行自动化测试？有哪些难点？

**考察点**：Agent 测试策略

**参考答案**：

**难点**：
- LLM 输出非确定性（相同输入可能不同输出）
- 依赖外部 API（模型服务、工具 API）
- 工具有副作用（写文件、发消息）
- 长链路（多轮循环难以断言中间状态）

**分层测试策略**：

```
┌─────────────────────────────────────┐
│ Eval 测试 (端到端质量评估)          │  ← LLM-as-judge / 准确率
├─────────────────────────────────────┤
│ 集成测试 (mock model, 验证编排)     │  ← 固定响应序列 / 录制回放
├─────────────────────────────────────┤
│ 单元测试 (确定性逻辑)               │  ← 工具函数 / 解析器 / Transformer
└─────────────────────────────────────┘
```

**1. 单元测试**（确定性逻辑）：
- 工具函数：输入 → 输出，纯函数直接测
- Transformer：messages in → messages out，验证变换正确性
- 解析器：partial-json 解析、SSE 解析

**2. 集成测试**（mock 模型）：
```typescript
// mock 模型返回固定响应序列，模拟多轮对话
const mockModel = new MockModel([
  { toolCalls: [{ name: 'search', args: { q: 'weather' } }] }, // 第 1 轮：调工具
  { content: '北京今天 25°C 晴' },                              // 第 2 轮：最终回答
]);

const runtime = new Runtime({ model: mockModel, tools: [searchTool] });
const result = await runtime.run('北京天气');

expect(result.content).toBe('北京今天 25°C 晴');
expect(searchTool.execute).toHaveBeenCalledWith({ q: 'weather' });
```

**3. 评测测试（Eval）**：
- 固定测试集（输入 + 期望输出/轨迹）
- 评估指标：准确率、工具选择正确率、轨迹匹配度
- LLM-as-judge：用强模型评判输出质量

**4. 录制回放**：
- 录制真实模型响应，CI 中回放，保证可重复
- 模型升级时重录，对比差异

**5. 快照测试**：
- 对 prompt 构造结果做快照，防止 prompt 意外变更
- `expect(prompt).toMatchInlineSnapshot()`

### Q25 🟡 Node.js 环境下开发 Agent 有哪些需要特别注意的兼容性问题？

**考察点**：Node.js 工程经验（对应本项目 Node 18+ 兼容）

**参考答案**：

| 问题 | 现象 | 解决方案 |
|------|------|----------|
| ESM/CJS 互操作 | `require is not defined` | `createRequire` 桥接；package.json 设 `type: module` |
| crypto API 差异 | `globalThis.crypto` 不存在 | 用 `node:crypto`（如 ULID 用 `randomFillSync`） |
| fetch | Node 18+ 才有原生 fetch | 低版本 polyfill（`undici`） |
| 流处理 | web `ReadableStream` vs Node `stream.Readable` | 用 `stream.Readable.fromWeb()` 适配 |
| Top-level await | CJS 不支持 | 仅 ESM 支持，入口用 async main() |

**具体示例**：

```typescript
// ESM 中使用 require（如加载 CJSON 配置）
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const config = require('./aipack.config.cjs');

// ULID 生成兼容 Node 18+
import { randomFillSync } from 'node:crypto';
function ulid(): string {
  const bytes = randomFillSync(new Uint8Array(16));
  // ... 编码为 ULID 字符串
}

// fetch 流式响应处理
const response = await fetch(url);
const reader = response.body!.getReader();
const decoder = new TextDecoder();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const chunk = decoder.decode(value, { stream: true });
  // 处理 SSE chunk...
}
```

**版本兼容策略**：
- engines 声明 `node >= 18.19.0`
- CI 矩阵测试 18/20/22
- 避免使用 22+ 独有 API，或做运行时特性检测

### Q26 🔴 如何实现 Agent 的多实例水平扩展？有哪些状态需要外部化？

**考察点**：分布式 Agent

**参考答案**：

**核心原则：无状态化**——实例不持有本地状态，所有状态外部化，任意实例可处理任意请求。

**需外部化的状态**：

| 状态 | 本地方案（单机） | 外部化方案（分布式） |
|------|------------------|----------------------|
| 会话 | 内存 Map | Redis / MySQL |
| 限流 | 进程内 TokenBucket | Redis + Lua 脚本（原子操作） |
| 记忆索引 | 本地向量索引 | 向量数据库（Milvus / Pinecone） |
| 任务队列 | 内存队列 | Kafka |
| Trace | 本地文件 | ClickHouse |
| 审批状态 | 内存 pending map | Redis / MySQL |

**关键设计**：

**1. 限流分布式化**：
```typescript
// 进程内 TokenBucket 在多实例下失效（每实例独立计数，总量超标）
// 改用 Redis + Lua 脚本保证原子性
class RedisRateLimiter {
  // Lua 脚本保证「读-判-写」原子执行
  private luaScript = `
    local key = KEYS[1]
    local rate = tonumber(ARGV[1])
    local capacity = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])
    local bucket = redis.call('HMGET', key, 'tokens', 'lastRefill')
    -- ... token bucket 逻辑 ...
    return allowed
  `;
  async allow(userId: string): Promise<boolean> {
    return redis.eval(this.luaScript, 1, `ratelimit:${userId}`, rate, capacity, Date.now());
  }
}
```

**2. 会话亲和性（Sticky Session）**：
- 同一会话尽量路由到同一实例，减少锁竞争
- 负载均衡器按 `sessionId` 哈希路由
- 实例宕机时自动 failover 到其它实例（因状态已外部化）

**3. 会话锁外部化**：
- 进程内锁（KeyedMutex）跨实例无效
- 改用 Redis 分布式锁（Redlock）或数据库行锁
- 同一 sessionId 的请求串行化，避免并发修改

---

## 十、场景设计题

### Q27 🟣 设计一个「AI 旅行助手 Agent」，要求能查询航班、预订酒店、规划行程，并支持多轮对话修改。

**考察点**：完整 Agent 设计

**参考答案**：

```
┌──────────────────────────────────────────────┐
│              AI 旅行助手 Agent                │
├──────────────────────────────────────────────┤
│  工具层                                       │
│  ├─ search_flights(from, to, date)  [只读]   │
│  ├─ book_flight(flight_id, passenger)[审批]  │
│  ├─ search_hotels(dest, checkin, checkout)   │
│  ├─ book_hotel(hotel_id, guest)     [审批]   │
│  ├─ plan_itinerary(dest, days, prefs)        │
│  └─ get_user_preferences()          [只读]   │
├──────────────────────────────────────────────┤
│  记忆层                                       │
│  ├─ 用户偏好: 预算/饮食禁忌/常旅客号          │
│  └─ 历史行程: 曾去目的地/评价                 │
├──────────────────────────────────────────────┤
│  上下文管理                                   │
│  ├─ 任务状态提取: 当前行程草稿(航班+酒店+日程)│
│  └─ 多轮修改: 用户说"换便宜的酒店"→只改酒店  │
├──────────────────────────────────────────────┤
│  权限 & 可观测                                │
│  ├─ 查询自动执行, 预订需 ApprovalManager 确认 │
│  └─ 预订链路全 trace, 便于对账与回放          │
└──────────────────────────────────────────────┘
```

**设计要点**：

1. **工具集**：查询类（自动执行）+ 预订类（需审批）+ 规划类
2. **记忆**：
   - 记住用户偏好（预算范围、饮食禁忌、常旅客号）→ `get_user_preferences` 工具读取
   - 历史行程记忆 → 推荐时参考「您上次去了三亚，这次想去海边吗？」
3. **上下文管理**：
   - 多轮修改时用任务状态提取保留「当前行程草稿」
   - 用户说「换便宜的酒店」→ Agent 知道当前草稿，只重新搜索酒店部分，不重查航班
4. **权限**：
   - `search_*` 自动执行
   - `book_*` 经 ApprovalManager 确认：「确认预订 CA1234 航班？费用 ¥1200」
5. **可观测**：每次预订链路全 trace（搜索→选择→预订→确认），便于对账

### Q28 🟣 如何设计一个支持多 Agent 协作的教学系统？（一个 Agent 出题，一个 Agent 批改，一个 Agent 讲解）

**考察点**：多 Agent 编排（对应本项目 ai_teaching_agent_team）

**参考答案**：

```
                    ┌─────────────────┐
                    │  Orchestrator   │
                    │  (调度 + 决策)   │
                    └────┬────┬────┬──┘
                         │    │    │
              ┌──────────┘    │    └──────────┐
              ▼               ▼               ▼
        ┌──────────┐    ┌──────────┐    ┌──────────┐
        │ 出题 Agent│    │ 批改 Agent│    │ 讲解 Agent│
        │ (生成题目)│    │ (评判答案)│    │ (解析错题)│
        └──────────┘    └──────────┘    └──────────┘
              │               │               │
              ▼               ▼               ▼
         ┌────────────────────────────────────────┐
         │         共享黑板 (Blackboard)           │
         │  题目 / 学生答案 / 评分 / 错误分析      │
         └────────────────────────────────────────┘
```

**设计要点**：

1. **编排模式**：Orchestrator Agent 负责调度，子 Agent 通过工具调用方式协作
   - 流程：出题 Agent 生成题目 → Orchestrator 转交学生作答 → 批改 Agent 评分 → 讲解 Agent 解析错题

2. **通信——共享黑板模式**：
   - 各 Agent 读写共享上下文（state），而非直接消息传递
   - 黑板含：题目、学生答案、评分结果、错误分析
   - 优势：Agent 间解耦，Orchestrator 统一管理状态

3. **隔离**：
   - 每个子 Agent 独立 session + 独立 system prompt
   - 出题 Agent 不知道批改逻辑，批改 Agent 不知道讲解策略
   - 避免角色串扰（如批改 Agent 不会帮学生修改答案）

4. **成本控制**：
   - 子 Agent 用小模型（如 Haiku/DeepSeek），Orchestrator 用强模型（决策质量关键）
   - 讲解 Agent 仅在学生答错时触发，不需每次都调用

5. **可观测**：
   - 子 Agent 各自上报 span，组成完整 trace
   - 可追踪「哪道题错误率最高」「讲解是否有效」

---

## 十一、编码题

### Q29 🟡 实现一个带超时和重试的异步函数包装器。

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    retries?: number;
    timeout?: number;
    backoff?: 'fixed' | 'exponential';
    retryIf?: (err: unknown) => boolean;
  } = {}
): Promise<T> {
  const {
    retries = 3,
    timeout = 5000,
    backoff = 'exponential',
    retryIf = () => true,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // 超时控制：Promise.race
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout)
        ),
      ]);
      return result;
    } catch (err) {
      lastError = err;

      // 最后一次或不可重试错误 → 抛出
      if (attempt === retries || !retryIf(err)) {
        throw err;
      }

      // 退避等待
      const delay = backoff === 'exponential'
        ? Math.min(1000 * 2 ** attempt, 30000) + Math.random() * 1000 // jitter
        : 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// 使用示例
const result = await withRetry(() => callAPI(url), {
  retries: 3,
  timeout: 10000,
  backoff: 'exponential',
  retryIf: (err) => err instanceof NetworkError || err instanceof TimeoutError,
});
```

**要点**：
- 用 `Promise.race` 实现超时（生产中建议用 `AbortController` 取消底层请求）
- 指数退避：`Math.min(base * 2^attempt, maxDelay)` + jitter（避免雷同重试风暴）
- `retryIf` 默认对所有 error 重试，可定制（如仅对网络错误重试）
- 最后一次失败抛出原错误
- 生产改进：超时后用 `AbortController.abort()` 真正取消 fetch

### Q30 🔴 实现一个流式 SSE 解析器，能从 chunk 流中提取 data 事件。

```typescript
class SSEParser {
  private buffer = '';
  private eventType = '';
  private dataLines: string[] = [];

  constructor(private onEvent: (event: { event?: string; data: string }) => void) {}

  feed(chunk: string): void {
    this.buffer += chunk;

    // 按空行（\n\n 或 \r\n\r\n）分割事件块
    // 注意：最后一个可能不完整，需保留在 buffer
    const parts = this.buffer.split(/\n\n/);
    this.buffer = parts.pop() ?? ''; // 最后一段可能不完整，保留

    for (const block of parts) {
      this.parseBlock(block);
    }
  }

  private parseBlock(block: string): void {
    // 规范化换行符
    const lines = block.replace(/\r\n/g, '\n').split('\n');

    this.eventType = '';
    this.dataLines = [];

    for (const line of lines) {
      if (line.startsWith(':')) continue; // 注释行，忽略

      const colonIndex = line.indexOf(':');
      const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
      // 冒号后可能有一个空格，需去除
      let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      switch (field) {
        case 'event':
          this.eventType = value;
          break;
        case 'data':
          this.dataLines.push(value);
          break;
      }
    }

    // 有 data 才触发事件
    if (this.dataLines.length > 0) {
      const data = this.dataLines.join('\n');

      // 处理 [DONE] 标记
      if (data === '[DONE]') return;

      this.onEvent({
        event: this.eventType || undefined,
        data,
      });
    }
  }

  // flush 残留 buffer
  flush(): void {
    if (this.buffer.trim()) {
      this.parseBlock(this.buffer);
      this.buffer = '';
    }
  }
}

// 使用示例
const parser = new SSEParser(({ event, data }) => {
  console.log('Event:', event, 'Data:', JSON.parse(data));
});

for await (const chunk of streamResponse) {
  parser.feed(chunk);
}
parser.flush();
```

**要点**：
- buffer 累积 chunk，按 `\n\n`（或 `\r\n\r\n`）分割事件块
- 最后一段可能不完整（无尾随 `\n\n`），保留在 buffer 等下一个 chunk
- 每个事件块内按行解析 `field: value`，`data:` 多行用 `\n` 拼接
- 冒号后可能有一个空格，需去除
- `:` 开头的注释行忽略（SSE 心跳）
- `[DONE]` 标记特殊处理（OpenAI 流式结束标记）

---

## 十二、加分项 / 开放讨论

### Q31 🟡 你认为当前 Agent 框架最大的局限性是什么？未来如何演进？

**参考答案**：

| 局限性 | 现状问题 | 演进方向 |
|--------|----------|----------|
| 可靠性 | 模型幻觉、工具误调用 | 更强的验证机制、形式化约束、输出校验 |
| 长程任务 | 上下文遗忘，多轮后丢失早期信息 | 分层记忆、外部状态机、检查点回溯 |
| 成本 | 多轮调用昂贵，token 线性增长 | 模型路由、缓存、推测执行、prompt 压缩 |
| 可调试性 | 黑盒难排查，错误难复现 | 时间旅行调试、链路回放、决策可视化 |
| 标准化 | 各厂商接口不统一，工具生态碎片化 | MCP（Model Context Protocol）等标准 |
| 评估 | 缺乏成熟的 Agent 质量评估体系 | 自动化 eval 闭环、轨迹对比、回归测试 |

**个人看法**（面试时可展开）：
当前 Agent 框架解决了「编排」问题（如何让 LLM 循环调用工具），但没解决「可靠性」问题——模型决策仍可能出错。未来最大的突破点在于：
1. **形式化约束**：用类型系统/形式化方法约束模型输出，减少幻觉
2. **Agent 间标准协议**：如 A2A（Agent-to-Agent），让不同框架的 Agent 互操作
3. **评估闭环**：把 eval 从「事后手动」变成「CI 自动化」，像传统软件测试一样保障质量

### Q32 🟡 你对 MCP（Model Context Protocol）怎么看？它解决了什么问题？

**参考答案**：

**MCP 定义**：Anthropic 提出的开放标准协议，定义了模型与外部工具/资源的标准化通信方式。

**解决的问题**：
- **生态碎片化**：每个 Agent 框架（LangChain / AutoGPT / 自研）各自定义工具接口，工具无法跨框架复用
- **工具实现重复**：同一个「搜索」工具，LangChain 写一遍、Claude Desktop 写一遍、自研框架再写一遍

**MCP 的价值**：
```
传统:  每个框架 ← 各自实现工具 → 各个 API
MCP:   每个框架 ← MCP Client → MCP Server → 各个 API
                      ↑ 标准协议
```

- **工具一次实现，跨框架复用**：写一个 MCP Server，Claude Desktop / LangChain / 自研 Agent 都能消费
- **工具可独立部署**：MCP Server 是独立进程，与 Agent 解耦，可独立升级
- **类比**：USB-C 之于硬件接口，MCP 之于 Agent 工具接口——统一标准降低生态碎片化

**局限性**：
- 仍处于早期，生态 adoption 中
- 增加了一层 RPC 开销（本地工具调用变 IPC）
- 复杂工具的 schema 映射仍有摩擦

---

## 面试评估维度建议

| 维度 | 权重 | 考察题目 |
|------|------|----------|
| 基础概念 | 15% | Q1-Q3 |
| 架构设计 | 25% | Q4-Q6, Q27-Q28 |
| LLM 与多模型 | 15% | Q7-Q9 |
| 工具与上下文 | 20% | Q10-Q15 |
| 记忆与可观测 | 15% | Q16-Q23 |
| 工程实践与编码 | 10% | Q24-Q26, Q29-Q30 |

> 评级标准：
> - **P5（初级）**：能答对基础概念题，理解 ReAct、工具调用流程
> - **P6（中级）**：能独立设计工具系统、上下文管理方案，编码题无障碍
> - **P7（高级）**：能做架构选型权衡，设计多 Agent 协作、分布式方案
> - **P8（专家）**：对局限性有深刻思考，能提出创新性演进方向
