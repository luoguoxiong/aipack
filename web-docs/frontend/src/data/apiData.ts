export interface ApiParam {
  name: string;
  type: string;
  required?: boolean;
  description: string;
}

export interface ApiItem {
  id: string;
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type';
  signature: string;
  description: string;
  params?: ApiParam[];
  returns?: string;
  example?: string;
  category: string;
}

export const apiList: ApiItem[] = [
  // ========== Runtime 核心 ==========
  {
    id: 'createRuntime',
    name: 'createRuntime()',
    kind: 'function',
    signature: 'createRuntime(options?: RuntimeOptions): Runtime',
    description: '创建一个 Agent Runtime 实例。Runtime 是整个 Agent 系统的核心调度器，负责接收请求、构建任务图、执行 Pipeline 转换、调用模型、执行工具、产出结果。',
    category: 'Runtime 核心',
    params: [
      { name: 'options.config', type: 'Record<string, unknown>', description: '运行时配置对象，可被 Extension 读取' },
      { name: 'options.workspace', type: 'string', description: '工作区路径，用于日志、记忆、AI 上下文基目录' },
      { name: 'options.systemPrompt', type: 'string', description: '系统提示词，定义 AI 助手的角色与行为' },
      { name: 'options.model', type: 'Model', description: '模型配置（id/name/provider/contextWindow 等），需配合 adaptAiModel 使用' },
      { name: 'options.streamFn', type: 'StreamFn', description: '模型流式函数（模型提供者），若使用 AI 层可通过 createStreamFnFromAi 生成' },
      { name: 'options.tools', type: 'Tool[]', description: '初始工具列表，可在运行时通过 registerTool 追加' },
      { name: 'options.extensions', type: 'Extension[]', description: '预注册的扩展插件列表' },
      { name: 'options.transformers', type: 'ContextTransformer[]', description: '预注册的上下文转换器' },
      { name: 'options.pipeline', type: 'Pipeline', description: '自定义 Pipeline，覆盖默认流水线' },
      { name: 'options.sessionStorage', type: 'SessionStorage', description: '会话存储适配器，启用后会话自动持久化' },
      { name: 'options.maxTurns', type: 'number', description: '单次请求最大对话回合数，默认 50，防止失控循环' },
      { name: 'options.toolTimeoutMs', type: 'number', description: '单个工具执行超时（毫秒），默认 120000' },
      { name: 'options.parallelToolCalls', type: 'boolean', description: '是否并行执行同一轮的多个工具调用，默认 true' },
      { name: 'options.thinkingLevel', type: 'ThinkingLevel', description: '思考/推理级别，默认 off，仅对 reasoning 模型生效' },
      { name: 'options.maxResources', type: 'number', description: '上下文资源条数上限，默认 200（TruncationTransformer）' },
      { name: 'options.contextBudgetRatio', type: 'number', description: 'token 预算占 contextWindow 的比例，默认 0.8' },
    ],
    returns: 'Runtime 实例，可调用 run/stream/registerTool 等方法',
    example: `import {
  createRuntime,
  createRequest,
  createFileSessionStorage,
  getBuiltinModel,
  adaptAiModel,
  createStreamFnFromAi,
} from 'agentpack';

const aiModel = getBuiltinModel('deepseek', 'deepseek-chat');

const runtime = createRuntime({
  model: adaptAiModel(aiModel),
  streamFn: createStreamFnFromAi(aiModel),
  systemPrompt: '你是一个简洁的 AI 助手',
  sessionStorage: createFileSessionStorage({ baseDir: './sessions' }),
  maxTurns: 20,
});

const result = await runtime.run(createRequest('你好'));
console.log(result.content);
await runtime.close();`,
  },
  {
    id: 'Runtime-run',
    name: 'runtime.run()',
    kind: 'function',
    signature: 'run(request: Request): Promise<Result>',
    description: '同步执行请求，一次性返回完整结果。内部会自动处理多轮工具调用循环，直到模型不再输出工具调用或达到 maxTurns 上限。',
    category: 'Runtime 核心',
    params: [
      { name: 'request', type: 'Request', required: true, description: '通过 createRequest 构建的请求对象' },
    ],
    returns: 'Promise<Result> - 运行结果，包含 content、toolsUsed、usage、stopReason 等字段',
    example: `const result = await runtime.run(
  createRequest('解释什么是闭包', { sessionKey: 'js-101' })
);
console.log(result.content);  // 最终回复文本
console.log(result.toolsUsed); // 调用过的工具名列表
console.log(result.usage);    // Token 用量统计`,
  },
  {
    id: 'Runtime-stream',
    name: 'runtime.stream()',
    kind: 'function',
    signature: 'stream(request: Request): AsyncGenerator<ResultChunk>',
    description: '流式执行请求，逐块返回增量事件。支持文本 delta、思考 delta、工具调用开始/结束等事件类型，适合实现打字机效果或实时状态展示。',
    category: 'Runtime 核心',
    params: [
      { name: 'request', type: 'Request', required: true, description: '通过 createRequest 构建的请求对象' },
    ],
    returns: 'AsyncGenerator<ResultChunk> - 异步生成器，yield 各种类型的增量 chunk',
    example: `for await (const chunk of runtime.stream(
  createRequest('写一首关于秋天的诗')
)) {
  switch (chunk.type) {
    case 'text':
      process.stdout.write(chunk.content ?? '');  // 文本增量
      break;
    case 'thinking_delta':
      // 思考过程增量（reasoning 模型）
      break;
    case 'tool_start':
      console.log(\`\\n[工具开始] \${chunk.toolName}\`);
      break;
    case 'tool_end':
      console.log(\`\\n[工具结束] \${chunk.toolName}\`);
      break;
    case 'done':
      console.log('\\n[完成]');
      break;
    case 'error':
      console.error('错误:', chunk.error);
      break;
  }
}`,
  },
  {
    id: 'Runtime-registerTool',
    name: 'runtime.registerTool()',
    kind: 'function',
    signature: 'registerTool(tool: Tool): this',
    description: '在运行时动态注册单个工具。注册后工具立即可被下一次 run/stream 调用。支持链式调用。',
    category: 'Runtime 核心',
    params: [
      { name: 'tool', type: 'Tool', required: true, description: '工具定义，包含 name、description、parameters、execute 等字段' },
    ],
    returns: 'this - Runtime 实例，支持链式调用',
    example: `runtime.registerTool({
  name: 'get_weather',
  description: '查询指定城市的当前天气',
  parameters: Type.Object({
    city: Type.String({ description: '城市名称' }),
  }),
  execute: async (id, args) => ({
    content: [{ type: 'text', text: \`\${args.city}: 晴，25°C\` }],
    details: {},
  }),
});`,
  },
  {
    id: 'Runtime-session',
    name: '会话管理方法',
    kind: 'function',
    signature: 'listSessions() / deleteSession() / clearSession() / getMessages()',
    description: 'Runtime 提供一系列会话管理方法，用于查询、删除、清空会话，以及获取历史消息。当配置了 sessionStorage 时，这些操作会同时作用于内存和持久化存储。',
    category: 'Runtime 核心',
    params: [
      { name: 'sessionKey', type: 'string', description: '会话标识，不传则操作默认会话' },
    ],
    example: `// 列出所有会话 key
const keys = await runtime.listSessions();
console.log('会话列表:', keys);

// 获取指定会话的消息历史
const messages = runtime.getMessages('session-1');
console.log('消息数:', messages.length);

// 清除内存中的会话（不影响已持久化数据）
runtime.clearSession('session-1');

// 删除会话（内存 + 存储）
const deleted = await runtime.deleteSession('session-1');
console.log('已删除:', deleted);`,
  },

  // ========== Request 请求 ==========
  {
    id: 'createRequest',
    name: 'createRequest()',
    kind: 'function',
    signature: 'createRequest(message: string, options?: RequestOptions): Request',
    description: '构建一个请求对象，是 run/stream 的入口参数。最简单的用法只需传入消息文本，高级用法可指定 sessionKey（多轮对话）、channel、metadata 等。',
    category: 'Request 请求',
    params: [
      { name: 'message', type: 'string', required: true, description: '用户输入的消息文本' },
      { name: 'options.sessionKey', type: 'string', description: '会话标识，相同 key 的请求共享上下文，实现多轮对话' },
      { name: 'options.channel', type: 'string', description: '来源渠道标识，如 "web"、"cli"、"vscode"' },
      { name: 'options.chatId', type: 'string', description: '聊天 ID，用于关联多条消息' },
      { name: 'options.senderId', type: 'string', description: '发送者 ID，区分不同用户' },
      { name: 'options.metadata', type: 'Record<string, unknown>', description: '附加元数据，Extension 可读取' },
    ],
    returns: '标准化的 Request 对象',
    example: `// 最简单的一次性请求
const req1 = createRequest('你好');

// 启用多轮对话（同一 sessionKey 自动关联历史）
const req2 = createRequest('记住我叫张三', { sessionKey: 'user-123' });
const req3 = createRequest('我叫什么？', { sessionKey: 'user-123' });

// 带元数据的请求（Extension 中可通过 request.metadata 读取）
const req4 = createRequest('生成报告', {
  sessionKey: 'report-gen',
  channel: 'web-dashboard',
  metadata: { userId: 'u-001', priority: 'high' },
});`,
  },
  {
    id: 'RequestBuilder',
    name: 'RequestBuilder',
    kind: 'class',
    signature: 'new RequestBuilder().message(text).sessionKey(key)...build()',
    description: '链式请求构建器，适合需要逐步组装请求的场景。每个方法返回 this，最后调用 build() 生成 Request 对象。',
    category: 'Request 请求',
    example: `import { RequestBuilder } from 'agentpack';

const request = new RequestBuilder()
  .message('帮我分析这段代码')
  .sessionKey('code-review-1')
  .channel('vscode')
  .senderId('dev-alice')
  .metadata({ file: 'src/index.ts', lineStart: 100 })
  .build();

await runtime.run(request);`,
  },

  // ========== Session 会话 ==========
  {
    id: 'createFileSessionStorage',
    name: 'createFileSessionStorage()',
    kind: 'function',
    signature: 'createFileSessionStorage(options?: FileSessionStorageOptions): SessionStorage',
    description: '创建文件系统会话存储适配器。每个会话以独立 JSON 文件保存，采用 temp + rename 原子写入防止损坏。支持 maxAge 过期惰性清理。',
    category: 'Session 会话',
    params: [
      { name: 'options.baseDir', type: 'string', description: '会话存储根目录，默认 ./sessions' },
      { name: 'options.maxAge', type: 'number', description: '会话最大存活时间（毫秒），超过后在加载时惰性清理。如 30 天 = 30 * 24 * 60 * 60 * 1000' },
    ],
    returns: 'SessionStorage 实例，可传给 createRuntime 的 sessionStorage 选项',
    example: `import { createFileSessionStorage } from 'agentpack';

// 会话持久化到磁盘，30 天后自动清理
const storage = createFileSessionStorage({
  baseDir: './data/sessions',
  maxAge: 30 * 24 * 60 * 60 * 1000,  // 30 天（毫秒）
});

const runtime = createRuntime({
  // ... model/streamFn
  sessionStorage: storage,
});`,
  },
  {
    id: 'createMemorySessionStorage',
    name: 'createMemorySessionStorage()',
    kind: 'function',
    signature: 'createMemorySessionStorage(options?: MemorySessionStorageOptions): SessionStorage',
    description: '创建内存会话存储适配器。会话仅保存在内存中，进程退出即丢失。适合测试或不需要持久化的临时场景。',
    category: 'Session 会话',
    params: [
      { name: 'options.maxAge', type: 'number', description: '会话最大存活时间（毫秒），超期自动清理' },
    ],
    example: `import { createMemorySessionStorage } from 'agentpack';

const storage = createMemorySessionStorage({
  maxAge: 2 * 60 * 60 * 1000,  // 2 小时
});`,
  },

  // ========== AI 模型层 ==========
  {
    id: 'getBuiltinModel',
    name: 'getBuiltinModel()',
    kind: 'function',
    signature: 'getBuiltinModel(providerId: string, modelId: string): Model',
    description: '从内置模型目录获取标准化的 AI 模型对象。内置支持 DeepSeek、OpenAI、Anthropic、Google、Mistral、Bedrock 等多个提供商，返回的 Model 可直接传给 adaptAiModel + createStreamFnFromAi。',
    category: 'AI 模型层',
    params: [
      { name: 'providerId', type: 'string', required: true, description: '提供商 ID，如 deepseek / openai / anthropic' },
      { name: 'modelId', type: 'string', required: true, description: '模型 ID，如 deepseek-chat / gpt-4o-mini / claude-3-5-sonnet' },
    ],
    returns: '标准化 AiModel 对象（agentpack/ai 的 Model 类型）',
    example: `import { getBuiltinModel } from 'agentpack';

// 获取 DeepSeek 模型
const deepseek = getBuiltinModel('deepseek', 'deepseek-chat');

// 获取 OpenAI 模型
const gpt = getBuiltinModel('openai', 'gpt-4o-mini');

// API Key 通过环境变量自动读取（如 DEEPSEEK_API_KEY、OPENAI_API_KEY）`,
  },
  {
    id: 'adaptAiModel',
    name: 'adaptAiModel()',
    kind: 'function',
    signature: 'adaptAiModel(aiModel: AiModel): Model',
    description: 'AI 层适配器：将 agentpack/ai 的标准化 Model 转换为框架核心需要的 Model 类型。两者字段高度相似，此函数做类型桥接与字段兼容。',
    category: 'AI 模型层',
    params: [
      { name: 'aiModel', type: 'AiModel', required: true, description: '通过 getBuiltinModel 或自定义获取的 AI 模型' },
    ],
    returns: 'Runtime 可用的 core Model 类型',
    example: `const aiModel = getBuiltinModel('deepseek', 'deepseek-chat');

// 适配后传给 createRuntime
const runtime = createRuntime({
  model: adaptAiModel(aiModel),
  streamFn: createStreamFnFromAi(aiModel),
});`,
  },
  {
    id: 'createStreamFnFromAi',
    name: 'createStreamFnFromAi()',
    kind: 'function',
    signature: 'createStreamFnFromAi(aiModel: AiModel, options?): StreamFn',
    description: 'AI 层适配器：根据模型 api 字段自动分派到对应的流式实现（streamOpenAI / streamAnthropic 等），并将事件转换为 Runtime 需要的 StreamEvent 格式。是连接模型层与 Runtime 的桥梁。',
    category: 'AI 模型层',
    params: [
      { name: 'aiModel', type: 'AiModel', required: true, description: 'AI 模型对象' },
      { name: 'options.retry', type: 'RetryOptions', description: '重试配置（最大次数、退避策略等）' },
    ],
    returns: 'Runtime 可用的 StreamFn，可直接传入 createRuntime',
    example: `import {
  createRuntime,
  getBuiltinModel,
  adaptAiModel,
  createStreamFnFromAi,
} from 'agentpack';

const aiModel = getBuiltinModel('openai', 'gpt-4o-mini');

const runtime = createRuntime({
  model: adaptAiModel(aiModel),
  streamFn: createStreamFnFromAi(aiModel, {
    retry: { maxRetries: 3, baseDelayMs: 500 },
  }),
});`,
  },
  {
    id: 'getEnvApiKey',
    name: 'getEnvApiKey()',
    kind: 'function',
    signature: 'getEnvApiKey(providerId: string): string | undefined',
    description: '从环境变量读取指定提供商的 API Key。变量名规则为 <PROVIDER_ID_UPPERCASE>_API_KEY，如 deepseek → DEEPSEEK_API_KEY。',
    category: 'AI 模型层',
    params: [
      { name: 'providerId', type: 'string', required: true, description: '提供商 ID' },
    ],
    returns: 'API Key 字符串，未配置则返回 undefined',
    example: `import { getEnvApiKey, hasProviderConfigured } from 'agentpack';

const key = getEnvApiKey('deepseek');
console.log('Key 已配置:', !!key);

console.log('DeepSeek 可用:', hasProviderConfigured('deepseek'));
console.log('OpenAI 可用:', hasProviderConfigured('openai'));`,
  },

  // ========== Extension 扩展 ==========
  {
    id: 'createToolHookExtension',
    name: 'createToolHookExtension()',
    kind: 'function',
    signature: 'createToolHookExtension(options: {...}): Extension',
    description: '工具钩子扩展工厂：以声明式对象 API 注册 beforeToolCall / afterToolCall 回调。beforeToolCall 可拦截工具执行（block）、终止整个 run（terminate）或改写参数；afterToolCall 可改写结果或终止。',
    category: 'Extension 扩展',
    params: [
      { name: 'options.name', type: 'string', description: '扩展名称，默认 tool-hooks' },
      { name: 'options.beforeToolCall', type: '(ctx: ToolCallContext) => BeforeToolCallResult', description: '工具执行前回调。可返回 block:true 阻止执行、terminate:true 终止 run、args 覆盖参数' },
      { name: 'options.afterToolCall', type: '(ctx: AfterToolCallContext) => AfterToolCallResult', description: '工具执行后回调。可 terminate 终止、result 替换结果、details 合并元数据' },
    ],
    returns: 'Extension 实例，可传给 createRuntime 或 runtime.registerExtension',
    example: `import { createToolHookExtension } from 'agentpack';

const guard = createToolHookExtension({
  name: 'safety-guard',
  beforeToolCall: async (ctx) => {
    // 示例：禁止在生产环境执行危险命令
    if (ctx.tool.name === 'run_command') {
      const cmd = String(ctx.args ?? '');
      if (cmd.includes('drop table') || cmd.includes('rm -rf')) {
        return { block: true, reason: '命令被安全策略拦截' };
      }
    }
    // 示例：审计日志
    console.log(\`[\${ctx.sessionKey}] 调用工具 \${ctx.toolName}\`, ctx.args);
  },
  afterToolCall: async (ctx) => {
    if (ctx.isError) {
      // 错误上报
      reportError(ctx.result.details?.error);
      // 可选：terminate 整个 run
      // return { terminate: true };
    }
    // 合并追踪信息
    return { details: { traceId: genTraceId() } };
  },
});

const runtime = createRuntime({
  // ...model/streamFn
  extensions: [guard],
});`,
  },
  {
    id: 'BuiltinExtensions',
    name: '内置扩展',
    kind: 'class',
    signature: 'LoggingExtension / EventCaptureExtension / SharedStateExtension / ...',
    description: '框架内置多种通用扩展：LoggingExtension 日志输出、EventCaptureExtension 事件捕获（调试/监控）、RequestInterceptorExtension 请求拦截、ResultPostProcessorExtension 结果后处理、SharedStateExtension 扩展间共享状态。',
    category: 'Extension 扩展',
    example: `import {
  LoggingExtension,
  EventCaptureExtension,
  RequestInterceptorExtension,
  SharedStateExtension,
  createDefaultExtensions,
} from 'agentpack';

// 方式一：用 createDefaultExtensions 获取推荐默认值
const defaults = createDefaultExtensions({ verbose: true });

// 方式二：手动组合
const runtime = createRuntime({
  extensions: [
    new LoggingExtension(true),  // verbose 日志
    new EventCaptureExtension(2000),  // 捕获最近 2000 条事件
    // 请求预处理：在每条消息前加上前缀
    new RequestInterceptorExtension(async (req) => ({
      ...req,
      message: '[已审核] ' + req.message,
    })),
    // 共享状态：扩展间通信
    new SharedStateExtension(new Map([
      ['appName', 'my-agent'],
      ['version', '1.0.0'],
    ])),
  ],
});`,
  },

  // ========== Transformer 转换器 ==========
  {
    id: 'BaseTransformer',
    name: 'BaseTransformer',
    kind: 'class',
    signature: 'class MyTransformer extends BaseTransformer { async transform(ctx, runtime) {...} }',
    description: '上下文转换器基类。Transformer 在模型调用前执行，按 Pipeline 顺序对上下文（消息/资源）进行转换。典型用途：上下文裁剪、消息摘要、记忆注入、工具配对校验等。',
    category: 'Transformer 转换器',
    example: `import { BaseTransformer, type TransformContext } from 'agentpack';

class PrefixInjectTransformer extends BaseTransformer {
  readonly name = 'prefix-inject';

  async transform(ctx: TransformContext) {
    // 在最新 user 消息前注入上下文前缀
    const messages = [...ctx.messages];
    const lastUserIdx = [...messages].reverse().findIndex(
      m => m.role === 'user'
    );
    if (lastUserIdx >= 0) {
      const idx = messages.length - 1 - lastUserIdx;
      const msg = messages[idx];
      messages[idx] = {
        ...msg,
        content: '【知识库上下文】\\n' + (msg.content as string),
      };
    }
    return { ...ctx, messages };
  }
}

const runtime = createRuntime({
  transformers: [
    new PrefixInjectTransformer(),
    // 也可直接使用内置转换器
    ...createDefaultTransformers(),
  ],
});`,
  },
  {
    id: 'BuiltinTransformers',
    name: '内置转换器',
    kind: 'class',
    signature: 'ToolPairingTransformer / TruncationTransformer / ...',
    description: '框架内置多种转换器：ToolPairingTransformer 保证 tool_call 与 tool_result 配对（防止模型解析失败导致上下文损坏）、TruncationTransformer 按资源条数截断、TokenBudgetTransformer 按 Token 预算截断、StateSnapshotTransformer 状态快照、SystemMessageCleanerTransformer 清理重复系统消息。',
    category: 'Transformer 转换器',
    example: `import {
  createDefaultTransformers,
  ToolPairingTransformer,
  TruncationTransformer,
  TokenBudgetTransformer,
  SystemMessageCleanerTransformer,
  StateSnapshotTransformer,
  ensureToolPairing,
} from 'agentpack';

// 使用推荐默认配置（开箱即用）
const transformers = createDefaultTransformers();

// 或自定义组合
const runtime = createRuntime({
  transformers: [
    new ToolPairingTransformer(),          // 工具配对（必要）
    new SystemMessageCleanerTransformer(), // 清理重复 system
    new TruncationTransformer(300),        // 最多 300 条资源
    new TokenBudgetTransformer({ ratio: 0.75 }), // 用 75% 窗口
    new StateSnapshotTransformer(),
  ],
  maxResources: 300,
  contextBudgetRatio: 0.75,
});`,
  },

  // ========== Result 结果 ==========
  {
    id: 'Result',
    name: 'Result 接口',
    kind: 'interface',
    signature: 'interface Result { content, toolsUsed, usage, stopReason, success, error?, resources? }',
    description: 'run() 返回的结果结构。包含最终文本、工具使用情况、Token 用量、停止原因、成功标志，以及可选的错误信息和上下文资源快照。',
    category: 'Result 结果',
    params: [
      { name: 'content', type: 'string', description: '最终回复文本（助手消息纯文本）' },
      { name: 'toolsUsed', type: 'string[]', description: '本次 run 中实际调用过的工具名列表' },
      { name: 'usage', type: 'Record<string, number>', description: 'Token 用量（input/output/total/cost 等）' },
      { name: 'stopReason', type: 'string', description: '停止原因：end_turn / max_turns / terminated / error 等' },
      { name: 'success', type: 'boolean', description: '是否成功（无异常）' },
      { name: 'error', type: 'string', description: '失败原因，仅当 success=false 时存在' },
      { name: 'resources', type: 'ContextResource[]', description: '运行结束时的上下文资源快照' },
    ],
    example: `const result = await runtime.run(req);
if (result.success) {
  console.log('回复:', result.content);
  console.log('使用工具:', result.toolsUsed.join(', ') || '无');
  console.log('Token 输入:', result.usage.input);
  console.log('Token 输出:', result.usage.output);
  console.log('停止原因:', result.stopReason);
} else {
  console.error('运行失败:', result.error);
}`,
  },
];

export const apiCategories = [...new Set(apiList.map(item => item.category))];
