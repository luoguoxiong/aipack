# agentpack-memory：上下文管理插件实现方案

## Context（背景与目标）

`agentpack` 框架目前只有「会话级线性消息持久化」（`FileSessionStorage`），跨会话、跨主题的长期记忆缺失——每次新会话都要重新解释架构、重新发现同样的约束。参考 `rohitg00/agentmemory` 的核心闭环（**capture → compress → index → recall/inject → consolidate**，默认零依赖 BM25 + 可选本地 embedding，可选 LLM 摘要），为 agentpack 新增一个独立 npm 包 `agentpack-memory`，作为 Extension + Transformer + Tool 组合插件，实现：每轮对话自动捕获要点存为可检索记忆、每轮自动检索相关记忆注入上下文、提供 Agent 可调用的记忆工具、定期合并去重与生命周期修剪。默认零依赖、零 API Key，开箱即用；embedding 与 LLM 摘要均为可选可插拔。

## 已核验的框架约束（决定设计的关键事实，均带行号）

1. **`buildContext` 过滤 `role==='system'` 消息** —— `packages/agentpack/runtime/index.ts:585` `messages.filter(m => m.role !== 'system')`。故注入必须用 `role:'user'`，`role:'system'` 资源不会到达模型。
2. **`transformMessages` 原地 splice** —— `runtime/index.ts:565-578`，且 `compilation.messages` 与 `session.messages` 共享引用（`createCompilation:308-319`）。Transformer 输出会持久化进会话存储（`finally → persistSession:254`）。注入内容若不每轮清理会跨轮累积。
3. **`meta` 在 message↔resource 往返中丢失** —— `context-resource/index.ts:30-38`（user 消息 → resource 不带 meta）、`112-119`（resource → user 消息只取 role/content/timestamp）。故跨轮标记旧注入不能用 `meta.injectedBy`，必须用**内容内 sentinel**（随 content 持久化，下轮可识别）。
4. **`done` 钩子签名已扩展为 `AsyncSeriesHook<[Result, Request?]>`** —— `core/extension.ts:35`，框架在 done 阶段透传最终 `Request`（含 `.message`/`.sessionKey`）。capture 在 `beforeRun`（收 `Request`）stash、`done` 用 `request.sessionKey` 精确配对消费。
5. **Pipeline 按优先级升序** —— `core/pipeline.ts`。内置：ToolPairing(10)、SystemMessageCleaner(20)、StateSnapshot(30)、Truncation(90)。注入器 priority=5 最先执行。
6. **CLI 透传 extensions/transformers/tools** —— `agentpack-cli/src/runtime.ts:78-92`（`...runtimeOverrides` 展开）、`config.ts:226-240`（只收配置文件显式字段）。用户在 `agentpack.config.js` import 后展开 `install()` 即生效。
7. **`extractTextFromResource` 已导出** —— `context-resource/index.ts:177-181`，兼容 string 与 `ContentBlock[]`。
8. **FileSessionStorage 范式** —— `session/file.ts`：`resolveBaseDir`（处理 `~`/绝对/相对）、`encodeURIComponent` 文件名、原子写 `tmp+rename`、`maxAge` 惰性删除。镜像之。

## 核心设计决策

### 决策 A：注入机制 —— sentinel 包裹的记忆块合并进最新 user 消息内容，每轮「先剥后注」

最新 `user_message` 资源的 content 前插一个 sentinel 包裹块：

```
<<<AGENTPACK_MEMORY>>>
[Relevant memories]
- <content> (score=0.82, id=mem_xxx)
...
<<</AGENTPACK_MEMORY>>>

<原始用户消息文本>
```

- **为何合并进最新 user 消息而非新增独立 user 资源**：避免「连续两条 user 消息」在不同 provider 下的解析差异；对话语义更自然。
- **为何用 sentinel 而非 meta**：依据约束 #3，meta 往返丢失；sentinel 是 content 的一部分，随消息持久化且下轮可识别剥离。
- **content 两分支**：string → `memoryBlock + '\n\n' + stripMemoryBlock(text)`；`ContentBlock[]` → 过滤掉含 sentinel 的旧文本块后，前插 `createTextContent(memoryBlock + '\n\n')`（保留图片等非文本块）。
- **每轮流程（runLoop 每次 iteration 都跑，幂等）**：①遍历所有 user_message 资源剥除其 content 中的 sentinel 块（清上轮注入，含已持久化进 session 的）；②取最新 user_message 纯文本为检索 query；③`HybridRetriever` 取 top-K，`minScore` 过滤；④非空则构造块前插进最新 user 消息；⑤返回 resources。

### 决策 B：capture 的 beforeRun+done stash 机制（按 sessionKey 精确配对）

`MemoryCaptureExtension` 内部 `pending: Map<sessionKey, { message }>`（键控 Map，非 FIFO）。

- `beforeRun.tapPromise`：`pending.set(request.sessionKey, { message: request.message })`，返回原 request（不改请求）。
- `done.tapPromise`：agentpack `RuntimeHooks.done` 签名已扩展，框架将最终 `Request` 作为第二参数传入；扩展用 `request.sessionKey` 从 Map 精确取回 stash 并与本轮结果配对 —— 彻底解决旧 FIFO 设计在并发多会话下错配/丢失的问题。框架保证同一 sessionKey 的 run 串行执行，故 Map 键控安全。
- 组装 `MemoryEntry`（content = 摘要或 `Q: <message>\nA: <answer>`，concepts、confidence 捕获默认 0.6/摘要 0.8）→ `store.save` → 每 `consolidateEvery` 次触发 `store.consolidate()`。失败 try/catch 吞错并 `onEvent('capture:failed')`，不影响运行。
- **failed 钩子**：本轮失败不捕获（仅成功回合入库），无残留状态需清理。

### 决策 C：零依赖 BM25 + 可插拔 Embedder（双路独立召回）

默认 `BM25Retriever`（零依赖），tokenizer 支持 latin（小写化 + 按非字母数字分割）与 CJK（相邻两字 bigram，覆盖汉字扩展/兼容区、日文假名、韩文谚文；奇数长度串尾部补单字，保证单字查询可命中）。提供 `Embedder` 接口则升级为**双路独立召回**：BM25 路 + 向量路（独立 `VectorIndex`，不受 BM25 候选池封顶）各自召回 top-`limit*3`，按 id 并集加权融合（各自 min-max 归一化后 `(w_bm25·bm25 + w_embed·cos)/wSum`，过滤 `< minScore`）；配置了 embedder 但 store 无向量能力时退化为「BM25 候选 + 向量重排」兼容路径。无 embedder 退化为纯 BM25。`search(query, limit, opts)` 支持 `opts.raw` 原始分数模式（不做归一化，供合并器按绝对阈值判定）与 `opts.minScore` 覆盖（注入器携带本地阈值，不篡改共享 retriever）。不引入 `@huggingface/transformers`，用户可自行实现 `Embedder` 接入 ollama/transformers。

## 文件树

```
packages/agentpack-memory/
├── package.json              # name: agentpack-memory, 仅 peer+dev 依赖 agentpack, ESM, tsup
├── tsconfig.json             # extends ../../tsconfig.json, include index.ts/src/examples
├── tsup.config.ts            # 镜像 agentpack: format esm, target es2022, dts, skipNodeModulesBundle
├── README.md                 # overview/install/programmatic API/config.js wiring/options/工具/限制
├── index.ts                  # 公共出口（聚合 export）
├── src/
│   ├── types.ts              # MemoryEntry / MemoryStore / MemorySearchResult / Embedder / SummarizeFn / 选项 / MemoryStats
│   ├── store/
│   │   ├── memory-index.ts        # MemoryIndex：entries Map + BM25 倒排 + 独立 VectorIndex（两 store 复用）
│   │   ├── file-memory-store.ts   # FileMemoryStore（每条一 JSON, 原子写, 懒加载并发读, keyed-mutex 写串行）
│   │   ├── in-memory-store.ts     # InMemoryStore（内存版，finalizeEntry 入口）
│   │   └── index.ts
│   ├── retrieval/
│   │   ├── tokenizer.ts           # tokenize(text): latin + CJK bigram 分词, STOPWORDS
│   │   ├── bm25.ts                # BM25Index {add,remove,search} + BM25Retriever
│   │   ├── embedder.ts            # Embedder 接口 + cosine(a,b) + minMaxNormalize
│   │   ├── vector-index.ts        # VectorIndex：暴力精确检索 + IVF 分桶近似检索
│   │   ├── hybrid-retriever.ts    # HybridRetriever（BM25 + 向量双路独立召回融合 / raw 模式）
│   │   └── index.ts
│   ├── capture/
│   │   ├── extractor.ts           # extractFromTurn + runCaptureExtractor（零-LLM 要点压缩 + 可选 summarizeFn 兜底）
│   │   ├── capture-extension.ts   # MemoryCaptureExtension extends BaseExtension（sessionKey 配对）
│   │   └── index.ts
│   ├── injection/
│   │   ├── sentinels.ts           # MEMORY_BLOCK_START/END 常量 + stripMemoryBlock/wrapMemoryBlock/buildMemoryBlock
│   │   ├── injection-transformer.ts # MemoryInjectionTransformer extends BaseTransformer (priority 5)
│   │   └── index.ts
│   ├── consolidation/
│   │   ├── consolidator.ts        # Consolidator: 增量候选 + 去重/合并（置信度 max+bonus）/修剪
│   │   └── index.ts
│   ├── tools/
│   │   ├── memory-tools.ts        # createMemoryTools(store) -> Tool[] (纯 JSON Schema 参数 + 输入校验)
│   │   └── index.ts
│   ├── utils/
│   │   └── keyed-mutex.ts         # KeyedMutex：同 id 写操作串行化
│   └── plugin.ts                  # createMemoryPlugin(options) -> {store, retriever, extensions, transformers, tools, install(), dispose()}
├── tests/                         # node:test 单测（tokenizer/bm25/vector-index/hybrid/consolidator/stores/concurrency）
└── examples/
    └── round-trip.ts          # 验证脚本（不依赖真实 LLM，假 streamFn + InMemoryStore）
```

## 关键 API 签名

### `src/types.ts`

```ts
export interface MemoryEntry {
  id: string;
  content: string;
  concepts: string[];
  confidence: number; // 0..1
  source: 'capture' | 'tool' | 'consolidation';
  sessionKey?: string;
  createdAt: number;
  updatedAt: number; // 仅表示内容修改时间（检索不刷新）
  lastRecalledAt?: number;
  recallCount: number;
  embedding?: number[];
  expiresAt?: number; // TTL 过期时间（save 时 ttlMs 换算）
  meta?: Record<string, unknown>;
}
export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
  matchedBy: 'bm25' | 'embedding' | 'hybrid';
}
export interface MemoryStore {
  save(entry: MemorySaveInput): Promise<MemoryEntry>; // ttlMs 换算为 expiresAt；显式 id/createdAt 可覆盖
  get(id: string): Promise<MemoryEntry | null>;
  delete(id: string): Promise<boolean>;
  list(limit?: number): Promise<MemoryEntry[]>;
  search(query: string, limit?: number): Promise<MemorySearchResult[]>;
  searchVectors(
    queryVec: number[],
    limit?: number,
  ): Promise<MemorySearchResult[]>;
  touchRecall(id: string, at?: number): Promise<void>;
  consolidate(
    options?: ConsolidateOptions,
  ): Promise<{ merged: number; pruned: number }>;
  prune(options?: {
    maxAgeMs?: number;
    minConfidence?: number;
  }): Promise<number>;
  count(): Promise<number>;
  setConsolidator(consolidator: ConsolidatorLike): void;
  markConsolidated(at?: number): void; // 记录合并时间（驱动增量候选窗口）
  stats(): Promise<MemoryStats>; // 统计快照（count/bySource/avgConfidence/recall/lastConsolidatedAt...）
  dispose(): void; // 释放资源
}
export interface Embedder {
  embed(text: string): Promise<number[]>;
  dimension?: number;
}
export type SummarizeFn = (input: {
  userMessage: string;
  assistantContent: string;
  toolsUsed: string[];
}) => Promise<{ summary: string; concepts?: string[] } | null>;
export interface ConsolidateOptions {
  similarityThreshold?: number;
  maxMemories?: number;
  maxAgeMs?: number;
  minConfidence?: number;
}
```

### `src/store/file-memory-store.ts` —— `FileMemoryStore implements MemoryStore`

- `resolveBaseDir(baseDir?)`：处理 `~`/绝对/相对，默认 `path.join(process.cwd(), '.agentpack', 'memory')`。
- 每条一文件 `<baseDir>/<encodeURIComponent(id)>.json`，原子写 `tmp+rename`（镜像 `session/file.ts`）。
- 内存缓存 `Map<id, MemoryEntry>` + `BM25Index`，save/delete 增量更新；首次 `list` 懒构建。`maxAge` 加载时惰性删除过期条目。
- `search` 委托内部 BM25；`consolidate` 委托 `Consolidator`。

### `src/retrieval/bm25.ts`

```ts
export class BM25Index {
  constructor(options?: { k1?: number; b?: number }); // k1=1.5, b=0.75
  add(id: string, tokens: string[]): void;
  remove(id: string): void;
  search(
    queryTokens: string[],
    limit?: number,
  ): Array<{ id: string; score: number }>;
  size(): number;
}
export class BM25Retriever {
  constructor(index: BM25Index, entries: Map<string, MemoryEntry>);
  search(query, limit?): Promise<MemorySearchResult[]>;
}
```

经典 BM25（`idf = ln((N - df + 0.5)/(df + 0.5) + 1)`），分数不归一化（由 HybridRetriever 归一化）。

### `src/retrieval/hybrid-retriever.ts`

```ts
export interface HybridRetrieverOptions {
  bm25: RetrieverLike; // BM25Retriever 或包装任意 MemoryStore 的 StoreBackedRetriever
  vector?: VectorSearchLike; // store.searchVectors（独立向量召回源）
  embedder?: Embedder;
  bm25Weight?: number; // 默认 0.5
  embedWeight?: number; // 默认 0.5
  minScore?: number; // 默认 0.1
}
export interface HybridSearchOptions {
  minScore?: number; // 覆盖默认阈值（注入器携带本地阈值，不篡改共享 retriever）
  raw?: boolean; // 原始分数模式：不做 min-max 归一化（供合并器按绝对阈值判定）
}
export class HybridRetriever {
  constructor(opts: HybridRetrieverOptions);
  search(
    query: string,
    limit?: number,
    opts?: HybridSearchOptions,
  ): Promise<MemorySearchResult[]>;
}
```

无 embedder → 纯 BM25（归一化过滤截断）。有 embedder + 向量源 → **双路独立召回**：BM25 路与向量路各自召回 top-`limit*3`，按 id 并集、各自 min-max 归一化后 `(w_bm25·bm25 + w_embed·cos)/wSum` 融合 → 过滤 `< minScore` → 截 limit。有 embedder 但无向量源 → 退化为「BM25 候选 + 向量重排」。`raw` 模式下双路取 max（任一来源判定相似即相似），保证绝对阈值有意义。

### `src/injection/sentinels.ts`

```ts
export const MEMORY_BLOCK_START = '<<<AGENTPACK_MEMORY>>>';
export const MEMORY_BLOCK_END = '<<</AGENTPACK_MEMORY>>>';
export function stripMemoryBlock(text: string): string; // 正则剥离 + trim
export function wrapMemoryBlock(lines: string[]): string; // 包裹
export function buildMemoryBlock(results: MemorySearchResult[]): string;
```

### `src/injection/injection-transformer.ts` —— `MemoryInjectionTransformer extends BaseTransformer`

```ts
export interface InjectionOptions {
  enabled?: boolean;
  priority?: number; // 默认 5（最先执行）
  maxMemories?: number; // 默认 5
  minScore?: number; // 默认 0.1（本地阈值，不写回共享 retriever）
  queryTransform?: (text: string) => string;
  onRecall?: (ids: string[]) => void | Promise<void>; // 命中后更新检索统计（fire-and-forget）
}
export class MemoryInjectionTransformer extends BaseTransformer {
  readonly name = 'memory-injection'; // priority 5
  constructor(retriever: HybridRetriever, options?: InjectionOptions);
  protected async run(
    resources: ContextResource[],
    context: TransformContext,
  ): Promise<ContextResource[]>;
}
```

`run` 严格按决策 A：剥除所有 user 消息中的旧 sentinel 块 → 取最新 user_message 纯文本为 query → `retriever.search(query, maxMemories, { minScore })` → 命中后 `onRecall(ids)`（不阻塞首 token）→ 非空则构造块前插（string / `ContentBlock[]` 两分支，用 `ContextResourceBuilder` 重建，保留图片等非文本块）。

### `src/capture/capture-extension.ts` —— `MemoryCaptureExtension extends BaseExtension`

```ts
export interface CaptureOptions {
  enabled?: boolean;
  summarizeFn?: SummarizeFn;
  minLength?: number; // 默认 12
  maxConcepts?: number; // 默认 8
  maxContentChars?: number; // 默认 2000
  consolidateEvery?: number; // 每 N 次捕获触发一次合并（0=不自动）
  ttlMs?: number; // 捕获记忆 TTL（ms）
  onEvent?: MemoryEventSink; // 捕获失败事件接收器
}
export class MemoryCaptureExtension extends BaseExtension {
  readonly name = 'memory-capture';
  constructor(store: MemoryStore, options?: CaptureOptions);
  protected setup(hooks: RuntimeHooks, context: ExtensionContext): void; // beforeRun stash + done 按 sessionKey 配对落盘（决策 B）
}
```

### `src/consolidation/consolidator.ts`

```ts
export class Consolidator {
  constructor(
    store: MemoryStore,
    retriever: HybridRetriever,
    options?: { similarityThreshold?: number; onEvent?: MemoryEventSink },
  );
  async run(
    options?: ConsolidateOptions,
  ): Promise<{ merged: number; pruned: number }>;
}
```

**增量候选**：仅处理 `updatedAt >= stats().lastConsolidatedAt` 的条目（touchRecall 不刷新 updatedAt，故 updatedAt 稳定表示内容修改时间；首次/跨进程重启为全量），按 updatedAt 降序。对每个候选：以其 content 为 query `retriever.search(content, 10, { raw: true })`（raw 原始分数，绝对阈值才有意义）→ `score >= threshold`（默认 0.85）的相似项合并进幸存者 → 合并（content 取较长/较新、concepts 并集、`confidence=min(1, max(a,b)+0.05)` 防饱和、recallCount 相加、createdAt 保留最早、`source='consolidation'`）→ 删被合并项 → `prune(maxAgeMs, minConfidence)` → 数量上限淘汰最低置信度 → `markConsolidated()` 驱动下一轮窗口。consolidate 为 best-effort，无全局锁（逐 id 锁原子化，新写入条目留到下一轮）。

### `src/tools/memory-tools.ts`

```ts
export function createMemoryTools(
  store: MemoryStore,
  options?: { listLimit?: number },
): Tool[];
```

4 个 Tool（`Tool`/`createTextContent` 来自 `agentpack`，`parameters` 用**纯 JSON Schema 对象**，不依赖 TypeBox）：`save_memory(content, concepts?)` / `search_memory(query, limit?)` / `list_memories(limit?)` / `delete_memory(id)`。`execute` 返回 `ToolResult`。

### `src/plugin.ts` —— `createMemoryPlugin`

```ts
export interface MemoryPluginOptions {
  baseDir?: string;
  store?: MemoryStore;
  maxMemories?: number; // 注入 top-K，默认 5
  minScore?: number; // 最低相关度阈值，默认 0.1
  capture?: boolean | CaptureOptions;
  inject?: boolean | InjectionOptions;
  tools?: boolean;
  embedder?: Embedder;
  summarizeFn?: SummarizeFn;
  consolidateEvery?: number; // 每 N 次捕获自动合并（0=不自动）
  captureTtlMs?: number; // 捕获记忆 TTL（ms）
  toolTtlMs?: number; // save_memory 工具保存记忆的 TTL（ms）
  onEvent?: MemoryEventSink; // 事件接收器（默认打印失败告警）
}
export interface MemoryPlugin {
  store: MemoryStore;
  retriever: HybridRetriever;
  extensions: Extension[];
  transformers: ContextTransformer[];
  tools: Tool[];
  install(): {
    extensions: Extension[];
    transformers: ContextTransformer[];
    tools: Tool[];
  };
  dispose(): void; // 释放资源（热重载场景）
}
export function createMemoryPlugin(options?: MemoryPluginOptions): MemoryPlugin;
```

默认 store=`FileMemoryStore`、retriever=`HybridRetriever`（无 embedder 纯 BM25）、capture=true、inject=true、tools=true。`install()` 返回三数组，供 `agentpack.config.js` 展开到 `extensions`/`transformers`/`tools`。插件层将 `StoreBackedRetriever`（包装 store.search）与 `StoreVectorSource`（包装 store.searchVectors）装配进 HybridRetriever，注入 transformer 的 `onRecall` 装配为 `store.touchRecall`（fire-and-forget）。

### `index.ts`

聚合 export 全部类型与实现；从 `agentpack` 再导出 `Extension`/`ContextTransformer`/`Tool`/`ToolResult` 类型方便单一 import。

## `agentpack.config.js` 接入示例（写入 README）

```js
import { createMemoryPlugin } from 'agentpack-memory';
const mem = createMemoryPlugin({
  baseDir: '~/.agentpack/memory',
  maxMemories: 5,
});
export default {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  systemPrompt: 'kum',
  sessions: { enabled: true, baseDir: './sessions', maxAge: 30 },
  extensions: mem.install().extensions,
  transformers: mem.install().transformers,
  tools: mem.install().tools,
};
```

（实际写法：`const mem = createMemoryPlugin({...}); const r = mem.install(); export default { ..., extensions: r.extensions, transformers: r.transformers, tools: r.tools };`，避免重复构造。）

## 依赖与构建

- `package.json`：`"type":"module"`、tsup、`exports` map、`engines.node>=18`、`peerDependencies: { agentpack: "workspace:*" }`、`devDependencies: { agentpack, @types/node, tsup, typescript }`。发布到 npm 时 `workspace:*` → `"^0.1.0"`。**零其它运行时依赖**。
- `tsup.config.ts` 镜像 agentpack：`format:['esm']`、`target:'es2022'`、`dts:true`、`skipNodeModulesBundle:true`。
- agentpack 全程 `import type`，编译后类型擦除，运行时不打进本包，仅 peer 解析。

## 实现顺序

1. `package.json`/`tsconfig.json`/`tsup.config.ts`（镜像 agentpack）
2. `src/types.ts`
3. `retrieval/`：tokenizer → bm25 → embedder → hybrid-retriever
4. `store/`：in-memory → file-memory
5. `injection/`：sentinels → injection-transformer
6. `capture/`：extractor → capture-extension
7. `consolidation/consolidator.ts`
8. `tools/memory-tools.ts`
9. `plugin.ts` + `index.ts`
10. `examples/round-trip.ts` + `README.md`

## 验证方案

### 构建

```bash
pnpm --filter agentpack build          # 先构建框架（peer 依赖）
pnpm --filter agentpack-memory build   # tsup → dist/index.js + dist/index.d.ts
pnpm --filter agentpack-memory typecheck
```

### 往返验证脚本 `examples/round-trip.ts`（不依赖真实 LLM/Key）

用 `InMemoryStore` + 假 `streamFn`（返回固定 assistant 文本）：

1. `createMemoryPlugin({ store: new InMemoryStore() })` → `install()`。
2. `createRuntime({ streamFn: fakeStreamFn, ...mem.install() })`。
3. `runtime.run(createRequest('我喜欢用 React + TypeScript 做项目', { sessionKey:'s1' }))` → capture 在 done 落盘一条记忆。
4. 断言 `mem.store.list()` 长度 ≥1 且 content 含 'React'。
5. `runtime.run(createRequest('我之前说过用什么技术栈？', { sessionKey:'s2' }))` → injection transformer 检索到记忆，sentinel 块合并进最新 user 消息。
6. 断言 `fakeStreamFn` 收到的 `context.messages` 最新 user 消息（`extractText`）含 `MEMORY_BLOCK_START` 且含 'React'。
7. 再跑一次相同 query，断言历史中**只出现一次** sentinel 块（验证剥离逻辑：上轮注入持久化后下轮被剥除）。
8. 工具往返：直接调 `createMemoryTools(store)` 的 `save_memory.execute(...)` 与 `search_memory.execute(...)`，断言 `ToolResult.content` 文本含 id/命中。
9. 运行：`node --import tsx packages/agentpack-memory/examples/round-trip.ts`。

### 单元要点（typecheck 覆盖）

- BM25：CJK「我喜欢React」与 query「React」命中；纯 CJK query 命中。
- `stripMemoryBlock(wrapMemoryBlock(x)) === x`。
- `cosine` 对称、自相似=1、零向量返回 0。

## 风险与对策

- **sentinel 块随会话持久化**：每轮注入前先剥除历史 sentinel，保证当前轮记忆块只附在当前 user 消息；历史 user 消息被清为原文。可接受，README 注明。
- **并发多会话 capture**：`done` 钩子已扩展携带最终 `Request`，按 `request.sessionKey` 精确配对（框架保证同 sessionKey 串行）。不同 sessionKey 并发互不干扰；极端同 sessionKey 并发 run 仍为 best-effort，README 注明。
- **transformer 每次 runLoop iteration 都跑**：注入逻辑幂等（先剥后注），多次执行结果一致。
- **`buildContext` 过滤 system 角色**：已确认 user 角色注入会到达模型，方案成立；不依赖 StateSnapshot 的 system 注入。
