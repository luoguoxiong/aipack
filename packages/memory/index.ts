/**
 * aipack-memory —— aipack 持久化记忆插件
 *
 * 核心闭环：capture → compress → index → recall/inject → consolidate
 * 参考 https://github.com/rohitg00/agentmemory
 *
 * 默认零依赖、零 API Key：
 *   - 检索：BM25 关键词（CJK + Latin 分词）
 *   - 持久化：FileMemoryStore（每条一 JSON，原子写）
 *   - 捕获：零-LLM 关键词抽取
 *
 * 可选升级：
 *   - embedder → BM25 + 向量混合检索
 *   - summarizeFn → LLM 摘要压缩
 *
 * 快速接入（aipack.config.js）：
 *   import { createMemoryPlugin } from '@aipack/memory';
 *   const mem = createMemoryPlugin({ baseDir: '~/.aipack/memory' });
 *   const r = mem.install();
 *   export default { ..., extensions: r.extensions, transformers: r.transformers, tools: r.tools };
 */

// ─── 插件入口 ───────────────────────────────────────────────────────
export { createMemoryPlugin } from './src/plugin';
export type { MemoryPluginOptions, MemoryPlugin } from './src/plugin';

// ─── 类型定义 ───────────────────────────────────────────────────────
export type {
  MemoryEntry,
  MemorySource,
  MemorySearchResult,
  MatchedBy,
  Embedder,
  SummarizeFn,
  ConsolidateOptions,
  ConsolidatorLike,
  FileMemoryStoreOptions,
  MemorySaveInput,
  MemoryStore,
  MemoryEvent,
  MemoryEventSink,
  MemoryStats,
} from './src/types';

// ─── 存储 ────────────────────────────────────────────────────────────
export { FileMemoryStore, createFileMemoryStore } from './src/store/file-memory-store';
export { InMemoryStore, createInMemoryStore, finalizeEntry } from './src/store/in-memory-store';
export { MemoryIndex } from './src/store/memory-index';

// ─── 检索 ────────────────────────────────────────────────────────────
export { tokenize, isCJK, STOPWORDS, extractConcepts } from './src/retrieval/tokenizer';
export { BM25Index, BM25Retriever } from './src/retrieval/bm25';
export type { BM25Options } from './src/retrieval/bm25';
export { cosine, minMaxNormalize } from './src/retrieval/embedder';
export { VectorIndex } from './src/retrieval/vector-index';
export type { VectorIndexOptions, VectorSearchResult } from './src/retrieval/vector-index';
export { HybridRetriever } from './src/retrieval/hybrid-retriever';
export type {
  HybridRetrieverOptions,
  HybridSearchOptions,
  RetrieverLike,
  VectorSearchLike,
} from './src/retrieval/hybrid-retriever';

// ─── 捕获 ────────────────────────────────────────────────────────────
export { extractFromTurn, runCaptureExtractor } from './src/capture/extractor';
export type { ExtractResult, ExtractorOptions } from './src/capture/extractor';
export { MemoryCaptureExtension } from './src/capture/capture-extension';
export type { CaptureOptions } from './src/capture/capture-extension';

// ─── 注入 ────────────────────────────────────────────────────────────
export {
  MEMORY_BLOCK_START,
  MEMORY_BLOCK_END,
  stripMemoryBlock,
  hasMemoryBlock,
  wrapMemoryBlock,
  buildMemoryBlock,
} from './src/injection/sentinels';
export { MemoryInjectionTransformer } from './src/injection/injection-transformer';
export type { InjectionOptions } from './src/injection/injection-transformer';

// ─── 合并 ────────────────────────────────────────────────────────────
export { Consolidator } from './src/consolidation/consolidator';
export type { ConsolidatorOptions } from './src/consolidation/consolidator';

// ─── 工具 ────────────────────────────────────────────────────────────
export { createMemoryTools } from './src/tools/memory-tools';
export type { MemoryToolsOptions } from './src/tools/memory-tools';

// ─── 从 aipack 再导出常用类型（方便单一 import） ───────────────────
export type { Extension, ContextTransformer, Tool, ToolResult } from '@aipack/agent';
