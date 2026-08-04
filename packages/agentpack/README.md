# agentpack

Agent 框架：`Runtime + Extension + Transformer`，配置入口 + 执行入口。
核心调度、会话持久化、工具执行、上下文转换均自研实现，不依赖任何外部 Agent 框架。

## 特性

- **Runtime 核心调度器**：接收请求 → 构建任务图 → Pipeline 转换上下文 → 调用模型 → 执行工具 → 产出结果
- **扩展机制**：`Extension`（插件）通过 Tapable 钩子挂载生命周期，`ContextTransformer` 通过 Pipeline 流水线转换上下文
- **会话持久化**：内存 / 文件两种 `SessionStorage` 适配器，`maxAge` 过期惰性清理
- **流式与同步双入口**：`runtime.run()` 一次性返回，`runtime.stream()` 流式返回增量事件
- **工具循环**：模型输出 tool call → 自动执行工具 → 结果回填上下文，直到无工具调用或终止
- **可选 AI 模型层**：子模块 `agentpack/ai` 提供模型目录、多提供商流式实现与图片生成；根路径 re-export `adaptAiModel`/`createStreamFnFromAi` 一键适配，无需手写 streamFn

## 安装

```bash
npm install agentpack
# 或
pnpm add agentpack
```

## 快速开始

最小示例（推荐：与内置模型层配合，无需手写 streamFn）：

```ts
import {
  createRuntime,
  createRequest,
  createFileSessionStorage,
  getBuiltinModel,
  adaptAiModel,
  createStreamFnFromAi,
} from 'agentpack';

const aiModel = getBuiltinModel('deepseek', 'deepseek-chat'); // 需配置 DEEPSEEK_API_KEY

const runtime = createRuntime({
  model: adaptAiModel(aiModel),
  streamFn: createStreamFnFromAi(aiModel),
  systemPrompt: '你是一个简洁的 AI 助手',
  // 启用会话持久化后，同一 sessionKey 的历史会自动恢复为上下文
  sessionStorage: createFileSessionStorage({
    baseDir: './sessions',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 毫秒
  }),
});

// 同步调用
const result = await runtime.run(createRequest('你好', { sessionKey: 's1' }));
console.log(result.content);

// 流式调用
for await (const chunk of runtime.stream(
  createRequest('写一首诗', { sessionKey: 's1' }),
)) {
  if (chunk.type === 'text') process.stdout.write(chunk.content ?? '');
}

await runtime.close();
```

## 核心概念

| 模块                 | 说明                                           |
| -------------------- | ---------------------------------------------- |
| `Runtime`            | 核心调度器（`AgentRuntime` / `createRuntime`） |
| `Request`            | 请求入口（`createRequest`）                    |
| `ContextResource`    | 上下文资源单元                                 |
| `TaskGraph`          | 任务依赖图                                     |
| `ContextTransformer` | 上下文转换器                                   |
| `Extension`          | 扩展插件                                       |
| `Pipeline`           | 转换流水线                                     |
| `Result`             | 运行结果                                       |
| `Tapable`            | 事件钩子系统                                   |

## 主入口 API（`agentpack`）

### 核心类型（core）

消息模型：

```ts
type Message =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | SystemMessage;

interface BaseMessage {
  role: string;
  content: string | ContentBlock[]; // ContentBlock: text | image | toolCall | thinking
  timestamp: number;
}
```

- 内容块：`TextContent` / `ImageContent` / `ToolCallContent` / `ThinkingContent`
- 模型：`Model`（id / name / provider / contextWindow / maxTokens / reasoning）
- 工具：`Tool`（name / description / parameters / execute / prepareArguments?）
- 上下文：`Context`（systemPrompt / messages / tools?）
- 用量：`Usage`（input / output / total / cost）
- 流事件：`StreamEvent`（start / text*delta / thinking_delta / done / error / tool_call*\*）
- 工具函数：`extractText`、`extractToolCalls`、`createTextContent`、`createEmptyUsage`

### Runtime

工厂：`createRuntime(options?: RuntimeOptions): Runtime`

```ts
interface RuntimeOptions {
  config?: Record<string, unknown>;
  workspace?: string;
  systemPrompt?: string;
  model?: Model;
  streamFn?: StreamFn; // 模型提供者（若不使用 adapters/ai 则必须提供）
  tools?: Tool[]; // 初始工具列表
  extensions?: Extension[]; // 预注册扩展
  transformers?: ContextTransformer[]; // 预注册转换器
  pipeline?: Pipeline;
  sessionStorage?: SessionStorage; // 启用后会话自动持久化
}
```

方法：

| 方法                                           | 说明                                     |
| ---------------------------------------------- | ---------------------------------------- |
| `run(request): Promise<Result>`                | 执行请求（同步返回结果）                 |
| `stream(request): AsyncGenerator<ResultChunk>` | 执行请求（流式返回增量）                 |
| `registerTool / registerTools`                 | 注册工具                                 |
| `setModel / setSystemPrompt / setStreamFn`     | 运行时切换模型 / 系统提示词 / 模型提供者 |
| `registerExtension / useTransformer`           | 注册扩展 / 转换器                        |
| `getMessages(sessionKey?)`                     | 获取会话消息列表                         |
| `abort / isBusy / waitForIdle`                 | 会话中止与状态查询                       |
| `clearSession(sessionKey?)`                    | 清除内存会话（不影响已持久化数据）       |
| `listSessions()`                               | 列出所有会话 key（内存 + 存储）          |
| `deleteSession(sessionKey?)`                   | 删除会话（内存 + 存储）                  |
| `close()`                                      | 关闭运行时，释放资源                     |

### Request（入口）

- `createRequest(message, options?)` — 构建请求
- `RequestBuilder` — 链式构建器（`.message()` / `.sessionKey()` / `.channel()` 等）
- `validateRequest(request)` — 校验（message/sessionKey 非空、长度限制）
- `normalizeRequest(request)` — 标准化（补齐默认 channel/chatId/senderId 等）

### 上下文资源 / 任务图

- `ContextResourceBuilder`、`createMessageResource`、`createToolCallResource`、`createToolResultResource`
- `messageToResource(s)` / `messagesToResources` / `resourceToMessage` / `resourcesToMessages`
- `extractToolCallsFromResource` / `extractTextFromResource`
- `TaskGraphBuilder` / `createTaskGraph` / `buildTaskGraph` / `graphToMessages` / `analyzeToolChains` / `findOrphanedToolCalls` / `getGraphStats`

### Transformer

- `BaseTransformer` 基类，实现 `ContextTransformer` 接口（transform/transformBatch）
- 内置转换器：`ToolPairingTransformer`、`StateSnapshotTransformer`、`TruncationTransformer`、`SystemMessageCleanerTransformer`、`ensureToolPairing`、`createDefaultTransformers`

### Pipeline

- `PipelineRunner` / `createPipelineRunner` / `createDefaultPipeline` — 顺序执行上下文转换

### Extension

- `ExtensionManager` / `createExtensionManager` — 注册与应用扩展，管理 `RuntimeHooks`（beforeInitialize / beforeRun / done / failed 等）
- 内置扩展：`LoggingExtension`、`EventCaptureExtension`、`RequestInterceptorExtension`、`ResultPostProcessorExtension`、`SharedStateExtension`、`createDefaultExtensions`

### Result

```ts
interface Result {
  content: string; // 最终回复文本
  toolsUsed: string[]; // 使用的工具
  usage: Record<string, number>; // Token 用量
  stopReason: string;
  error?: string; // 失败原因
  success: boolean;
  resources?: ContextResource[]; // 运行结束时的资源快照
}
```

- 构建器：`ResultBuilder` / `createResult` / `createErrorResult` / `ResultAggregator` / `buildResultFromMessages` / `buildResultFromAssistantMessage` / `buildResultWithResources`

### Session（会话持久化）

- `SessionStorage` 契约：`load` / `save` / `delete` / `list`
- `createFileSessionStorage({ baseDir?, maxAge? })` — 文件存储（每会话一个 JSON 文件，`temp + rename` 原子写入）
  - **`maxAge` 单位为毫秒**：超过 `updatedAt + maxAge` 的会话在加载时惰性清理
- `createMemorySessionStorage({ maxAge? })` — 内存存储

## AI 模型层（`agentpack/ai`）

标准化模型层（内置子模块，独立于核心框架类型）：

- **类型重导出**：`Type` / `Static` / `TSchema`（来自 `@sinclair/typebox`），以及 `Model`、`Message`、`StreamEvent`、`ImagesModel`、`Provider`、`CredentialStore` 等
- **模型目录**：`Models` / `createModels(options?)`
  - `getModels(providerId?)` / `getModel(providerId, modelId)` — 查询模型
  - `stream(model, context, options)` / `complete(model, context, options)` — 流式 / 完整调用
  - `streamSimple` / `completeSimple` — 简化调用（无需预解析认证）
  - `setProvider` / `getProviders` / `getAuth` — 提供者管理
- **内置模型**：`builtinModels`、`builtinProviders`、`builtinImagesModels`、`getBuiltinModel(provider, model)`、`getBuiltinModels()`、`getBuiltinProviders()`、`BUILTIN_MODELS`、`BUILTIN_IMAGES_MODELS`、`BUILTIN_PROVIDERS`、`getEnvApiKey(provider)`、`hasProviderConfigured`
- **图片生成**：`ImagesModels` / `createImagesModels`、`generateImages(model, input, options?)`
- **工具函数**：`hasApi`、`createEmptyUsage`、`createEmptyAssistantMessage`

支持多提供商：OpenAI、Anthropic、DeepSeek、Google、Mistral、Bedrock 等（按 `model.api` 自动分派 `streamOpenAI` / `streamAnthropic` / ...）。

常用符号（`getBuiltinModel` / `getEnvApiKey` / `hasProviderConfigured` / `BUILTIN_PROVIDERS` / `AiModel` 类型）已从根路径 `agentpack` re-export；完整 surface 见 `agentpack/ai` 子路径。

## AI 适配器（`adaptAiModel` / `createStreamFnFromAi`）

把 `agentpack/ai` 的标准化模型接入核心框架（从根路径 `agentpack` 导入）：

- `adaptAiModel(aiModel)` — `agentpack/ai` 的 `Model` → 框架 `Model`
- `createStreamFnFromAi(aiModel, options?)` — 生成框架 `StreamFn`，内部自动对接 OpenAI / Anthropic 流式实现，并转换事件与内容块

```ts
import {
  createRuntime,
  getBuiltinModel,
  adaptAiModel,
  createStreamFnFromAi,
} from 'agentpack';

const aiModel = getBuiltinModel('openai', 'gpt-4o-mini');
const runtime = createRuntime({
  model: adaptAiModel(aiModel),
  streamFn: createStreamFnFromAi(aiModel),
});
```

## 会话持久化与多轮对话

同一 `sessionKey` 下多次 `run` / `stream` 会自动恢复历史并追加结果：

```ts
await runtime.run(createRequest('记住我的名字是张三', { sessionKey: 'u1' }));
const r2 = await runtime.run(createRequest('我叫什么？', { sessionKey: 'u1' }));
console.log(r2.content); // 输出：张三
```

- `maxAge` 单位为**毫秒**；需要按天配置时请自行换算（如 30 天 = `30 * 24 * 60 * 60 * 1000`）
- 存储格式：`StoredSession`（key / version / messages / model / usage / createdAt / updatedAt）

## 工具注册示例

```ts
import { Type } from 'agentpack/ai';

const runtime = createRuntime({
  model: adaptAiModel(aiModel),
  streamFn: createStreamFnFromAi(aiModel),
  tools: [
    {
      name: 'get_weather',
      description: '查询城市天气',
      parameters: Type.Object({ city: Type.String() }),
      execute: async (id, args) => ({
        content: [{ type: 'text', text: `${args.city}: 晴，25°C` }],
        details: {},
      }),
    },
  ],
});
```

## 相关项目

- [agentpack-cli](../agentpack-cli/README.md) — 基于本框架的命令行工具（交互式聊天、会话回放、继续会话等）
