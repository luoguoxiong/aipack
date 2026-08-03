# Packages - Webpack 架构风格的 Agent 框架

独立实现的 Agent 框架，借鉴 webpack 架构设计思想。
**不依赖 src/ 代码**，所有功能通过 Loader（Transformer）、Plugin（Extension）等机制扩展。

## 架构映射

| Webpack          | Agent              | Package                       |
| ---------------- | ------------------ | ----------------------------- |
| Compiler         | Runtime            | `packages/runtime`            |
| Entry            | Request            | `packages/request`            |
| Module           | ContextResource    | `packages/context-resource`   |
| Dependency Graph | TaskGraph          | `packages/task-graph`         |
| Loader           | ContextTransformer | `packages/transformer`        |
| Plugin           | Extension          | `packages/extension`          |
| Loader Runner    | Pipeline           | `packages/pipeline`           |
| Bundle           | Result             | `packages/result`             |
| Resolver         | StreamFn / 模型层  | `packages/ai` + `adapters/ai` |
| tapable          | Tapable            | `packages/core/tapable`       |

## 架构层次

```
┌─────────────────────────────────────────────────────────┐
│                    packages/core                         │  契约层
│    Runtime | Request | ContextResource | TaskGraph       │  (类型与接口)
│    Transformer | Pipeline | Extension | Result  │
├─────────────────────────────────────────────────────────┤
│                   packages/runtime                       │  编排层
│              AgentRuntime (Compiler)                     │
│       对话循环 | 工具执行 | 钩子调度 | 流水线编排          │
├────────┬──────────┬──────────┬──────────┬───────────────┤
│request │context-  │task-graph│transformer│   pipeline    │  功能包
│        │resource │          │          │               │
├────────┴──────────┴──────────┴──────────┴───────────────┤
│ extension    │ result    │      ai          │  功能包
│ (模型标准化: Models/streamOpenAI/streamAnthropic)       │
└─────────────────────────────────────────────────────────┘
```

## 可运行示例

| 示例                            | 说明                                         | 运行方式                                                              |
| ------------------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| [mock.ts](examples/mock.ts)     | 基础用法（模拟 LLM，无外部依赖）             | `npx tsx packages/agentpack/examples/mock.ts`                         |
| [openai.ts](examples/openai.ts) | 手写 streamFn 接入 OpenAI 兼容 API           | `OPENAI_API_KEY=sk-xxx npx tsx packages/agentpack/examples/openai.ts` |
| [src-ai.ts](examples/src-ai.ts) | 复用 packages/ai 标准化模型，零手写 streamFn | `OPENAI_API_KEY=sk-xxx npx tsx packages/agentpack/examples/src-ai.ts` |
| [test/](test/)                  | 配置入口 + 执行入口（webpack 风格）          | `pnpm run agent` 或 `OPENAI_API_KEY=sk-xxx npm run agent`             |

## 配置入口 + 执行入口（推荐用法）

框架以 `agentpack` npm 包名导出。典型项目按 webpack 惯例分两个文件：

- **[index.config.js](test/index.config.js)** — 配置入口：集中声明 model、streamFn、tools、extensions
- **[start.js](test/start.js)** — 执行入口：加载配置 → `createRuntime` → 交互运行

```bash
npm run agent
```

配置示例（见 `packages/agentpack/test/index.config.js`）：

```javascript
import { createStreamFnFromAi, adaptAiModel } from 'agentpack/adapters/ai';
import { getBuiltinModel } from 'agentpack/ai';
import { LoggingExtension } from 'agentpack';

const aiModel = getBuiltinModel('openai', 'gpt-4o-mini');

export const config = {
  model: adaptAiModel(aiModel),
  streamFn: createStreamFnFromAi(aiModel), // 零手写 streamFn
  systemPrompt: '你是一个天气助手，用中文回答。',
  tools: [weatherTool], // 扩展点 1：工具
  extensions: [new LoggingExtension(true)], // 扩展点 2：插件
};
```

> `agentpack` 为独立 npm 包（`packages/agentpack/package.json`），构建产物在 `packages/agentpack/dist/`。
> 开发期通过根目录 tsconfig.json 的 `paths` 映射到源码（`agentpack` → `packages/agentpack/index.ts`）。

## 复用 packages/ai 标准化模型（推荐）

`packages/ai` 是从 `src/ai` 迁移过来的完整模型层（模型目录 `Models`、
`streamOpenAI` / `streamAnthropic`、认证解析、SSE 解析、用量统计、重试机制），
与 src 完全解耦。拿到标准化的 Model（`getBuiltinModel` / `createModels`），
**无需手写 streamFn**。使用适配器 `packages/adapters/ai`：

```typescript
import { createRuntime, createRequest } from './packages/agentpack';
import {
  adaptAiModel,
  createStreamFnFromAi,
} from './packages/agentpack/adapters/ai';
import { getBuiltinModel } from './packages/agentpack/ai';

const aiModel = getBuiltinModel('openai', 'gpt-4o-mini');

const runtime = await createRuntime({
  model: adaptAiModel(aiModel), // packages/ai Model -> 框架 Model
  streamFn: createStreamFnFromAi(aiModel), // 自动生成 streamFn
});

const result = await runtime.run(createRequest('你好', { sessionKey: 's1' }));
console.log(result.content);
```

适配器内部做的事：

- 把框架 `Context` 转成 `packages/ai` 的 `Context`（system 消息合并进 systemPrompt）
- 按 `model.api` 自动选择 `streamOpenAI` / `streamAnthropic`
- 把 `packages/ai` 的流式事件自动映射为框架事件（`toolcall_*` → `tool_call_*`，`done` 补 `stopReason`/`timestamp`）

> 说明：`packages/ai` 为独立实现，不依赖 `src/` 任何代码。
> 若不想使用标准化模型层，直接实现 `StreamFn` 即可（见 `examples/openai.ts`）。

## 快速开始

```typescript
import { createRuntime, createRequest } from './packages/agentpack';
import type { StreamFn, Model } from './packages/agentpack';

// 1. 定义模型
const model: Model = {
  id: 'gpt-4o',
  name: 'GPT-4o',
  provider: 'openai',
  contextWindow: 128000,
  maxTokens: 8192,
  reasoning: false,
};

// 2. 实现流式函数（接入任意 LLM 提供商）
const streamFn: StreamFn = async function* (model, context, options) {
  // 调用你的 LLM API，产出 StreamEvent
  yield { type: 'text_delta', delta: 'Hello' };
  yield { type: 'text_delta', delta: ' world' };
  yield {
    type: 'done',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello world' }],
      stopReason: 'stop',
      usage: { input: 10, output: 5, total: 15 },
      timestamp: Date.now(),
    },
  };
};

// 3. 创建 Runtime
const runtime = await createRuntime({
  model,
  streamFn,
  systemPrompt: '你是一个 AI 助手',
  workspace: '/path/to/workspace',
});

// 4. 注册工具
runtime.registerTool({
  name: 'get_weather',
  description: '获取天气',
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
  execute: async (id, args) => ({
    content: [{ type: 'text', text: `晴天, ${(args as any).city}` }],
    details: {},
  }),
});

// 5. 运行
const result = await runtime.run(
  createRequest('北京天气如何？', { sessionKey: 's1' }),
);
console.log(result.content);
console.log(result.toolsUsed);

await runtime.close();
```

## 核心概念

### 1. Runtime (Compiler)

Runtime 是整个系统的核心调度器，负责对话循环、工具执行、钩子调度。

```typescript
import { createRuntime } from './packages/agentpack';

const runtime = await createRuntime({ model, streamFn });

// 同步运行
const result = await runtime.run({ message: 'Hello', sessionKey: 's1' });

// 流式运行
for await (const chunk of runtime.stream({
  message: 'Hello',
  sessionKey: 's1',
})) {
  console.log(chunk);
}

// 会话管理
runtime.isBusy('s1'); // 是否繁忙
runtime.abort('s1'); // 终止运行
runtime.clearSession('s1'); // 清空会话
```

### 2. Request (Entry)

框架只提供通用入口 `createRequest`，渠道（CLI / Webhook / 飞书等）由使用方自行拼装：

```typescript
import { createRequest } from './packages/agentpack';

const r1 = createRequest('你好'); // 通用
const r2 = createRequest('帮我写代码', { sessionKey: 'dev-session' });
const r3 = createRequest('消息', {
  // Webhook 场景
  sessionKey: 'webhook:chat-1',
  channel: 'webhook',
  chatId: 'chat-1',
  senderId: 'user-1',
});
```

### 3. ContextResource (Module) & TaskGraph (Dependency Graph)

```typescript
import {
  buildTaskGraph,
  analyzeToolChains,
  getGraphStats,
} from './packages/agentpack';

const graph = buildTaskGraph(messages); // 构建依赖图
const chains = analyzeToolChains(graph); // 工具调用链分析
const stats = getGraphStats(graph); // 图统计
const sorted = graph.topologicalSort(); // 拓扑排序
```

### 4. ContextTransformer (Loader)

通过实现 Transformer 扩展上下文处理逻辑，类似 webpack 的 Loader。

```typescript
import { BaseTransformer } from './packages/agentpack';
import type { ContextResource, TransformContext } from './packages/agentpack';

// 自定义 Loader：例如上下文压缩
class MyCompressor extends BaseTransformer {
  readonly name = 'my-compressor';

  constructor() {
    super({ priority: 60 }); // 优先级，越小越先执行
  }

  protected async run(
    resources: ContextResource[],
    context: TransformContext,
  ): Promise<ContextResource[]> {
    // 实现你的压缩逻辑
    return resources;
  }
}

// 注册
runtime.useTransformer(new MyCompressor());
```

内置转换器：

| Transformer                       | 优先级 | 作用                            |
| --------------------------------- | ------ | ------------------------------- |
| `ToolPairingTransformer`          | 10     | 修复 tool_call/tool_result 配对 |
| `SystemMessageCleanerTransformer` | 20     | 清理重复系统消息                |
| `StateSnapshotTransformer`        | 30     | 注入状态快照                    |
| `TruncationTransformer`           | 90     | 消息截断保护                    |

### 5. Pipeline (Loader Runner)

```typescript
import { createPipeline, PipelineRunner } from './packages/agentpack';

const pipeline = createPipeline();
pipeline.use(new ToolPairingTransformer());
pipeline.use(new MyCompressor());

const runner = new PipelineRunner(pipeline);
const result = await runner.run(resources, context);
console.log(runner.getStats());
```

### 6. Extension (Plugin)

通过 Extension 在生命周期钩子中注入逻辑，类似 webpack 的 Plugin。

```typescript
import {
  BaseExtension,
  LoggingExtension,
  EventCaptureExtension,
} from './packages/agentpack';
import type { RuntimeHooks, ExtensionContext } from './packages/agentpack';

// 自定义 Plugin
class MyPlugin extends BaseExtension {
  readonly name = 'my-plugin';

  protected setup(hooks: RuntimeHooks, ctx: ExtensionContext) {
    hooks.beforeRun.tapPromise('my-plugin', async (request) => {
      console.log('收到请求:', request.message);
      return request; // waterfall 钩子必须返回值
    });

    hooks.done.tapPromise('my-plugin', async (result) => {
      console.log('完成:', result.toolsUsed);
    });

    hooks.failed.tapPromise('my-plugin', async (error, request) => {
      console.error('失败:', error.message);
    });
  }
}

runtime.registerExtension(new MyPlugin());
```

**生命周期钩子:**

```
beforeInitialize -> afterInitialize -> beforeRun
  -> beforeTransform -> afterTransform
  -> beforeEmit -> afterEmit -> done/failed
```

内置扩展：

| Extension                      | 作用             |
| ------------------------------ | ---------------- |
| `LoggingExtension`             | 生命周期日志     |
| `EventCaptureExtension`        | 事件捕获（调试） |
| `RequestInterceptorExtension`  | 请求拦截/修改    |
| `ResultPostProcessorExtension` | 结果后处理       |
| `SharedStateExtension`         | 扩展间共享状态   |

### 7. Result (Bundle)

```typescript
import { ResultBuilder, ResultAggregator } from './packages/agentpack';

const result = new ResultBuilder()
  .content('回复')
  .toolsUsed(['get_weather'])
  .stopReason('completed')
  .build();

// 流式聚合
const aggregator = new ResultAggregator();
aggregator.push({ type: 'text', content: 'Hello' });
aggregator.push({ type: 'done' });
const final = aggregator.build();
```

## 扩展点总结

| Webpack 机制     | 本框架对应      | 扩展方式                                         |
| ---------------- | --------------- | ------------------------------------------------ |
| Loader           | Transformer     | 继承 `BaseTransformer`，`useTransformer()` 注册  |
| Plugin           | Extension       | 继承 `BaseExtension`，`registerExtension()` 注册 |
| Module           | ContextResource | 自定义 ResourceType                              |
| Dependency Graph | TaskGraph       | 图分析/遍历 API                                  |
| Resolver         | StreamFn        | `setStreamFn()` 接入任意 LLM                     |
| Entry            | Request         | 工厂函数构建                                     |

## 设计原则

1. **开闭原则**: 通过 Extension 和 Tapable 钩子扩展，无需修改 Runtime 核心
2. **单一职责**: 每个 package 只负责一个概念领域
3. **依赖倒置**: 实现包依赖 core 的接口，而非具体实现
4. **独立框架**: 不依赖任何 src/ 代码，可独立使用和分发
5. **流水线模式**: Pipeline 按优先级链式执行 Transformer
6. **图结构**: TaskGraph 管理资源间的依赖关系
