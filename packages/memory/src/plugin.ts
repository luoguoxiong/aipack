/**
 * 插件聚合入口：createMemoryPlugin(options) → { store, retriever, extensions, transformers, tools, install() }
 *
 * 把 MemoryStore + HybridRetriever + MemoryCaptureExtension + MemoryInjectionTransformer
 * + Consolidator + memory tools 装配成一个开箱即用的插件。
 *
 * 用法（aipack.config.js）：
 *   import { createMemoryPlugin } from '@aipack-ai/memory';
 *   const mem = createMemoryPlugin({ baseDir: '~/.aipack/memory' });
 *   const r = mem.install();
 *   export default {
 *     ...,                          // provider, model, systemPrompt, sessions...
 *     extensions: r.extensions,
 *     transformers: r.transformers,
 *     tools: r.tools,
 *   };
 *
 * 默认配置：FileMemoryStore（持久化）+ 纯 BM25 检索（零依赖）+ 自动捕获 + 自动注入 + 4 个记忆工具。
 * 提供 embedder 后自动升级为 BM25 + 向量混合检索（双路独立召回）；提供 summarizeFn 后 capture 走 LLM 摘要。
 */

import type { Extension, ContextTransformer, Tool } from '@aipack-ai/agent';
import { FileMemoryStore } from './store/file-memory-store';
import { HybridRetriever } from './retrieval/hybrid-retriever';
import type { RetrieverLike, VectorSearchLike } from './retrieval/hybrid-retriever';
import { MemoryCaptureExtension } from './capture/capture-extension';
import type { CaptureOptions } from './capture/capture-extension';
import { MemoryInjectionTransformer } from './injection/injection-transformer';
import type { InjectionOptions } from './injection/injection-transformer';
import { Consolidator } from './consolidation/consolidator';
import { createMemoryTools } from './tools/memory-tools';
import type {
  Embedder,
  MemoryEvent,
  MemoryEventSink,
  MemorySearchResult,
  MemoryStore,
  SummarizeFn,
} from './types';

// ─── StoreBackedRetriever：把任意 MemoryStore 包装成 RetrieverLike ──────────

/**
 * 适配器：将 MemoryStore.search() 包装为 RetrieverLike，供 HybridRetriever 使用。
 *
 * 默认 store（FileMemoryStore / InMemoryStore）的 search() 已内置 BM25，
 * 此适配器直接委托，保证检索与存储数据实时同步。
 * 对于自带检索能力的自定义 store 同样适用。
 */
class StoreBackedRetriever implements RetrieverLike {
  constructor(private store: MemoryStore) {}

  async search(query: string, limit = 5): Promise<MemorySearchResult[]> {
    return this.store.search(query, limit);
  }
}

// ─── StoreVectorSource：把 MemoryStore.searchVectors() 包装成向量检索源 ─────

/**
 * 适配器：将 store.searchVectors() 暴露为 VectorSearchLike，供 HybridRetriever
 * 做「独立于 BM25 的向量召回」。
 */
class StoreVectorSource implements VectorSearchLike {
  constructor(private store: MemoryStore) {}

  async searchVectors(queryVec: number[], limit = 5): Promise<MemorySearchResult[]> {
    return this.store.searchVectors(queryVec, limit);
  }
}

// ─── 默认事件接收器：失败类事件打印告警 ───────────────────────────────

const FAILURE_EVENTS: ReadonlySet<MemoryEvent['type']> = new Set([
  'store:corrupt',
  'embedding:error',
  'capture:failed',
  'consolidate:failed',
]);

function defaultEventSink(event: MemoryEvent): void {
  if (FAILURE_EVENTS.has(event.type)) {
    console.warn(`[aipack-memory] ${event.type}: ${(event as { error?: string }).error ?? ''}`);
  }
}

// ─── 插件选项与返回类型 ──────────────────────────────────────────────

export interface MemoryPluginOptions {
  /** FileMemoryStore 存储目录（支持 ~ 开头），默认 <cwd>/.aipack/memory */
  baseDir?: string;
  /** 自定义 store（覆盖默认 FileMemoryStore；需自行保证 search 能力） */
  store?: MemoryStore;
  /** 注入 top-K 上限，默认 5 */
  maxMemories?: number;
  /** 最低相关度阈值，默认 0.1 */
  minScore?: number;
  /** 捕获开关 / 选项，默认 true */
  capture?: boolean | CaptureOptions;
  /** 注入开关 / 选项，默认 true */
  inject?: boolean | InjectionOptions;
  /** 记忆工具开关，默认 true */
  tools?: boolean;
  /** 可选向量化器，配置后启用 BM25 + 向量混合检索 */
  embedder?: Embedder;
  /** 可选 LLM 摘要函数，配置后 capture 走 LLM 摘要（默认零-LLM 要点抽取） */
  summarizeFn?: SummarizeFn;
  /** 每 N 次捕获自动触发一次 consolidate（0=不自动，默认 0） */
  consolidateEvery?: number;
  /** 捕获记忆 TTL（ms），过期后 prune 清理 */
  captureTtlMs?: number;
  /** save_memory 工具保存的记忆 TTL（ms），过期后 prune 清理 */
  toolTtlMs?: number;
  /** 事件接收器（失败/整理/统计等关键节点；默认打印失败告警） */
  onEvent?: MemoryEventSink;
}

export interface MemoryPlugin {
  /** 装配好的 store（可直接编程式调用 save/search/consolidate 等） */
  store: MemoryStore;
  /** 装配好的混合检索器 */
  retriever: HybridRetriever;
  /** 扩展列表（capture） */
  extensions: Extension[];
  /** 转换器列表（injection） */
  transformers: ContextTransformer[];
  /** 工具列表（save/search/list/delete） */
  tools: Tool[];
  /** 返回 { extensions, transformers, tools }，供 aipack.config.js 展开 */
  install(): {
    extensions: Extension[];
    transformers: ContextTransformer[];
    tools: Tool[];
  };
  /** 释放资源（热重载场景） */
  dispose(): void;
}

// ─── 辅助：解析 boolean | object 选项 ─────────────────────────────────

function isCaptureEnabled(v: boolean | CaptureOptions | undefined): boolean {
  if (v === false) return false;
  return true; // true / undefined / object → 启用
}

function isInjectEnabled(v: boolean | InjectionOptions | undefined): boolean {
  if (v === false) return false;
  return true;
}

function resolveCaptureOptions(
  v: boolean | CaptureOptions | undefined,
  fallback: {
    summarizeFn?: SummarizeFn;
    consolidateEvery?: number;
    ttlMs?: number;
    onEvent?: MemoryEventSink;
  },
): CaptureOptions {
  if (typeof v === 'object' && v !== null) {
    return {
      ...v,
      summarizeFn: v.summarizeFn ?? fallback.summarizeFn,
      consolidateEvery: v.consolidateEvery ?? fallback.consolidateEvery,
      ttlMs: v.ttlMs ?? fallback.ttlMs,
      onEvent: v.onEvent ?? fallback.onEvent,
    };
  }
  return {
    summarizeFn: fallback.summarizeFn,
    consolidateEvery: fallback.consolidateEvery,
    ttlMs: fallback.ttlMs,
    onEvent: fallback.onEvent,
  };
}

function resolveInjectOptions(
  v: boolean | InjectionOptions | undefined,
  fallback: { maxMemories?: number; minScore?: number },
): InjectionOptions {
  if (typeof v === 'object' && v !== null) {
    return {
      ...v,
      maxMemories: v.maxMemories ?? fallback.maxMemories,
      minScore: v.minScore ?? fallback.minScore,
    };
  }
  return {
    maxMemories: fallback.maxMemories,
    minScore: fallback.minScore,
  };
}

// ─── createMemoryPlugin ──────────────────────────────────────────────

export function createMemoryPlugin(options: MemoryPluginOptions = {}): MemoryPlugin {
  const embedder = options.embedder;
  const onEvent = options.onEvent ?? defaultEventSink;

  // 1. Store：自定义优先，否则 FileMemoryStore（带 embedder）
  const store: MemoryStore =
    options.store ??
    new FileMemoryStore({
      baseDir: options.baseDir,
      embedder,
      onEvent,
    });

  // 2. Retriever：BM25 + 可选向量双路独立召回
  const bm25Source: RetrieverLike = new StoreBackedRetriever(store);
  const retriever = new HybridRetriever({
    bm25: bm25Source,
    vector: embedder ? new StoreVectorSource(store) : undefined,
    embedder,
    minScore: options.minScore ?? 0.1,
  });

  // 3. Consolidator：注入 store，使 store.consolidate() 可用（增量合并）
  const consolidator = new Consolidator(store, retriever, {
    similarityThreshold: 0.85,
    onEvent,
  });
  store.setConsolidator(consolidator);

  // 4. Extensions：capture
  const extensions: Extension[] = [];
  if (isCaptureEnabled(options.capture)) {
    const captureOpts = resolveCaptureOptions(options.capture, {
      summarizeFn: options.summarizeFn,
      consolidateEvery: options.consolidateEvery,
      ttlMs: options.captureTtlMs,
      onEvent,
    });
    extensions.push(new MemoryCaptureExtension(store, captureOpts));
  }

  // 5. Transformers：injection
  const transformers: ContextTransformer[] = [];
  if (isInjectEnabled(options.inject)) {
    const injectOpts = resolveInjectOptions(options.inject, {
      maxMemories: options.maxMemories,
      minScore: options.minScore,
    });
    transformers.push(
      new MemoryInjectionTransformer(retriever, {
        ...injectOpts,
        // 命中后更新检索统计（fire-and-forget，不阻塞注入）；
        // 失败不静默：告警日志便于排障（检索统计丢失不致命）
        onRecall: async (ids: string[]) => {
          await Promise.allSettled(ids.map(async (id) => {
            try {
              await store.touchRecall(id);
            } catch (err) {
              console.warn(`[memory] touchRecall 失败（id=${id}）: ${(err as Error).message}`);
            }
          }));
        },
      }),
    );
  }

  // 6. Tools
  const tools: Tool[] = [];
  if (options.tools !== false) {
    tools.push(...createMemoryTools(store, { saveTtlMs: options.toolTtlMs }));
  }

  return {
    store,
    retriever,
    extensions,
    transformers,
    tools,
    install() {
      return { extensions, transformers, tools };
    },
    dispose() {
      store.dispose();
    },
  };
}
