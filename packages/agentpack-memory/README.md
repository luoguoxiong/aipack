# agentpack-memory

> agentpack 持久化记忆插件：**capture → compress → index → recall/inject → consolidate**
>
> 参考 [rohitg00/agentmemory](https://github.com/rohitg00/agentmemory)，为 [agentpack](../agentpack) 提供「跨会话长期记忆」能力。

## 特性

- **自动捕获**：每轮对话结束自动提取要点存为可检索记忆（零-LLM 关键词抽取，可选 LLM 摘要）
- **自动注入**：每轮对话开始自动检索相关记忆，注入到最新 user 消息（sentinel 机制，防跨轮累积）
- **BM25 检索**：零依赖关键词检索，支持 CJK（中日韩）与 Latin 分词
- **混合检索**：提供 `Embedder` 接口后自动升级为 BM25 + 向量混合检索
- **记忆合并**：定期去重 / 合并相似记忆，修剪过期与低置信度条目
- **Agent 工具**：4 个可调用工具（save / search / list / delete）
- **零配置开箱即用**：默认零依赖、零 API Key

## 安装

```bash
pnpm add agentpack-memory
# 或
npm install agentpack-memory
```

`agentpack` 为 peer 依赖，需同时安装。

## 快速接入

### agentpack.config.js

```js
import { createMemoryPlugin } from 'agentpack-memory';

const mem = createMemoryPlugin({
  baseDir: '~/.agentpack/memory',  // 记忆存储目录
  maxMemories: 5,                    // 每轮注入 top-5
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
import { createMemoryPlugin, InMemoryStore } from 'agentpack-memory';

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
console.log(results[0]?.entry.content);  // '用户偏好深色主题'

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
助手回复 ──▶ [Capture Extension] ──▶ 提取要点 ──▶ 存储为记忆 ──▶ 定期合并
```

### 注入机制（sentinel）

记忆以 sentinel 包裹块的形式合并进最新 user 消息内容：

```
<<<AGENTPACK_MEMORY>>>
[Relevant memories]
- 用户偏好 React + TypeScript (score=0.82, id=mem_xxx)
<<</AGENTPACK_MEMORY>>

<原始用户消息>
```

每轮「先剥后注」：注入前先剥除所有 user 消息中的旧 sentinel 块（含已持久化进 session 的），保证当前轮只有一个记忆块。sentinel 是 content 的一部分，随消息持久化，下轮可识别剥离。

### 检索方案

| 模式 | 触发条件 | 原理 |
|------|---------|------|
| 纯 BM25 | 未配置 `embedder`（默认） | 关键词倒排索引，min-max 归一化 |
| 混合检索 | 配置了 `embedder` | BM25 候选 + 向量 cosine 加权融合 |

BM25 tokenizer 支持：
- **Latin**：小写化 + 按非字母数字分割 + 停用词过滤
- **CJK**：`\u4e00-\u9fff` 逐字符分词

## 配置选项

### `createMemoryPlugin(options)`

| 选项 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `baseDir` | `string` | `<cwd>/.agentpack/memory` | FileMemoryStore 存储目录（支持 `~`） |
| `store` | `MemoryStore` | `FileMemoryStore` | 自定义存储（覆盖默认） |
| `maxMemories` | `number` | `5` | 每轮注入 top-K |
| `minScore` | `number` | `0.1` | 最低相关度阈值 |
| `capture` | `boolean \| CaptureOptions` | `true` | 捕获开关 / 选项 |
| `inject` | `boolean \| InjectionOptions` | `true` | 注入开关 / 选项 |
| `tools` | `boolean` | `true` | 记忆工具开关 |
| `embedder` | `Embedder` | — | 向量化器（启用混合检索） |
| `summarizeFn` | `SummarizeFn` | — | LLM 摘要函数（启用摘要压缩） |
| `consolidateOn` | `number` | `0` | 每 N 次捕获自动合并（0=不自动） |

### CaptureOptions

| 选项 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `summarizeFn` | `SummarizeFn` | — | LLM 摘要函数 |
| `minLength` | `number` | `12` | 最小用户消息长度 |
| `maxConcepts` | `number` | `8` | 概念数上限 |
| `maxContentChars` | `number` | `2000` | content 最大字符数 |
| `consolidateEvery` | `number` | `0` | 每 N 次捕获触发合并 |

## Agent 工具

插件自动注册 4 个 Agent 可调用工具：

| 工具 | 参数 | 说明 |
|------|------|------|
| `save_memory` | `content`, `concepts?` | 保存一条长期记忆 |
| `search_memory` | `query`, `limit?` | 检索相关记忆 |
| `list_memories` | `limit?` | 列出最近记忆 |
| `delete_memory` | `id` | 删除一条记忆 |

## 自定义 Embedder

```typescript
import { createMemoryPlugin, type Embedder } from 'agentpack-memory';

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
  baseDir: '~/.agentpack/memory',
});
```

## 自定义 LLM 摘要

```typescript
import { createMemoryPlugin, type SummarizeFn } from 'agentpack-memory';

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
  save(entry: MemorySaveInput): Promise<MemoryEntry>;
  get(id: string): Promise<MemoryEntry | null>;
  delete(id: string): Promise<boolean>;
  list(limit?: number): Promise<MemoryEntry[]>;
  search(query: string, limit?: number): Promise<MemorySearchResult[]>;
  touchRecall(id: string, at?: number): Promise<void>;
  consolidate(options?: ConsolidateOptions): Promise<{ merged: number; pruned: number }>;
  prune(options?: { maxAgeMs?: number; minConfidence?: number }): Promise<number>;
  count(): Promise<number>;
  setConsolidator(consolidator: ConsolidatorLike): void;
}
```

### MemoryEntry

```typescript
interface MemoryEntry {
  id: string;
  content: string;
  concepts: string[];
  confidence: number;       // 0..1
  source: 'capture' | 'tool' | 'consolidation';
  sessionKey?: string;
  createdAt: number;
  updatedAt: number;
  lastRecalledAt?: number;
  recallCount: number;
  embedding?: number[];
  meta?: Record<string, unknown>;
}
```

## 限制与注意事项

1. **sentinel 块随会话持久化**：每轮注入前会先剥除历史 sentinel 块，保证当前轮只有一个记忆块。历史 user 消息会被清为原文。
2. **并发多会话**：`done` 钩子不携带 sessionKey，capture 用 FIFO 队列配对。顺序 awaited run 下精确；并发多会话为 best-effort，建议用 `save_memory` 工具或顺序运行。
3. **自定义 store 的混合检索**：自定义 store 需自行保证 `search()` 返回含 `embedding` 字段的 `MemoryEntry`（若使用 embedder），否则退化为纯 BM25。

## 验证

```bash
# 构建
pnpm --filter agentpack build          # 先构建框架（peer 依赖）
pnpm --filter agentpack-memory build   # 构建插件

# 类型检查
pnpm --filter agentpack-memory typecheck

# 运行验证脚本（不依赖真实 LLM / API Key）
pnpm --filter agentpack-memory example
```

## License

MIT
