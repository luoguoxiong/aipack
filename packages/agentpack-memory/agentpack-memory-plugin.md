# agentpack-memory：上下文管理插件实现方案

## Context（背景与目标）

`agentpack` 框架目前只有「会话级线性消息持久化」（`FileSessionStorage`），跨会话、跨主题的长期记忆缺失——每次新会话都要重新解释架构、重新发现同样的约束。参考 `rohitg00/agentmemory` 的核心闭环（**capture → compress → index → recall/inject → consolidate**，默认零依赖 BM25 + 可选本地 embedding，可选 LLM 摘要），为 agentpack 新增一个独立 npm 包 `agentpack-memory`，作为 Extension + Transformer + Tool 组合插件，实现：每轮对话自动捕获要点存为可检索记忆、每轮自动检索相关记忆注入上下文、提供 Agent 可调用的记忆工具、定期合并去重与生命周期修剪。默认零依赖、零 API Key，开箱即用；embedding 与 LLM 摘要均为可选可插拔。

## 已核验的框架约束（决定设计的关键事实，均带行号）

1. **`buildContext` 过滤 `role==='system'` 消息** —— `packages/agentpack/runtime/index.ts:585` `messages.filter(m => m.role !== 'system')`。故注入必须用 `role:'user'`，`role:'system'` 资源不会到达模型。
2. **`transformMessages` 原地 splice** —— `runtime/index.ts:565-578`，且 `compilation.messages` 与 `session.messages` 共享引用（`createCompilation:308-319`）。Transformer 输出会持久化进会话存储（`finally → persistSession:254`）。注入内容若不每轮清理会跨轮累积。
3. **`meta` 在 message↔resource 往返中丢失** —— `context-resource/index.ts:30-38`（user 消息 → resource 不带 meta）、`112-119`（resource → user 消息只取 role/content/timestamp）。故跨轮标记旧注入不能用 `meta.injectedBy`，必须用**内容内 sentinel**（随 content 持久化，下轮可识别）。
4. **`done` 钩子只收 `Result`，无 sessionKey/原始 user message** —— `extension.ts:31`、`result.ts`。capture 须在 `beforeRun`（收 `Request`，含 `.message`/`.sessionKey`，`request.ts`）stash，在 `done` 消费。
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

### 决策 B：capture 的 beforeRun+done stash 机制

`MemoryCaptureExtension` 内部 `pending: Map<sessionKey, {message, timestamp}>` + `queue: string[]`（FIFO）。
- `beforeRun.tapPromise`：stash `{message, timestamp}` 入 pending、sessionKey 入 queue，返回原 request（不改请求）。
- `done.tapPromise`：`queue.shift()` 取 sessionKey → 读 stash → 组装 `MemoryEntry`（content = 摘要或 `Q: <message>\nA: <answer>`，concepts、confidence 捕获默认 0.6/摘要 0.8）→ `store.save` → 每 `consolidateEvery` 次触发 `store.consolidate()`。失败 try/catch 吞错并 `console.warn`，不影响运行。
- **配对正确性**：典型用法顺序 awaited run，`beforeRun→...→done` 同一 async frame 顺序执行，FIFO 精确。并发多会话时 FIFO 是 best-effort（`done` 无 sessionKey 是框架限制），README 注明：并发场景建议用 `save_memory` 工具或顺序运行。

### 决策 C：零依赖 BM25 + 可插拔 Embedder

默认 `BM25Retriever`（零依赖），tokenizer 支持 latin（小写化 + 按非字母数字分割）与 CJK（`\u4e00-\u9fff` 逐字符）。提供 `Embedder` 接口则走 `HybridRetriever`（BM25 分数 min-max 归一化 + cosine 归一化，按 `bm25Weight`/`embedWeight` 加权融合，过滤 `< minScore`）；无 embedder 退化为纯 BM25。不引入 `@huggingface/transformers`，用户可自行实现 `Embedder` 接入 ollama/transformers。

## 文件树

```
packages/agentpack-memory/
├── package.json              # name: agentpack-memory, 仅 peer+dev 依赖 agentpack, ESM, tsup
├── tsconfig.json             # extends ../../tsconfig.json, include index.ts/src/examples
├── tsup.config.ts            # 镜像 agentpack: format esm, target es2022, dts, skipNodeModulesBundle
├── README.md                 # overview/install/programmatic API/config.js wiring/options/工具/限制
├── index.ts                  # 公共出口（聚合 export）
├── src/
│   ├── types.ts              # MemoryEntry / MemoryStore / MemorySearchResult / Embedder / SummarizeFn / 选项
│   ├── store/
│   │   ├── file-memory-store.ts   # FileMemoryStore（每条一 JSON, 原子写, 内存缓存 + BM25 增量索引）
│   │   ├── in-memory-store.ts    # InMemoryStore（测试用）
│   │   └── index.ts
│   ├── retrieval/
│   │   ├── tokenizer.ts           # tokenize(text): latin + CJK 分词, STOPWORDS
│   │   ├── bm25.ts                # BM25Index {add,remove,search} + BM25Retriever
│   │   ├── embedder.ts            # Embedder 接口 + cosine(a,b)
│   │   ├── hybrid-retriever.ts    # HybridRetriever（BM25 + 可选 embedding 加权融合）
│   │   └── index.ts
│   ├── capture/
│   │   ├── extractor.ts           # extractKeywords + runCaptureExtractor（零-LLM + 可选 summarizeFn 兜底）
│   │   ├── capture-extension.ts   # MemoryCaptureExtension extends BaseExtension
│   │   └── index.ts
│   ├── injection/
│   │   ├── sentinels.ts           # MEMORY_BLOCK_START/END 常量 + stripMemoryBlock/wrapMemoryBlock/buildMemoryBlock
│   │   ├── injection-transformer.ts # MemoryInjectionTransformer extends BaseTransformer (priority 5)
│   │   └── index.ts
│   ├── consolidation/
│   │   ├── consolidator.ts        # Consolidator: 去重/合并/修剪
│   │   └── index.ts
│   ├── tools/
│   │   ├── memory-tools.ts        # createMemoryTools(store) -> Tool[] (纯 JSON Schema 参数)
│   │   └── index.ts
│   └── plugin.ts                  # createMemoryPlugin(options) -> {store, retriever, extensions, transformers, tools, install()}
└── examples/
    └── round-trip.ts          # 验证脚本（不依赖真实 LLM，假 streamFn + InMemoryStore）
```

## 关键 API 签名

### `src/types.ts`
```ts
export interface MemoryEntry {
  id: string; content: string; concepts: string[]; confidence: number; // 0..1
  source: 'capture' | 'tool' | 'consolidation'; sessionKey?: string;
  createdAt: number; updatedAt: number; lastRecalledAt?: number; recallCount: number;
  embedding?: number[]; meta?: Record<string, unknown>;
}
export interface MemorySearchResult { entry: MemoryEntry; score: number; matchedBy: 'bm25'|'embedding'|'hybrid'; }
export interface MemoryStore {
  save(entry: Omit<MemoryEntry,'id'|'createdAt'|'updatedAt'|'recallCount'> & Partial<Pick<MemoryEntry,'id'>>): Promise<MemoryEntry>;
  get(id: string): Promise<MemoryEntry | null>;
  delete(id: string): Promise<boolean>;
  list(limit?: number): Promise<MemoryEntry[]>;
  search(query: string, limit?: number): Promise<MemorySearchResult[]>;
  touchRecall(id: string, at?: number): Promise<void>;
  consolidate(options?: ConsolidateOptions): Promise<{ merged: number; pruned: number }>;
  prune(options?: { maxAgeMs?: number; minConfidence?: number }): Promise<number>;
  count(): Promise<number>;
}
export interface Embedder { embed(text: string): Promise<number[]>; dimension?: number; }
export type SummarizeFn = (input: { userMessage: string; assistantContent: string; toolsUsed: string[] }) =>
  Promise<{ summary: string; concepts?: string[] } | null>;
export interface ConsolidateOptions { similarityThreshold?: number; maxMemories?: number; maxAgeMs?: number; minConfidence?: number; }
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
  add(id: string, tokens: string[]): void; remove(id: string): void;
  search(queryTokens: string[], limit?: number): Array<{ id: string; score: number }>; size(): number;
}
export class BM25Retriever { constructor(index: BM25Index, entries: Map<string, MemoryEntry>); search(query, limit?): Promise<MemorySearchResult[]>; }
```
经典 BM25（`idf = ln((N - df + 0.5)/(df + 0.5) + 1)`），分数不归一化（由 HybridRetriever 归一化）。

### `src/retrieval/hybrid-retriever.ts`
```ts
export class HybridRetriever {
  constructor(opts: { bm25: BM25Retriever; embedder?: Embedder; bm25Weight?: number; embedWeight?: number; minScore?: number });
  search(query: string, limit?: number): Promise<MemorySearchResult[]>;
}
```
BM25 取 `limit*3` 候选 → min-max 归一化 → 若有 embedder 算 query+候选 cosine 归一化 → 加权融合 → 过滤 `< minScore` → 截 limit。

### `src/injection/sentinels.ts`
```ts
export const MEMORY_BLOCK_START = '<<<AGENTPACK_MEMORY>>>';
export const MEMORY_BLOCK_END = '<<</AGENTPACK_MEMORY>>>';
export function stripMemoryBlock(text: string): string;     // 正则剥离 + trim
export function wrapMemoryBlock(lines: string[]): string;   // 包裹
export function buildMemoryBlock(results: MemorySearchResult[]): string;
```

### `src/injection/injection-transformer.ts` —— `MemoryInjectionTransformer extends BaseTransformer`
```ts
export interface InjectionOptions { enabled?: boolean; priority?: number; maxMemories?: number; minScore?: number; queryTransform?: (text: string) => string; }
export class MemoryInjectionTransformer extends BaseTransformer {
  readonly name = 'memory-injection'; // priority 5
  constructor(retriever: HybridRetriever, options?: InjectionOptions);
  protected async run(resources: ContextResource[], context: TransformContext): Promise<ContextResource[]>;
}
```
`run` 严格按决策 A：用 `extractTextFromResource`（`context-resource/index.ts:177`）+ `ContextResourceBuilder` 重建剥除后的资源（不可变语义，返回新数组）；注入时 string/`ContentBlock[]` 两分支，后者用 `createTextContent`（`core/types.ts:186`）。

### `src/capture/capture-extension.ts` —— `MemoryCaptureExtension extends BaseExtension`
```ts
export interface CaptureOptions { enabled?: boolean; summarizeFn?: SummarizeFn; minLength?: number; maxConcepts?: number; maxContentChars?: number; consolidateEvery?: number; }
export class MemoryCaptureExtension extends BaseExtension {
  readonly name = 'memory-capture';
  constructor(store: MemoryStore, retriever: HybridRetriever, options?: CaptureOptions);
  protected setup(hooks: RuntimeHooks, context: ExtensionContext): void; // beforeRun stash + done 落盘（决策 B）
}
```

### `src/consolidation/consolidator.ts`
```ts
export class Consolidator { constructor(store: MemoryStore, retriever: HybridRetriever, options?: { similarityThreshold?: number });
  async run(options?: ConsolidateOptions): Promise<{ merged: number; pruned: number }>; }
```
`list` → BM25/cosine 找相似对（`score >= threshold`，默认 0.85）→ 合并（content 取较长/较新、concepts 并集、`confidence=min(1,a+b+0.1)`、recallCount 相加、`source='consolidation'`）→ 删被合并项 → `prune(maxAgeMs, minConfidence)`。

### `src/tools/memory-tools.ts`
```ts
export function createMemoryTools(store: MemoryStore, options?: { listLimit?: number }): Tool[];
```
4 个 Tool（`Tool`/`createTextContent` 来自 `agentpack`，`parameters` 用**纯 JSON Schema 对象**，不依赖 `agentpack/ai` 的 TypeBox）：`save_memory(content, concepts?)` / `search_memory(query, limit?)` / `list_memories(limit?)` / `delete_memory(id)`。`execute` 返回 `ToolResult`。

### `src/plugin.ts` —— `createMemoryPlugin`
```ts
export interface MemoryPluginOptions {
  baseDir?: string; store?: MemoryStore; maxMemories?: number; minScore?: number;
  capture?: boolean | CaptureOptions; inject?: boolean | InjectionOptions; tools?: boolean;
  embedder?: Embedder; summarizeFn?: SummarizeFn; consolidateOn?: number;
}
export interface MemoryPlugin { store: MemoryStore; retriever: HybridRetriever; extensions: Extension[]; transformers: ContextTransformer[]; tools: Tool[]; install(): { extensions: Extension[]; transformers: ContextTransformer[]; tools: Tool[] }; }
export function createMemoryPlugin(options?: MemoryPluginOptions): MemoryPlugin;
```
默认 store=`FileMemoryStore`、retriever=`HybridRetriever`（无 embedder 纯 BM25）、capture=true、inject=true、tools=true。`install()` 返回三数组，供 `agentpack.config.js` 展开到 `extensions`/`transformers`/`tools`。

### `index.ts`
聚合 export 全部类型与实现；从 `agentpack` 再导出 `Extension`/`ContextTransformer`/`Tool`/`ToolResult` 类型方便单一 import。

## `agentpack.config.js` 接入示例（写入 README）
```js
import { createMemoryPlugin } from 'agentpack-memory';
const mem = createMemoryPlugin({ baseDir: '~/.agentpack/memory', maxMemories: 5 });
export default {
  provider: 'deepseek', model: 'deepseek-v4-flash', systemPrompt: 'kum',
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
- **`done` 无 sessionKey**：FIFO queue 配对，顺序运行精确；并发限制 README 注明。
- **transformer 每次 runLoop iteration 都跑**：注入逻辑幂等（先剥后注），多次执行结果一致。
- **`buildContext` 过滤 system 角色**：已确认 user 角色注入会到达模型，方案成立；不依赖 StateSnapshot 的 system 注入。
