/**
 * apps/ai_rag_database_routing/src/vectordb.ts
 *
 * 零依赖本地向量存储(替代原版的 Qdrant + OpenAIEmbeddings):
 *   - 三个命名集合:products(产品)/ support(支持)/ finance(财务)
 *   - 文本分块(chunk≈1000 字符,overlap 200)+ 稀疏 TF-IDF 向量(英文词 + 中文双字/单字)
 *   - 余弦相似度检索,按集合取 top-k 计算平均分用于路由
 *   - JSON 文件持久化,重启不丢数据(目录由 VECTOR_DB_DIR 配置)
 *
 * 设计取舍:TF-IDF 稀疏向量是纯 JS 实现、离线可用;真实向量效果由
 * 「向量路由 → LLM 路由 → 网页搜索兜底」三级链路弥补(与 awesome-llm-apps 原版一致)。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// ─── 集合配置(与 awesome-llm-apps 原版一一对应)──────────────────────

export type CollectionId = 'products' | 'support' | 'finance';

export interface CollectionMeta {
  id: CollectionId;
  name: string;
  description: string;
}

export const COLLECTIONS: Record<CollectionId, CollectionMeta> = {
  products: {
    id: 'products',
    name: '产品信息',
    description: '产品详情、规格与特性(产品手册、说明书、规格表等)',
  },
  support: {
    id: 'support',
    name: '客户支持与 FAQ',
    description: '客户支持信息、常见问题与指南(FAQ、帮助文档、操作指南等)',
  },
  finance: {
    id: 'finance',
    name: '财务信息',
    description: '财务数据、收入、成本与负债(财务报告、营收数据等)',
  },
};

export const COLLECTION_IDS = Object.keys(COLLECTIONS) as CollectionId[];

export function isCollectionId(v: string): v is CollectionId {
  return v in COLLECTIONS;
}

// ─── 文本分块 ─────────────────────────────────────────────────────

/** 按段落优先切分文本:目标块大小 chunkSize,相邻块 overlap 字符 */
export function chunkText(text: string, chunkSize = 1000, overlap = 200): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\u3000/g, ' ').trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + chunkSize, normalized.length);
    if (end < normalized.length) {
      // 在窗口末尾 20% 内找换行符,尽量在段落边界切断
      const boundary = normalized.lastIndexOf('\n', end);
      if (boundary > start + chunkSize * 0.8) end = boundary;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = end - overlap;
  }
  return chunks;
}

// ─── 分词:英文单词/数字 + 中文双字、单字 ───────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'for', 'on', 'with', 'and', 'or',
  'is', 'are', 'was', 'were', 'be', 'been', 'at', 'by', 'from', 'as',
  'it', 'this', 'that', 'these', 'those', 'i', 'you', 'we', 'they',
  'my', 'your', 'our', 'their', 'what', 'how', 'why', 'when', 'where',
  'who', 'do', 'does', 'did', 'will', 'would', 'can', 'could', 'should',
  'shall', 'may', 'might', 'must', 'please', 'give', 'tell', 'me', 'us',
  'about', 'into', 'over', 'under', 'again', 'then', 'than', 'so', 'too',
  'very', 'just', 'not', 'no', 'yes', 'ok', 'okay', 'hi', 'hello',
]);

/** 分词:返回 term 数组(英文小写词 + 数字,中文双字与单字) */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  // 英文与数字(长度 > 1 且非停用词)
  for (const m of lower.matchAll(/[a-z0-9]+/g)) {
    const t = m[0];
    if (t.length > 1 && !STOPWORDS.has(t)) tokens.push(t);
  }
  // 中文:连续汉字按双字滑窗 + 独立单字
  for (const run of lower.matchAll(/[\u4e00-\u9fa5]+/g)) {
    const s = run[0];
    if (s.length === 1) {
      tokens.push(s);
    } else {
      for (let i = 0; i < s.length - 1; i++) tokens.push(s.slice(i, i + 2));
    }
  }
  return tokens;
}

// ─── 内部文档/索引结构 ─────────────────────────────────────────────

interface StoredDoc {
  id: string;
  text: string;
  source: string;
  addedAt: number;
  /** term → 词频(tf) */
  terms: Record<string, number>;
  /** 文档向量 L2 范数(用于余弦相似度) */
  norm: number;
}

export interface SearchHit {
  id: string;
  text: string;
  source: string;
  score: number;
}

export interface DbStats {
  collection: CollectionId;
  name: string;
  chunkCount: number;
  sourceCount: number;
}

// ─── 向量存储 ──────────────────────────────────────────────────────

export class VectorStore {
  private dir: string;
  private file: string;
  private docs: Record<CollectionId, StoredDoc[]> = {
    products: [],
    support: [],
    finance: [],
  };
  /** 未持久化的脏标记 */
  private dirty = false;

  constructor(options: { dir: string }) {
    this.dir = path.resolve(options.dir);
    this.file = path.join(this.dir, 'store.json');
    this.load();
  }

  /** 计算单个文档的 term→tf 与 L2 范数 */
  private buildVector(text: string): { terms: Record<string, number>; norm: number } {
    const terms: Record<string, number> = {};
    for (const t of tokenize(text)) terms[t] = (terms[t] || 0) + 1;
    let norm = 0;
    for (const f of Object.values(terms)) norm += f * f;
    return { terms, norm: Math.sqrt(norm) || 1 };
  }

  /** 向指定集合添加文本(自动分块;与集合内已有块完全重复的跳过) */
  addTexts(collection: CollectionId, texts: string[], source: string): { added: number; skipped: number } {
    const col = this.docs[collection];
    let added = 0;
    let skipped = 0;
    const seen = new Set(col.map((d) => d.text));
    const now = Date.now();
    for (const text of texts) {
      for (const chunk of chunkText(text)) {
        if (seen.has(chunk)) {
          skipped++;
          continue;
        }
        const { terms, norm } = this.buildVector(chunk);
        col.push({ id: randomUUID(), text: chunk, source, addedAt: now, terms, norm });
        seen.add(chunk);
        added++;
      }
    }
    if (added > 0) this.dirty = true;
    return { added, skipped };
  }

  /** 清空指定集合 */
  clear(collection: CollectionId): number {
    const removed = this.docs[collection].length;
    this.docs[collection] = [];
    if (removed > 0) this.dirty = true;
    return removed;
  }

  /** 各集合统计 */
  stats(): DbStats[] {
    return COLLECTION_IDS.map((cid) => {
      const col = this.docs[cid];
      return {
        collection: cid,
        name: COLLECTIONS[cid].name,
        chunkCount: col.length,
        sourceCount: new Set(col.map((d) => d.source)).size,
      };
    });
  }

  /** 在指定集合内做 TF-IDF 余弦相似度检索,返回 top-k */
  search(collection: CollectionId, query: string, k = 4): SearchHit[] {
    const col = this.docs[collection];
    if (col.length === 0) return [];

    // 文档频率 df → idf
    const df = new Map<string, number>();
    for (const d of col) {
      for (const t of Object.keys(d.terms)) df.set(t, (df.get(t) || 0) + 1);
    }
    const N = col.length;
    const idf = new Map<string, number>();
    for (const [t, f] of df) idf.set(t, Math.log((N + 1) / (f + 1)) + 1);

    // 查询向量(仅统计语料中存在的词,避免未见词放大范数)
    const q = new Map<string, number>();
    for (const t of tokenize(query)) {
      if (idf.has(t)) q.set(t, (q.get(t) || 0) + 1);
    }
    if (q.size === 0) return [];

    let qNorm = 0;
    for (const [t, f] of q) {
      const w = idf.get(t)!;
      qNorm += (f * w) ** 2;
    }
    qNorm = Math.sqrt(qNorm) || 1;

    const scored: Array<{ doc: StoredDoc; score: number }> = [];
    for (const d of col) {
      let dot = 0;
      for (const [t, f] of q) {
        const dtf = d.terms[t];
        if (dtf) {
          const w = idf.get(t)!;
          dot += f * w * dtf * w;
        }
      }
      const score = dot / (qNorm * d.norm);
      if (score > 0) scored.push({ doc: d, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map(({ doc, score }) => ({ id: doc.id, text: doc.text, source: doc.source, score }));
  }

  /** 三集合平均相似度路由:取平均分最高的集合,达到阈值则采用 */
  routeBySimilarity(query: string, threshold: number, k = 3): { collection: CollectionId; score: number } | null {
    let best: { collection: CollectionId; score: number } | null = null;
    for (const cid of COLLECTION_IDS) {
      const hits = this.search(cid, query, k);
      if (hits.length === 0) continue;
      const avg = hits.reduce((s, h) => s + h.score, 0) / hits.length;
      if (!best || avg > best.score) best = { collection: cid, score: avg };
    }
    if (best && best.score >= threshold) return best;
    return null;
  }

  // ── 持久化 ─────────────────────────────────────────────────────

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as {
        docs?: Partial<Record<CollectionId, StoredDoc[]>>;
      };
      for (const cid of COLLECTION_IDS) {
        const list = raw.docs?.[cid];
        if (Array.isArray(list)) this.docs[cid] = list;
      }
      this.dirty = false;
    } catch (err) {
      console.warn(`[vectordb] 读取持久化文件失败,将使用空库:`, (err as Error).message);
    }
  }

  /** 保存到磁盘(仅当有变更) */
  save(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.file, JSON.stringify({ docs: this.docs }), 'utf-8');
      this.dirty = false;
    } catch (err) {
      console.warn(`[vectordb] 保存失败:`, (err as Error).message);
    }
  }
}
