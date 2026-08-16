export interface PackageInfo {
  id: string;
  name: string;
  tag: string;
  description: string;
  icon: string;
  install: string;
  features: string[];
  keyApis: { name: string; desc: string }[];
}

export const packages: PackageInfo[] = [
  {
    id: 'aipack',
    name: '@aipack-ai/agent',
    tag: '核心框架',
    description: 'Agent 框架：Runtime + Extension + Transformer 三层架构。核心调度、会话持久化、工具执行、上下文转换均自研实现，不依赖任何外部 Agent 框架。',
    icon: '📦',
    install: 'pnpm add @aipack-ai/agent',
    features: [
      'Runtime 核心调度器：请求 → 任务图 → 转换器链 → 模型 → 工具 → 结果',
      'Tapable 扩展机制：Extension 钩子 + ContextTransformer 链式转换',
      '内存/文件双会话存储，maxAge 过期惰性清理 + 存储级锁（多进程互斥）',
      'SessionManager 多会话门面：多会话共享同一 Runtime，历史/队列/状态按 key 隔离',
      '框架级 PermissionPolicy 权限层：deny-by-default + confirm 钩子 + 能力声明',
      '同步 run() + 异步 stream() 双入口',
      '内置 AI 模型层（aipack/ai）：多提供商标准化流式实现 + 可注入 CredentialStore',
      '工具调用循环：自动执行工具、结果回填，直到完成',
    ],
    keyApis: [
      { name: 'createRuntime()', desc: '创建 Runtime 核心调度器' },
      { name: 'createRequest()', desc: '构建请求入口（sessionKey 路由多会话）' },
      { name: 'createSessionManager()', desc: '多会话共享 Runtime 门面' },
      { name: 'createFileSessionStorage()', desc: '文件会话持久化（含存储级锁）' },
      { name: 'createPermissionPolicy()', desc: '框架级工具权限策略（deny-by-default）' },
      { name: 'getBuiltinModel()', desc: '获取内置 AI 模型' },
      { name: 'adaptAiModel() + createStreamFnFromAi()', desc: 'AI 层适配桥接' },
      { name: 'createToolHookExtension()', desc: '工具调用拦截钩子' },
    ],
  },
  {
    id: 'aipack-memory',
    name: '@aipack-ai/memory',
    tag: '持久化记忆',
    description: '持久化记忆插件：capture → compress → index → recall/inject → consolidate 闭环。自动捕获要点、跨会话检索注入、BM25 + 向量双路混合召回。',
    icon: '🧠',
    install: 'pnpm add @aipack-ai/memory',
    features: [
      '自动捕获：每轮对话结束自动提取要点存为可检索记忆',
      '自动注入：每轮开始自动检索相关记忆，sentinel 机制防累积',
      '零依赖 BM25 检索，支持 CJK（中日韩 bigram）分词',
      '双路独立召回：配置 Embedder 后升级为 BM25 + 向量混合检索',
      '记忆合并：增量去重、相似合并、TTL 过期修剪',
      '4 个 Agent 工具：save_memory / search_memory / list_memories / delete_memory',
      '并发安全：keyed mutex 串行化同 id 写操作',
    ],
    keyApis: [
      { name: 'createMemoryPlugin()', desc: '创建记忆插件，返回 install()' },
      { name: 'MemoryStore 接口', desc: 'save/search/consolidate/stats 等' },
      { name: 'MemoryEntry', desc: '记忆条目结构（content/concepts/confidence/...）' },
    ],
  },
  {
    id: 'aipack-compression',
    name: '@aipack-ai/compression',
    tag: '上下文压缩',
    description: '五级上下文压缩策略：L1 工具输出裁剪 → L2 消息摘要 → L3 任务状态提取 → L4 会话检查点 → L5 新会话交接。动态 import，默认关闭。',
    icon: '🗜️',
    install: 'pnpm add @aipack-ai/compression',
    features: [
      'L1 Tool Output Trim：对超大工具输出做结构保留裁剪',
      'L2 Message Summarize：超过阈值的历史消息滚动摘要',
      'L3 Task State Extraction：提取任务进度状态，压缩为结构化摘要',
      'L4 Session Checkpoint：关键节点保存会话检查点',
      'L5 New Session Handoff：超限后自动启动新会话并交接上下文',
      'Token 估算器 + 安全阈值（防止过度压缩）',
    ],
    keyApis: [
      { name: 'createCompressionTransformer()', desc: '创建压缩转换器' },
      { name: 'CompressionConfig', desc: '各层开关与阈值配置' },
    ],
  },
  {
    id: 'aipack-observability',
    name: '@aipack-ai/observability',
    tag: '可观测性',
    description: '可观测性上报 SDK（S2）：埋点上报模式，客户端只需 appId+appSecret 一行接入，6 类 Telemetry 事件自动批量上报，失败本地缓存补报。',
    icon: '📡',
    install: 'pnpm add @aipack-ai/observability',
    features: [
      '埋点上报：createObservability({ appId, appSecret, endpoint }) 一行接入',
      '6 类 Telemetry 事件自动批量上报（5s/50 条），注入 runtime 即生效',
      '失败分级容错：网络错/5xx/429 本地缓存补报，4xx 丢弃；缓存有上限裁剪',
      '上报串行合并，事件路径零阻塞、失败不阻断 run()',
      '零重依赖：运行时无第三方依赖（peer 依赖 @aipack-ai/agent）',
      '记录类型共享：RunRecord/SpanRecord/ToolCallRecord/PermissionRecord/EventBatch',
    ],
    keyApis: [
      { name: 'createObservability()', desc: 'appId + appSecret + endpoint 一行接入' },
      { name: 'HttpReporter', desc: '批量上报 + 鉴权头 + 本地缓存补报' },
      { name: 'ObservabilityTelemetry', desc: '6 类事件 → 原始记录' },
    ],
  },
  {
    id: 'aipack-observability-server',
    name: '@aipack-ai/observability-server',
    tag: '可观测性',
    description: '可观测性收集服务（S2）：接收 SDK 埋点上报，统一完成 SQLite 落盘（runs/spans/tool_calls）+ 内存聚合（p50/p95/p99）+ REST 查询，appId+Secret 鉴权。',
    icon: '🗄️',
    install: 'pnpm add @aipack-ai/observability-server',
    features: [
      '独立部署：bin `observability-server` 一键启动，或宿主应用组装 createCollector',
      '上报鉴权：appId+Secret 白名单（OBS_APPS），未授权 401 拒绝',
      'SQLite 落盘：runs / spans / tool_calls 三表 + 索引，事务批量写入',
      '在线对数直方图：p50/p95/p99 O(1) 维护，summary 查询零 SQL 聚合',
      '滑动窗口聚合：model / tool / session 三维度 + 时间序列 + 工具成功率排行',
      '5 个 REST 查询端点：/metrics/summary、/timeseries、/tools、/traces、/traces/:id',
      'TraceStore 接口抽象：可替换为 Elasticsearch / OTLP，消费侧零改动',
    ],
    keyApis: [
      { name: 'createCollector()', desc: 'ingest 鉴权 + 落盘 + 聚合 + 查询' },
      { name: 'Aggregator', desc: '滑动窗口聚合器（summary / timeseries / tools）' },
      { name: 'SQLiteStore', desc: 'TraceStore 接口实现（runs/spans/tool_calls）' },
    ],
  },
  {
    id: 'aipack-cli',
    name: '@aipack-ai/cli',
    tag: '命令行工具',
    description: '基于 aipack 框架的命令行助手。交互式聊天、会话管理、历史回放、一次性提问、模型列表、配置向导等，支持 aipack.config.js 扩展。',
    icon: '⌨️',
    install: 'pnpm add -g @aipack-ai/cli',
    features: [
      'aipack chat：交互式聊天（首次启动 API Key 向导）',
      'aipack run [message]：一次性提问，支持 stdin 管道',
      'aipack continue <key>：继续历史会话',
      'aipack replay <key>：按顺序重放用户消息复现问题',
      'aipack sessions [list|clear|delete]：会话管理',
      'aipack models：查看支持的提供商与模型（Key 状态）',
      'aipack init --local/--global：生成配置文件',
      'aipack reset [all|config|sessions|memory|logs]：数据清理',
      '支持 aipack.config.js（.js 可 import 扩展/工具/存储）',
    ],
    keyApis: [
      { name: 'loadConfig()', desc: '加载合并（默认值<配置<环境变量<CLI）配置' },
      { name: 'createAipackRuntime()', desc: '按配置创建 Runtime' },
      { name: 'startChat() / runOnce() / replaySession()', desc: '编程式能力' },
      { name: 'runSetupWizard()', desc: 'API Key 交互式配置向导' },
    ],
  },
];
