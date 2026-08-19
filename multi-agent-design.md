# @aipack-ai/multi-agent 设计方案

## 一、现有 @aipack-ai/agent 架构总结

当前架构核心概念：

| 层次 | 核心抽象 | 作用 |
|------|---------|------|
| 契约层 | `Message`, `Tool`, `Model`, `StreamFn`, `AgentState` | 统一数据模型 |
| 资源层 | `ContextResource` + `TaskGraph` | 消息/工具调用的DAG依赖图 |
| 调度层 | `Runtime` | 单Agent执行循环（请求→编译→转换→模型调用→工具执行→结果） |
| 扩展层 | `Extension` + `RuntimeHooks` | 生命周期钩子注入 |
| 会话层 | `SessionManager` | 多会话共享同一Runtime实例 |

**关键特征**：当前是**单Agent模型**——一个Runtime实例 = 一个Agent身份（一套 systemPrompt + model + tools），SessionManager 仅实现消息历史隔离，无 Agent 间协作能力。

---

## 二、市场多Agent方案对比

### 2.1 框架层对比

| 维度 | LangGraph | CrewAI | AutoGen | OpenAI Swarm |
|------|-----------|--------|---------|-------------|
| **架构范式** | 有向图 (DAG/StateGraph) | 角色层级 (Crew→Task→Agent) | 对话式 (AgentChat) | Handoff 转交 |
| **编排方式** | 图节点+条件边 | 顺序/层级/共识流程 | 对话轮次 | Agent间handoff |
| **通信机制** | 共享State通道 | 共享Memory | 消息传递 | 函数调用转交 |
| **状态管理** | 全局State (checkpointer) | Memory对象 | 对话历史 | 无持久化 |
| **中心化程度** | 集中式(图定义) | 集中式(Crew编排) | 去中心化(对等对话) | 半集中(handoff链) |
| **工具共享** | 图级共享 | Crew级共享 | Agent各自持有 | 函数转交 |
| **可观测性** | LangSmith | 回调 | 日志 | 打印 |
| **语言** | Python | Python | Python | Python |
| **优点** | 灵活图编排，条件分支 | 角色抽象直觉化 | 对话协作自然 | 极简，低抽象 |
| **缺点** | 学习曲线陡，过度工程 | 扩展性受限，流程僵化 | 难控制流程，token浪费 | 无持久化，太简单 |

### 2.2 协议层对比

| 维度 | A2A (Google) | MCP (Anthropic) |
|------|-------------|----------------|
| **定位** | Agent间互操作协议 | Agent↔工具互操作协议 |
| **传输** | HTTP/gRPC (JSON-RPC) | stdio/SSE (JSON-RPC) |
| **发现** | Agent Card (well-known URI) | 工具声明 (tools/list) |
| **状态** | Task state (submitted→working→completed) | 无状态协议 |
| **安全** | OAuth2 + Agent身份验证 | 本地信任模型 |
| **优点** | 跨平台Agent互操作 | 工具生态丰富，轻量 |
| **缺点** | 规范庞大，落地慢 | 非Agent间协作协议 |

### 2.3 关键洞察

- **框架层**（LangGraph/CrewAI/AutoGen/Swarm）解决"如何编排多个Agent"
- **协议层**（A2A/MCP）解决"Agent之间如何互操作"
- 生产级系统需要 **框架 + 协议** 的组合

---

## 三、@aipack-ai/multi-agent 设计方案

### 3.1 设计哲学

1. **复用现有Agent**：每个 Runtime 实例就是一个 Agent，多 Agent 就是多个 Runtime 实例的协作
2. **图编排优先**：借鉴 LangGraph，但更轻量——用现有 TaskGraph 扩展为 AgentGraph
3. **协议兼容**：内置 MCP 客户端/服务端，未来兼容 A2A
4. **TypeScript原生**：利用 async generator 和类型系统，区别于 Python 方案

### 3.2 核心架构

```
┌─────────────────────────────────────────────────────┐
│                   AgentGraph                        │
│  (有向图：定义Agent间流转逻辑)                         │
│                                                     │
│   [Planner] ──condition──▶ [Coder] ──▶ [Reviewer]  │
│       │                         ▲           │       │
│       └─────────── retry ───────┘           │       │
│                                            ▼       │
│                                      [Deployer]    │
└─────────────────────────────────────────────────────┘
          │                    │              │
          ▼                    ▼              ▼
   ┌──────────┐      ┌──────────┐    ┌──────────┐
   │ Runtime  │      │ Runtime  │    │ Runtime  │
   │ (Agent1) │      │ (Agent2) │    │ (Agent3) │
   │ model+A  │      │ model+B  │    │ model+C  │
   │ tools:[] │      │ tools:[] │    │ tools:[] │
   └──────────┘      └──────────┘    └──────────┘
          │                    │              │
          ▼                    ▼              ▼
   ┌──────────────────────────────────────────────┐
   │           SharedContext (共享上下文)            │
│  - Blackboard: 键值存储（Agent间共享数据）      │
│  - MessageBus: 发布/订阅（Agent间事件通信）     │
│  - ToolRegistry: 跨Agent工具共享               │
   └──────────────────────────────────────────────┘
```

### 3.3 核心类型设计

```typescript
// ─── 1. AgentNode: 图中的Agent节点 ─────────────────────────

interface AgentNode {
  /** 唯一标识 */
  id: string;
  /** 节点显示名 */
  name: string;
  /** Agent描述（注入到systemPrompt） */
  description: string;
  /** Runtime实例（或创建选项） */
  runtime: Runtime | RuntimeOptions;
  /** 该Agent专有的工具（除了共享工具外） */
  tools?: Tool[];
  /** 输入转换：从SharedContext提取该Agent需要的上下文 */
  inputMapping?: (ctx: SharedContext) => string | Request;
  /** 输出转换：将Agent结果写入SharedContext */
  outputMapping?: (result: Result, ctx: SharedContext) => void;
}

// ─── 2. AgentEdge: Agent间流转边 ──────────────────────────

interface AgentEdge {
  /** 源Agent */
  from: string;
  /** 目标Agent */
  to: string;
  /** 条件：决定是否走这条边（默认always） */
  condition?: (result: Result, ctx: SharedContext) => boolean;
  /** 边上的转换：修改传递给下一个Agent的输入 */
  transform?: (result: Result, ctx: SharedContext) => string | Request;
}

// ─── 3. SharedContext: Agent间共享上下文 ──────────────────

interface SharedContext {
  /** 黑板：键值共享存储 */
  blackboard: Map<string, unknown>;
  /** 事件总线：Agent间异步通知 */
  bus: EventBus;
  /** 全局工具注册表 */
  toolRegistry: ToolRegistry;
  /** 运行元数据（traceId, startTime, etc.） */
  meta: Record<string, unknown>;
}

// ─── 4. AgentGraph: 编排核心 ──────────────────────────────

interface AgentGraph {
  /** 添加Agent节点 */
  addNode(node: AgentNode): this;
  /** 添加流转边 */
  addEdge(edge: AgentEdge): this;
  /** 设置入口Agent */
  setEntry(agentId: string): this;
  /** 设置终止条件 */
  setFinish(condition: (ctx: SharedContext) => boolean): this;
  /** 执行图 */
  run(input: string | Request): Promise<MultiAgentResult>;
  /** 流式执行 */
  stream(input: string | Request): AsyncGenerator<MultiAgentEvent>;
  /** 获取执行状态 */
  getState(): GraphExecutionState;
  /** 中止执行 */
  abort(): void;
}

// ─── 5. 编排模式 (预设模板) ──────────────────────────────

// 5a. 顺序链: A → B → C
function createPipeline(agents: AgentNode[], opts?: PipelineOpts): AgentGraph;

// 5b. 路由器: Router根据输入分发到不同Agent
function createRouter(router: AgentNode, targets: AgentNode[], opts?: RouterOpts): AgentGraph;

// 5c. 层级委派: Supervisor分配子任务
function createSupervisor(supervisor: AgentNode, workers: AgentNode[], opts?: SupervisorOpts): AgentGraph;

// 5d. 辩论/评审: 多Agent交叉审核
function createDebate(proposer: AgentNode, reviewer: AgentNode, opts?: DebateOpts): AgentGraph;

// 5e. 并行MapReduce: 多Agent并行执行后合并
function createMapReduce(mapper: AgentNode, reducer: AgentNode, opts?: MapReduceOpts): AgentGraph;
```

### 3.4 编排模式详解

| 模式 | 图结构 | 典型场景 | 对标市场 |
|------|--------|---------|---------|
| **Pipeline** | 线性链 | 翻译→润色→校对 | CrewAI SequentialProcess |
| **Router** | 条件分发 | 客服意图路由→专业Agent | Swarm Handoff |
| **Supervisor** | 星形 | PM分配任务给Dev/QA/DevOps | AutoGen GroupChat + LangGraph |
| **Debate** | 环形 | 代码生成→Review→修复循环 | 无直接对标（aipack特色） |
| **MapReduce** | 扇入扇出 | 多文件并行分析→汇总 | LangGraph Send() |

### 3.5 关键创新点（vs 市场）

| 创新点 | 说明 | 对比 |
|--------|------|------|
| **Runtime即Agent** | 不发明新Agent抽象，直接复用现有Runtime | 其他框架都定义了独立的Agent类 |
| **TaskGraph扩展** | 已有DAG能力，自然扩展为Agent间依赖图 | LangGraph需从零构建 |
| **Extension桥接** | 通过Extension实现Agent间通信，无需侵入Runtime | 其他框架需改造核心 |
| **TypeScript原生** | 类型安全的图定义+async generator流式 | 全部Python方案 |
| **MCP兼容** | Agent可作为MCP Server暴露能力给外部 | 仅MCP协议层做了这个 |
| **共享Blackboard** | 简单高效的Agent间数据共享，无需消息序列化 | AutoGen需序列化完整对话 |

### 3.6 与市场方案差异矩阵

| 维度 | aipack/multi-agent | LangGraph | CrewAI | Swarm |
|------|-------------------|-----------|--------|-------|
| **语言** | TypeScript | Python | Python | Python |
| **最小抽象** | Runtime + Graph | StateGraph | Crew | Agent + handoff |
| **编排方式** | 声明式图 + 预设模板 | 声明式图 | 流程枚举 | 函数调用 |
| **Agent间通信** | Blackboard + EventBus | 全局State | Memory对象 | 函数参数 |
| **状态持久化** | 复用SessionStorage | Checkpointer | Memory | 无 |
| **流式支持** | 原生AsyncGenerator | 流式回调 | 有限 | 打印 |
| **可观测性** | 复用Telemetry + Extension | LangSmith | 回调 | 打印 |
| **权限控制** | 复用PermissionPolicy | 无 | 无 | 无 |
| **上下文压缩** | 复用Compaction | 无 | 无 | 无 |

---

## 四、模板选择决策指南

### 4.1 决策树

```
你的任务需要几个Agent？
│
├─ 2-3个，且执行顺序固定
│   └─ ✅ Pipeline
│       例：翻译→润色→校对 | 需求分析→代码生成→测试
│
├─ 需要根据输入动态选择不同Agent
│   └─ ✅ Router
│       例：客服意图分发 | 代码语言路由 | 文档类型分类处理
│
├─ 一个"管理者"需要拆解任务并分配给多个"执行者"
│   └─ ✅ Supervisor
│       例：PM分配给前端/后端/QA | CTO拆解架构给不同团队
│
├─ 需要多个Agent反复对抗/交叉审核直到达标
│   └─ ✅ Debate
│       例：代码生成↔Review循环 | 安全审计↔修复 | 辩论裁判
│
└─ 多个独立子任务可并行，最后合并结果
    └─ ✅ MapReduce
        例：多文件并行分析→汇总 | 多源搜索→综合报告
```

### 4.2 关键判据对比

| 判据 | Pipeline | Router | Supervisor | Debate | MapReduce |
|------|----------|--------|------------|--------|-----------|
| **Agent间关系** | 上下游 | 平行互斥 | 上下级 | 对等对抗 | 平行互补 |
| **执行顺序** | 固定线性 | 动态单选 | 动态多选 | 循环往返 | 并行后汇聚 |
| **子任务依赖** | 强依赖 | 互斥 | 可依赖 | 互依赖 | 完全独立 |
| **终止条件** | 最后Agent完成 | 选中Agent完成 | Supervisor判定 | 收敛/达阈值/达轮次 | Reducer完成 |
| **典型Agent数** | 2-5 | 1+N | 1+2~5 | 2-3 | N+1 |

### 4.3 按场景速查

| 场景 | 推荐模板 | 原因 |
|------|---------|------|
| 代码生成+Review | Debate | 生成→审核→修复循环，直到质量达标 |
| 客服系统 | Router | 意图识别后分发到退款/技术/订单等专业Agent |
| 内容生产流水线 | Pipeline | 大纲→撰写→排版→校对，顺序固定 |
| 项目开发 | Supervisor | PM拆解任务，分配给前端/后端/测试 |
| 批量分析 | MapReduce | 100份文档并行分析，最后汇总 |
| 数据ETL | Pipeline | 提取→清洗→转换→加载 |
| 专家会诊 | Supervisor + Debate | 先Supervisor分配，再交叉Review |
| 多语言翻译 | MapReduce | 并行翻译多语言，Reducer合并 |

### 4.4 复合模式

实际场景往往需要组合：

```
例：代码开发系统

Router（需求分类）
├─ bug修复 → Debate（生成↔Review循环）
├─ 新功能 → Supervisor（PM→Dev→QA→DevOps Pipeline）
└─ 重构 → MapReduce（多文件并行分析→合并方案）
```

**判断口诀**：
- **顺序走** → Pipeline
- **分叉走** → Router
- **有人管** → Supervisor
- **互相挑** → Debate
- **一起干** → MapReduce

---

## 五、使用示例

### 5.0 安装与导入

```bash
pnpm add @aipack-ai/multi-agent
```

```typescript
import { createRuntime, adaptAiModel } from '@aipack-ai/agent';
import {
  createPipeline,
  createRouter,
  createSupervisor,
  createDebate,
  createMapReduce,
  createAgentGraph,
} from '@aipack-ai/multi-agent';
```

### 5.1 Pipeline — 顺序链

**场景**：翻译 → 润色 → 校对

```typescript
import { createPipeline } from '@aipack-ai/multi-agent';
import { createRuntime } from '@aipack-ai/agent';

// 定义各阶段Agent
const translator = {
  id: 'translator',
  name: '翻译官',
  description: '你是一个专业翻译，将英文翻译为中文',
  runtime: createRuntime({
    model: getBuiltinModel('gpt-4o'),
    streamFn: createStreamFnFromAi(ai),
    systemPrompt: '你是一个专业翻译，将英文翻译为中文，保持语义准确。',
  }),
};

const polisher = {
  id: 'polisher',
  name: '润色师',
  description: '你是一个中文润色专家，让文字更流畅自然',
  runtime: createRuntime({
    model: getBuiltinModel('gpt-4o'),
    streamFn: createStreamFnFromAi(ai),
    systemPrompt: '你是一个中文润色专家，优化文本的流畅度和可读性，不改变原意。',
  }),
};

const proofreader = {
  id: 'proofreader',
  name: '校对员',
  description: '你是一个严谨的校对员，检查语法和事实错误',
  runtime: createRuntime({
    model: getBuiltinModel('gpt-4o'),
    streamFn: createStreamFnFromAi(ai),
    systemPrompt: '你是一个校对员，检查并修正语法错误、错别字和事实性错误。',
  }),
};

// 创建Pipeline
const pipeline = createPipeline([translator, polisher, proofreader]);

// 执行
const result = await pipeline.run('The quick brown fox jumps over the lazy dog.');
console.log(result.finalText);
// 输出: 经过翻译→润色→校对的最终中文文本
```

**流式执行**：

```typescript
for await (const event of pipeline.stream('Hello world')) {
  if (event.type === 'agent_start') {
    console.log(`[${event.agentId}] 开始处理...`);
  }
  if (event.type === 'agent_result') {
    console.log(`[${event.agentId}] 输出: ${event.result.text.slice(0, 50)}...`);
  }
}
```

### 5.2 Router — 条件路由

**场景**：客服系统，根据意图分发到不同专业Agent

```typescript
import { createRouter } from '@aipack-ai/multi-agent';

// 路由器Agent：负责意图识别
const dispatcher = {
  id: 'dispatcher',
  name: '客服调度',
  description: '识别用户意图并路由到专业客服',
  runtime: createRuntime({
    model: getBuiltinModel('gpt-4o'),
    streamFn: createStreamFnFromAi(ai),
    systemPrompt: `你是客服调度员。根据用户问题，回复以下之一：
- "refund": 退款问题
- "tech": 技术支持
- "order": 订单查询
只回复关键词，不要多余内容。`,
  }),
};

// 专业Agent
const refundAgent = {
  id: 'refund',
  name: '退款专员',
  description: '处理退款相关问题',
  runtime: createRuntime({
    model: getBuiltinModel('gpt-4o'),
    streamFn: createStreamFnFromAi(ai),
    systemPrompt: '你是退款专员，帮助用户处理退款申请，核实订单和退款资格。',
  }),
};

const techAgent = {
  id: 'tech',
  name: '技术支持',
  description: '解决产品技术问题',
  runtime: createRuntime({
    model: getBuiltinModel('gpt-4o'),
    streamFn: createStreamFnFromAi(ai),
    systemPrompt: '你是技术支持工程师，帮助用户排查和解决产品使用中的技术问题。',
  }),
};

const orderAgent = {
  id: 'order',
  name: '订单查询',
  description: '查询订单状态和物流信息',
  runtime: createRuntime({
    model: getBuiltinModel('gpt-4o'),
    streamFn: createStreamFnFromAi(ai),
    systemPrompt: '你是订单查询助手，帮用户查询订单状态、物流进度。',
  }),
};

// 创建Router（路由器根据输出关键词匹配目标Agent）
const router = createRouter(dispatcher, [refundAgent, techAgent, orderAgent], {
  // 自定义路由匹配：从dispatcher输出中提取目标Agent ID
  resolve: (dispatcherResult) => {
    const text = dispatcherResult.text.trim().toLowerCase();
    if (text.includes('refund')) return 'refund';
    if (text.includes('tech')) return 'tech';
    if (text.includes('order')) return 'order';
    return 'order'; // 默认路由
  },
});

// 执行
const result = await router.run('我的订单还没到，已经等了5天了');
// → dispatcher识别为"order" → 路由到orderAgent
console.log(result.finalText); // 订单查询结果
```

### 5.3 Supervisor — 层级委派

**场景**：PM分配任务给前端/后端/QA

```typescript
import { createSupervisor } from '@aipack-ai/multi-agent';

const pm = {
  id: 'pm',
  name: '项目经理',
  description: '拆解需求并分配给合适的开发人员',
  runtime: createRuntime({
    model: getBuiltinModel('gpt-4o'),
    streamFn: createStreamFnFromAi(ai),
    systemPrompt: `你是项目经理。分析用户需求，然后按以下格式分配任务：
{
  "tasks": [
    { "assignee": "frontend", "task": "具体任务描述" },
    { "assignee": "backend", "task": "具体任务描述" },
    { "assignee": "qa", "task": "具体任务描述" }
  ]
}
只分配相关的角色，不需要的角色不要分配。`,
  }),
  outputMapping: (result, ctx) => {
    // PM的输出解析为任务列表，写入共享上下文
    const tasks = JSON.parse(result.text);
    ctx.blackboard.set('tasks', tasks.tasks);
  },
};

const frontend = {
  id: 'frontend',
  name: '前端工程师',
  description: '负责前端UI和交互开发',
  runtime: createRuntime({
    model: getBuiltinModel('gpt-4o'),
    streamFn: createStreamFnFromAi(ai),
    systemPrompt: '你是前端工程师，根据任务描述输出前端代码方案。',
  }),
  inputMapping: (ctx) => {
    const tasks = ctx.blackboard.get('tasks') as Array<{ assignee: string; task: string }>;
    const myTask = tasks.find(t => t.assignee === 'frontend');
    return myTask ? myTask.task : '无前端任务';
  },
};

const backend = {
  id: 'backend',
  name: '后端工程师',
  description: '负责后端API和数据库设计',
  runtime: createRuntime({
    model: getBuiltinModel('gpt-4o'),
    streamFn: createStreamFnFromAi(ai),
    systemPrompt: '你是后端工程师，根据任务描述输出后端API和数据库设计方案。',
  }),
  inputMapping: (ctx) => {
    const tasks = ctx.blackboard.get('tasks') as Array<{ assignee: string; task: string }>;
    const myTask = tasks.find(t => t.assignee === 'backend');
    return myTask ? myTask.task : '无后端任务';
  },
};

const qa = {
  id: 'qa',
  name: '测试工程师',
  description: '负责编写测试用例',
  runtime: createRuntime({
    model: getBuiltinModel('gpt-4o'),
    streamFn: createStreamFnFromAi(ai),
    systemPrompt: '你是QA工程师，根据前后端方案编写测试用例。',
  }),
  inputMapping: (ctx) => {
    const feResult = ctx.blackboard.get('frontend_result') as string;
    const beResult = ctx.blackboard.get('backend_result') as string;
    return `前端方案:\n${feResult}\n\n后端方案:\n${beResult}\n\n请编写测试用例。`;
  },
};

// 创建Supervisor（PM分配 → 工作者并行执行 → 汇总）
const team = createSupervisor(pm, [frontend, backend, qa], {
  // 自定义执行策略：frontend和backend并行，qa等两者完成后再执行
  schedule: 'auto', // 'auto' 根据inputMapping依赖自动推导 | 'sequential' | 'parallel'
});

const result = await team.run('开发一个用户登录注册功能');
console.log(result.finalText);
// PM拆解 → 前端+后端并行 → QA审核
```

### 5.4 Debate — 对抗评审

**场景**：代码生成 → Review → 修复循环

```typescript
import { createDebate } from '@aipack-ai/multi-agent';

const coder = {
  id: 'coder',
  name: '代码生成器',
  description: '根据需求生成高质量代码',
  runtime: createRuntime({
    model: getBuiltinModel('gpt-4o'),
    streamFn: createStreamFnFromAi(ai),
    systemPrompt: '你是资深工程师，根据需求编写高质量代码。如果收到review意见，请修复问题并重新提交。',
  }),
};

const reviewer = {
  id: 'reviewer',
  name: '代码审查员',
  description: '审查代码质量和安全性',
  runtime: createRuntime({
    model: getBuiltinModel('gpt-4o'),
    streamFn: createStreamFnFromAi(ai),
    systemPrompt: `你是严格的代码审查员。检查代码的：
1. 正确性 2. 安全性 3. 性能 4. 可维护性
如果没有问题，回复 "LGTM"。有问题则列出具体问题。`,
  }),
};

// 创建Debate（最多3轮，reviewer说LGTM则提前结束）
const debate = createDebate(coder, reviewer, {
  maxRounds: 3,
  // 收敛条件：reviewer输出包含"LGTM"
  convergeWhen: (reviewerResult) => reviewerResult.text.includes('LGTM'),
});

const result = await debate.run('实现一个LRU Cache，支持get/put操作，容量可配置');
console.log(result.finalText);
// 第1轮: coder生成 → reviewer发现问题
// 第2轮: coder修复 → reviewer仍有小问题
// 第3轮: coder修复 → reviewer说LGTM → 结束
```

**流式监听每轮辩论**：

```typescript
for await (const event of debate.stream('实现一个LRU Cache')) {
  if (event.type === 'round_start') {
    console.log(`=== 第 ${event.round} 轮 ===`);
  }
  if (event.type === 'agent_result') {
    console.log(`[${event.agentId}]: ${event.result.text.slice(0, 100)}...`);
  }
  if (event.type === 'converged') {
    console.log(`收敛于第 ${event.round} 轮，原因: ${event.reason}`);
  }
}
```

### 5.5 MapReduce — 并行聚合

**场景**：多文件并行分析 → 汇总报告

```typescript
import { createMapReduce } from '@aipack-ai/multi-agent';

const analyzer = {
  id: 'analyzer',
  name: '代码分析师',
  description: '分析单个文件的代码质量',
  runtime: createRuntime({
    model: getBuiltinModel('gpt-4o'),
    streamFn: createStreamFnFromAi(ai),
    systemPrompt: '你是代码分析师。分析给定代码文件的质量，输出：复杂度、问题列表、改进建议。',
  }),
};

const summarizer = {
  id: 'summarizer',
  name: '总结报告员',
  description: '汇总多个分析结果生成综合报告',
  runtime: createRuntime({
    model: getBuiltinModel('gpt-4o'),
    streamFn: createStreamFnFromAi(ai),
    systemPrompt: '你是技术负责人。汇总多个文件的分析结果，生成项目级代码质量报告，包含：整体评分、关键问题Top5、改进优先级。',
  }),
};

// 创建MapReduce
const mapReduce = createMapReduce(analyzer, summarizer, {
  // 并发数限制（避免API限流）
  concurrency: 3,
  // 将输入拆分为多个子任务
  split: (input: string) => input.split('\n---\n'),  // 按分隔符拆分
});

// 输入多个文件内容
const files = [
  fs.readFileSync('src/auth.ts', 'utf-8'),
  fs.readFileSync('src/api.ts', 'utf-8'),
  fs.readFileSync('src/db.ts', 'utf-8'),
  fs.readFileSync('src/utils.ts', 'utf-8'),
].join('\n---\n');

const result = await mapReduce.run(files);
console.log(result.finalText); // 项目级代码质量报告
```

### 5.6 自定义AgentGraph — 完全灵活编排

当预设模板不满足需求时，可直接使用 `createAgentGraph` 自由定义图：

```typescript
import { createAgentGraph } from '@aipack-ai/multi-agent';

const graph = createAgentGraph()
  .addNode(planner)
  .addNode(coder)
  .addNode(reviewer)
  .addNode(deployer)
  // 规划 → 编码（始终走）
  .addEdge({ from: 'planner', to: 'coder' })
  // 编码 → 审查（始终走）
  .addEdge({ from: 'coder', to: 'reviewer' })
  // 审查 → 部署（审查通过时）
  .addEdge({
    from: 'reviewer',
    to: 'deployer',
    condition: (result) => result.text.includes('LGTM'),
  })
  // 审查 → 编码（审查不通过，打回重做）
  .addEdge({
    from: 'reviewer',
    to: 'coder',
    condition: (result) => !result.text.includes('LGTM'),
    transform: (result) => `审查意见:\n${result.text}\n\n请修复以上问题。`,
  })
  .setEntry('planner')
  .setFinish((ctx) => ctx.blackboard.get('deployed') === true);

// 执行
for await (const event of graph.stream('实现用户登录功能')) {
  console.log(`[${event.type}] ${event.agentId ?? ''}: ${event.detail ?? ''}`);
}
```

### 5.7 共享工具 + 共享状态

```typescript
import { createPipeline, SharedContext } from '@aipack-ai/multi-agent';
import { createRuntime } from '@aipack-ai/agent';

// 定义共享工具（所有Agent可用）
const sharedTools = [
  {
    name: 'read_file',
    description: '读取文件内容',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    execute: async (_id, args) => ({
      content: [{ type: 'text', text: fs.readFileSync(args.path, 'utf-8') }],
      details: args,
    }),
  },
];

// 方式1：通过SharedContext在Agent间传递数据
const pipeline = createPipeline([
  {
    id: 'researcher',
    name: '研究员',
    description: '调研技术方案',
    runtime: createRuntime({ model, streamFn, tools: sharedTools, systemPrompt: '...' }),
    // 输出写入共享上下文
    outputMapping: (result, ctx) => {
      ctx.blackboard.set('research_result', result.text);
    },
  },
  {
    id: 'writer',
    name: '撰写员',
    description: '基于调研结果撰写文档',
    runtime: createRuntime({ model, streamFn, tools: sharedTools, systemPrompt: '...' }),
    // 从共享上下文读取输入
    inputMapping: (ctx) => {
      const research = ctx.blackboard.get('research_result');
      return `基于以下调研结果撰写技术文档:\n${research}`;
    },
  },
]);

// 方式2：通过EventBus监听Agent事件
pipeline.on('agent_result', (event) => {
  console.log(`Agent ${event.agentId} 完成，token用量: ${event.result.usage?.total}`);
});
```

---

## 六、包结构规划

```
packages/multi-agent/
├── core/
│   ├── types.ts          # AgentNode, AgentEdge, SharedContext, AgentGraph
│   ├── graph.ts          # AgentGraph实现（基于TaskGraph扩展）
│   ├── context.ts        # SharedContext (Blackboard + EventBus + ToolRegistry)
│   └── executor.ts       # 图执行引擎（拓扑排序 + 条件路由 + 并行）
├── patterns/
│   ├── pipeline.ts       # createPipeline
│   ├── router.ts         # createRouter
│   ├── supervisor.ts     # createSupervisor
│   ├── debate.ts         # createDebate
│   └── map-reduce.ts     # createMapReduce
├── extensions/
│   ├── handoff.ts        # HandoffExtension (Agent间转交)
│   ├── broadcast.ts      # BroadcastExtension (结果广播)
│   └── mcp-bridge.ts     # MCPBridgeExtension (MCP互操作)
├── index.ts
├── package.json
└── test/
```

**依赖关系**：`@aipack-ai/multi-agent` → `@aipack-ai/agent`（零新外部依赖）

---

## 六、实施优先级

| Phase | 内容 | 价值 |
|-------|------|------|
| **P0** | AgentGraph核心 + Pipeline + Router | 覆盖80%用例 |
| **P1** | Supervisor + SharedContext/Blackboard | 复杂编排 |
| **P2** | Debate + MapReduce + 流式事件 | 高级模式 |
| **P3** | MCPBridge + 可视化调试 | 生态互操作 |

---

## 七、总结

aipack/multi-agent 的核心竞争力：

1. **复用已有Runtime不动核心** — 不发明新的Agent抽象，Runtime即Agent
2. **TypeScript类型安全** — 图定义+async generator流式，区别于全部Python方案
3. **图编排+预设模板双模式** — 灵活与便捷兼得
4. **内置权限和压缩能力** — 复用PermissionPolicy + Compaction，生产级就绪
5. **MCP兼容** — Agent可暴露为MCP Server，保持生态互操作
