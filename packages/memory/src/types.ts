/**
 * aipack-memory - 核心类型定义
 *
 * 记忆条目、存储契约、检索结果、Embedder 与摘要函数接口。
 * 不依赖任何外部实现，是整个插件的类型基础。
 */

// ─── 记忆条目 ───────────────────────────────────────────────────────

/** 记忆来源 */
export type MemorySource = 'capture' | 'tool' | 'consolidation';

/**
 * 单条记忆条目。
 * 参考 agentmemory：每条记忆含置信度、生命周期、检索统计与可选向量。
 */
export interface MemoryEntry {
  /** 唯一标识 */
  id: string;
  /** 记忆正文 */
  content: string;
  /** 关键词 / 概念标签（用于 BM25 索引与展示） */
  concepts: string[];
  /** 置信度 0..1（捕获默认 0.6，摘要 0.8，合并后累加并截断到 1，可衰减） */
  confidence: number;
  /** 来源 */
  source: MemorySource;
  /** 来源会话 key（capture 时记录） */
  sessionKey?: string;
  /** 创建时间（ms 时间戳） */
  createdAt: number;
  /** 最后更新时间（ms 时间戳） */
  updatedAt: number;
  /** 最后一次被检索注入的时间 */
  lastRecalledAt?: number;
  /** 被检索注入次数 */
  recallCount: number;
  /** 可选向量（当配置 Embedder 时填充，用于混合检索） */
  embedding?: number[];
  /** 过期时间（ms 时间戳），由 save 时的 ttlMs 换算，或直接指定 */
  expiresAt?: number;
  /** 额外元数据 */
  meta?: Record<string, unknown>;
}

// ─── 检索结果 ───────────────────────────────────────────────────────

export type MatchedBy = 'bm25' | 'embedding' | 'hybrid';

export interface MemorySearchResult {
  entry: MemoryEntry;
  /** 分数：默认检索为 min-max 归一化 0..1；raw 模式（合并器用）为 BM25/cosine 原始分数 */
  score: number;
  matchedBy: MatchedBy;
}

// ─── Embedder 接口 ──────────────────────────────────────────────────

/**
 * 向量化接口（可选）。
 * 默认不提供，退化为纯 BM25 检索（零依赖、零 API Key）。
 * 用户可自行实现以接入 ollama / @huggingface/transformers / OpenAI embedding 等。
 */
export interface Embedder {
  /** 将文本转为向量 */
  embed(text: string): Promise<number[]>;
  /** 向量维度（可选，用于校验） */
  dimension?: number;
}

// ─── LLM 摘要函数 ───────────────────────────────────────────────────

/**
 * 可选摘要函数（默认关闭，零 token 消耗）。
 * 提供后，capture 会把整轮对话压成一句精炼记忆与可选概念。
 * 返回 null 表示放弃摘要（回退到零-LLM 抽取）。
 */
export type SummarizeFn = (input: {
  userMessage: string;
  assistantContent: string;
  toolsUsed: string[];
}) => Promise<{ summary: string; concepts?: string[] } | null>;

// ─── 合并 / 修剪选项 ───────────────────────────────────────────────

/** Consolidator 的最小契约（避免 store ↔ consolidator 循环依赖） */
export interface ConsolidatorLike {
  run(options?: ConsolidateOptions): Promise<{ merged: number; pruned: number }>;
}

export interface ConsolidateOptions {
  /** 相似度阈值，>= 该值视为可合并（默认 0.85）。按检索原始分数（BM25 raw / cosine）判定 */
  similarityThreshold?: number;
  /** 合并后记忆数量上限（保留置信度最高的，默认无限制） */
  maxMemories?: number;
  /** 最大保留时长（ms），超过则修剪 */
  maxAgeMs?: number;
  /** 最低置信度，低于则修剪（默认 0.1） */
  minConfidence?: number;
}

/** 文件存储选项 */
export interface FileMemoryStoreOptions {
  /** 存储根目录（支持 ~ 开头，默认 <cwd>/.aipack/memory） */
  baseDir?: string;
  /** 过期时间（ms），超过 updatedAt 的记忆在加载时惰性清理 */
  maxAge?: number;
}

/** 保存入参：content/concepts/confidence/source 必填，其余可选；ttlMs 换算为 expiresAt */
export type MemorySaveInput = Pick<
  MemoryEntry,
  'content' | 'concepts' | 'confidence' | 'source'
> &
  Partial<Omit<MemoryEntry, 'content' | 'concepts' | 'confidence' | 'source'>> & {
    /** 可选 TTL（ms）：保存时换算为 expiresAt = createdAt + ttlMs（优先于显式 expiresAt） */
    ttlMs?: number;
  };

// ─── 可观测性：事件与统计 ───────────────────────────────────────────

/** 记忆系统事件（失败/整理等关键节点，供外部监控与日志） */
export type MemoryEvent =
  | { type: 'store:load'; loaded: number; skipped: number; ms: number }
  | { type: 'store:corrupt'; file: string }
  | { type: 'embedding:error'; id?: string; error: string }
  | { type: 'capture:failed'; sessionKey?: string; error: string }
  | { type: 'consolidate:failed'; error: string }
  | { type: 'consolidate'; merged: number; pruned: number; ms: number }
  | { type: 'prune'; removed: number };

/** 事件接收器（可注入；默认把失败类事件打印到 console.warn） */
export type MemoryEventSink = (event: MemoryEvent) => void;

/** 记忆库统计快照 */
export interface MemoryStats {
  /** 记忆总数 */
  count: number;
  /** 带向量的条目数 */
  embeddingCount: number;
  /** 按来源计数 */
  bySource: Record<MemorySource, number>;
  /** 平均置信度 0..1 */
  avgConfidence: number;
  /** 检索注入总次数 */
  recallTotal: number;
  /** 最近一次被检索注入的时间 */
  lastRecalledAt?: number;
  /** 最近一次合并（consolidate）时间 */
  lastConsolidatedAt?: number;
}

// ─── 存储契约 ───────────────────────────────────────────────────────

/**
 * 记忆存储适配器接口。
 * 实现需自行保证 search 的检索能力（内置 BM25Retriever 可复用）。
 */
export interface MemoryStore {
  /**
   * 保存记忆（新建或更新）。
   * 调用方可省略 id/createdAt/updatedAt/recallCount，由 store 填充。
   */
  save(entry: MemorySaveInput): Promise<MemoryEntry>;
  /** 读取单条 */
  get(id: string): Promise<MemoryEntry | null>;
  /** 删除单条，返回是否删除成功 */
  delete(id: string): Promise<boolean>;
  /** 列出记忆（按 updatedAt 降序，可限数量） */
  list(limit?: number): Promise<MemoryEntry[]>;
  /** 基于查询检索（默认纯 BM25） */
  search(query: string, limit?: number): Promise<MemorySearchResult[]>;
  /**
   * 基于向量检索（可选能力）：返回 cosine 降序的 top-N。
   * 未配置 embedding 时返回空数组。默认 store 在 config embedder 后可用。
   */
  searchVectors(queryVec: number[], limit?: number): Promise<MemorySearchResult[]>;
  /** 更新某条记忆的检索统计（lastRecalledAt / recallCount++） */
  touchRecall(id: string, at?: number): Promise<void>;
  /** 合并相似记忆 + 修剪过期/低置信度，返回合并与修剪计数 */
  consolidate(options?: ConsolidateOptions): Promise<{ merged: number; pruned: number }>;
  /** 仅修剪（按 maxAge / minConfidence / expiresAt），返回修剪数量 */
  prune(options?: { maxAgeMs?: number; minConfidence?: number }): Promise<number>;
  /** 记忆总数 */
  count(): Promise<number>;
  /** 注入合并器（由插件层装配，用于 consolidate()） */
  setConsolidator(consolidator: ConsolidatorLike): void;
  /** 记录最近一次合并时间（驱动增量合并的候选窗口） */
  markConsolidated(at?: number): void;
  /** 统计快照（可观测性） */
  stats(): Promise<MemoryStats>;
  /** 释放资源（热重载场景；当前实现为无操作占位） */
  dispose(): void;
}
