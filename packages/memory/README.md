# aipack-memory

> aipack 持久化记忆插件：**capture → compress → index → recall/inject → consolidate**
>
> 参考 [rohitg00/agentmemory](https://github.com/rohitg00/agentmemory)，为 [aipack](../aipack) 提供「跨会话长期记忆」能力。

## 特性

- **自动捕获**：每轮对话结束自动提取要点存为可检索记忆（零-LLM 要点压缩，可选 LLM 摘要）
- **自动注入**：每轮对话开始自动检索相关记忆，注入到最新 user 消息（sentinel 机制，防跨轮累积）
- **BM25 检索**：零依赖关键词检索，支持 CJK（中日韩，bigram）与 Latin 分词
- **混合检索**：提供 `Embedder` 接口后自动升级为 BM25 + 向量**双路独立召回**融合（向量召回不被 BM25 top-K 封顶）
- **记忆合并**：增量去重 / 合并相似记忆（O(N²) → 增量窗口），修剪过期与低置信度条目
- **并发安全**：同 id 写操作经 keyed mutex 串行化，capture 按 sessionKey 配对
- **可观测性**：`MemoryEvent` 事件上报（失败/整理/加载）与 `stats()` 统计快照
- **Agent 工具**：4 个可调用工具（save / search / list / delete），带输入校验与可选 TTL
- **零配置开箱即用**：默认零依赖、零 API Key

## 安装

```bash
pnpm add aipack-memory
# 或
npm install aipack-memory
```

`aipack` 为 peer 依赖，需同时安装。

## 快速接入

### aipack.config.js

```js
import { createMemoryPlugin } from 'aipack-memory';

const mem = createMemoryPlugin({
  baseDir: '~/.aipack/memory', // 记忆存储目录
  maxMemories: 5, // 每轮注入 top-5
});

const r = mem.install();

export default {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  systemPrompt: '你是一个有用的助手',
  sessions: { enabled: true, baseDir: './sessions', maxAge: 30 },
  extensions: r.extensions,
  transformers: r.transformers,
  tools: r.tools,
};
```

### 编程式 API

```typescript
import { createMemoryPlugin, InMemoryStore } from 'aipack-memory';

const store = new InMemoryStore();
const mem = createMemoryPlugin({ store });

// 直接操作 store
await mem.store.save({
  content: '用户偏好深色主题',
  concepts: ['ui', 'dark-mode'],
  confidence: 0.8,
  source: 'tool',
});

const results = await mem.store.search('主题偏好', 5);
console.log(results[0]?.entry.content); // '用户偏好深色主题'

// 手动触发合并
await mem.store.consolidate({ similarityThreshold: 0.85 });
```

## 工作原理

### 核心闭环

```
用户消息 ──▶ [Injection Transformer]  ──▶ 检索相关记忆 ──▶ 注入到 user 消息
                                                    │
                                                    ▼
                                             [Runtime 运行]
                                                    │
助手回复 ──▶ [Capture Extension] ──▶ 要点压缩 ──▶ 存储为记忆 ──▶ 定期合并
```

### 注入机制（sentinel）

记忆以 sentinel 包裹块的形式合并进最新 user 消息内容：

```
<<<AIPACK_MEMORY>>>
[Relevant memories]
- 用户偏好 React + TypeScript (score=0.82, id=mem_xxx)
<<</AIPACK_MEMORY>>

<原始用户消息>
```

每轮「先剥后注」：注入前先剥除所有 user 消息中的旧 sentinel 块（含已持久化进 session 的），保证当前轮只有一个记忆块。sentinel 是 content 的一部分，随消息持久化，下轮可识别剥离。

### 检索方案

| 模式         | 触发条件                  | 原理                                                                                                       |
| ------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 纯 BM25      | 未配置 `embedder`（默认） | 关键词倒排索引，min-max 归一化                                                                             |
| 双路独立召回 | 配置了 `embedder`         | BM25 路 + 向量路各自独立召回 top-N，按 id 并集加权融合。向量路走独立 VectorIndex，**不受 BM25 候选池封顶** |

合并（consolidate）阶段使用 `raw` 原始分数模式（不做 min-max 归一化），保证 `similarityThreshold` 按绝对相似度判定。

BM25 tokenizer 支持：

- **Latin**：小写化 + 按非字母数字分割
- **CJK**：相邻两字 bigram（区分度远高于单字，如「数据科学」vs「数据库」），奇数长度串尾部补单字保证单字查询可命中；覆盖汉字（含扩展/兼容区）、日文假名、韩文谚文

## 配置选项

### `createMemoryPlugin(options)`

| 选项               | 类型                          | 默认                      | 说明                                   |
| ------------------ | ----------------------------- | ------------------------- | -------------------------------------- |
| `baseDir`          | `string`                      | `<cwd>/.aipack/memory` | FileMemoryStore 存储目录（支持 `~`）   |
| `store`            | `MemoryStore`                 | `FileMemoryStore`         | 自定义存储（覆盖默认）                 |
| `maxMemories`      | `number`                      | `5`                       | 每轮注入 top-K                         |
| `minScore`         | `number`                      | `0.1`                     | 最低相关度阈值                         |
| `capture`          | `boolean \| CaptureOptions`   | `true`                    | 捕获开关 / 选项                        |
| `inject`           | `boolean \| InjectionOptions` | `true`                    | 注入开关 / 选项                        |
| `tools`            | `boolean`                     | `true`                    | 记忆工具开关                           |
| `embedder`         | `Embedder`                    | —                         | 向量化器（启用双路独立召回）           |
| `summarizeFn`      | `SummarizeFn`                 | —                         | LLM 摘要函数（启用摘要压缩）           |
| `consolidateEvery` | `number`                      | `0`                       | 每 N 次捕获自动合并（0=不自动）        |
| `captureTtlMs`     | `number`                      | —                         | 捕获记忆 TTL（ms），过期后 prune 清理  |
| `toolTtlMs`        | `number`                      | —                         | `save_memory` 工具保存的记忆 TTL（ms） |
| `onEvent`          | `MemoryEventSink`             | 默认打 warn               | 事件接收器（失败/整理/加载等）         |

### CaptureOptions

| 选项               | 类型              | 默认   | 说明                |
| ------------------ | ----------------- | ------ | ------------------- |
| `summarizeFn`      | `SummarizeFn`     | —      | LLM 摘要函数        |
| `minLength`        | `number`          | `12`   | 最小用户消息长度    |
| `maxConcepts`      | `number`          | `8`    | 概念数上限          |
| `maxContentChars`  | `number`          | `2000` | content 最大字符数  |
| `consolidateEvery` | `number`          | `0`    | 每 N 次捕获触发合并 |
| `ttlMs`            | `number`          | —      | 捕获记忆 TTL（ms）  |
| `onEvent`          | `MemoryEventSink` | —      | 捕获失败事件接收器  |

## Agent 工具

插件自动注册 4 个 Agent 可调用工具（带输入校验与 limit 裁剪）：

| 工具            | 参数                   | 说明                                                    |
| --------------- | ---------------------- | ------------------------------------------------------- |
| `save_memory`   | `content`, `concepts?` | 保存一条长期记忆（content ≤ 2000 字，concepts ≤ 20 项） |
| `search_memory` | `query`, `limit?`      | 检索相关记忆（limit ≤ 50）                              |
| `list_memories` | `limit?`               | 列出最近记忆（limit ≤ 200）                             |
| `delete_memory` | `id`                   | 删除一条记忆                                            |

## 自定义 Embedder

```typescript
import { createMemoryPlugin, type Embedder } from 'aipack-memory';

// 示例：接入 ollama embedding
const ollamaEmbedder: Embedder = {
  async embed(text: string): Promise<number[]> {
    const res = await fetch('http://localhost:11434/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
    });
    const data = await res.json();
    return data.embedding;
  },
  dimension: 768,
};

const mem = createMemoryPlugin({
  embedder: ollamaEmbedder,
  baseDir: '~/.aipack/memory',
});
```

## 自定义 LLM 摘要

```typescript
import { createMemoryPlugin, type SummarizeFn } from 'aipack-memory';

const summarize: SummarizeFn = async ({ userMessage, assistantContent }) => {
  // 调用你的 LLM 压缩对话
  const summary = await callLLM(
    `将以下对话压缩为一句精炼记忆：\n用户: ${userMessage}\n助手: ${assistantContent}`,
  );
  return { summary, concepts: [] };
};

const mem = createMemoryPlugin({
  summarizeFn: summarize,
});
```

## API

### MemoryStore 接口

```typescript
interface MemoryStore {
  save(entry: MemorySaveInput): Promise<MemoryEntry>; // ttlMs 换算为 expiresAt
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
  stats(): Promise<MemoryStats>; // 统计快照（count/bySource/avgConfidence/recall...）
  dispose(): void; // 释放资源
}
```

### MemoryEntry

```typescript
interface MemoryEntry {
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
```

## 限制与注意事项

1. **sentinel 块随会话持久化**：每轮注入前会先剥除历史 sentinel 块，保证当前轮只有一个记忆块。历史 user 消息会被清为原文。
2. **并发多会话**：capture 通过 `ExtensionContext.sessionKey`（Runtime 级）与 `beforeRun` 暂存消息配对（框架 per-Runtime 串行）。多会话场景请创建多个 Runtime 实例，各自独立的 sessionKey 互不干扰。
3. **内存常驻**：索引（BM25 + 向量）全量常驻内存（零依赖约束下无外部磁盘索引）。百万级记忆需自行评估内存，或按 TTL 控制条数。
4. **自定义 store 的混合检索**：自定义 store 需实现 `searchVectors()` 才能启用向量独立召回；未实现时退化为「BM25 候选 + 向量重排」兼容路径。纯 BM25 检索为词法匹配，跨语言同义召回需配置 `embedder`。
5. **consolidate 为 best-effort**：增量候选基于 `lastConsolidatedAt`；合并期间新写入的条目留到下一轮处理，跨 id 交错不保证全局原子。

## 验证

```bash
# 构建
pnpm --filter aipack build          # 先构建框架（peer 依赖）
pnpm --filter aipack-memory build   # 构建插件

# 类型检查
pnpm --filter aipack-memory typecheck

# 单元测试（node:test，覆盖 tokenizer/BM25/向量索引/双路检索/合并器/存储/并发）
pnpm --filter aipack-memory test

# 运行往返验证脚本（不依赖真实 LLM / API Key）
pnpm --filter aipack-memory example
```

## License

MIT
