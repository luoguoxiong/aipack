/**
 * 合并器测试：相似合并、置信度 max+bonus、createdAt 保留、增量候选、
 * maxMemories 修剪、markConsolidated。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Consolidator } from '../src/consolidation/consolidator';
import { InMemoryStore } from '../src/store/in-memory-store';
import { HybridRetriever } from '../src/retrieval/hybrid-retriever';
import type { RetrieverLike } from '../src/retrieval/hybrid-retriever';
import type { MemoryEntry, MemorySearchResult, MemoryStore } from '../src/types';

function entry(id: string, content: string, confidence = 0.6, createdAt = 1000): MemoryEntry {
  return {
    id,
    content,
    concepts: [],
    confidence,
    source: 'tool',
    createdAt,
    updatedAt: createdAt,
    recallCount: 0,
  };
}

function hit(e: MemoryEntry, score: number): MemorySearchResult {
  return { entry: e, score, matchedBy: 'bm25' };
}

/** 脚本化 bm25 源：按 query 返回预设结果，并计数查询次数 */
function scripted(map: Record<string, MemorySearchResult[]>): RetrieverLike & { searches: number; queries: string[] } {
  return {
    searches: 0,
    queries: [],
    async search(query: string, limit = 10) {
      this.searches++;
      this.queries.push(query);
      return (map[query] ?? []).slice(0, limit);
    },
  };
}

async function setupStore(entries: MemoryEntry[]): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  for (const e of entries) {
    await store.save({ ...e });
  }
  return store;
}

describe('Consolidator', () => {
  it('合并相似记忆：置信度 max+bonus、content 取长、createdAt 保留最早', async () => {
    const e1 = entry('e1', '用户偏好深色主题', 0.5, 1000);
    const e2 = entry('e2', '用户偏好深色主题的界面', 0.6, 2000);
    const store = await setupStore([e1, e2]);

    const similarForQuery: Record<string, MemorySearchResult[]> = {
      [e2.content]: [hit(e1, 0.9), hit(e2, 0.95)],
    };
    const retriever = new HybridRetriever({ bm25: scripted(similarForQuery) });
    const c = new Consolidator(store, retriever);

    const { merged, pruned } = await c.run();
    assert.equal(merged, 1);
    assert.equal(pruned, 0);
    assert.equal(await store.count(), 1);

    const [survivor] = await store.list();
    assert.equal(survivor.id, 'e2'); // 较新条目保留 id
    assert.equal(survivor.confidence, 0.65); // max(0.6,0.5)+0.05，而非累加饱和
    assert.equal(survivor.createdAt, 1000); // createdAt 显式保留最早
    assert.equal(survivor.source, 'consolidation');
  });

  it('置信度累加不再快速饱和（两条 0.6 → 0.65 而非 1.0）', async () => {
    const a = entry('a', 'React', 0.6, 1000);
    const b = entry('b', 'React 框架', 0.6, 2000);
    const store = await setupStore([a, b]);
    const retriever = new HybridRetriever({
      bm25: scripted({ [b.content]: [hit(a, 0.9), hit(b, 0.95)] }),
    });
    const c = new Consolidator(store, retriever);
    await c.run();
    const [survivor] = await store.list();
    assert.ok(survivor.confidence < 1);
    assert.ok(Math.abs(survivor.confidence - 0.65) < 1e-9);
  });

  it('增量候选：第二轮只检索新增条目', async () => {
    const old = entry('old', '已有记忆', 0.6, 1000);
    const store = await setupStore([old]);
    const bm25 = scripted({});
    const retriever = new HybridRetriever({ bm25 });
    const c = new Consolidator(store, retriever);

    // 首轮全量：检索 old
    await new Promise((r) => setTimeout(r, 10)); // 拉开毫秒差，保证增量窗口确定性
    await c.run();
    assert.equal(bm25.searches, 1);

    // 新增一条（updatedAt > since）
    const fresh = entry('fresh', '新增记忆', 0.6, 5000);
    await store.save({ ...fresh });
    await new Promise((r) => setTimeout(r, 10)); // 使 fresh.updatedAt 早于本轮 markConsolidated

    // 第二轮增量：只检索 fresh（1 次），不重新检索 old
    bm25.searches = 0;
    bm25.queries = [];
    await c.run();
    assert.equal(bm25.searches, 1);
    assert.deepEqual(bm25.queries, ['新增记忆']);

    // 第三轮无变化：0 次检索
    bm25.searches = 0;
    bm25.queries = [];
    await c.run();
    assert.equal(bm25.searches, 0);
  });

  it('markConsolidated 记录合并时间', async () => {
    const store = await setupStore([entry('a', 'x', 0.6, 1000)]);
    const retriever = new HybridRetriever({ bm25: scripted({}) });
    const c = new Consolidator(store, retriever);
    await c.run();
    const stats = await store.stats();
    assert.ok(stats.lastConsolidatedAt != null);
  });

  it('maxMemories 修剪置信度最低的条目', async () => {
    const store = await setupStore([
      entry('hi', '高置信', 0.9, 1000),
      entry('mid', '中置信', 0.5, 2000),
      entry('low', '低置信', 0.3, 3000),
    ]);
    const retriever = new HybridRetriever({ bm25: scripted({}) });
    const c = new Consolidator(store, retriever);
    const { pruned } = await c.run({ maxMemories: 1 });
    assert.equal(pruned, 2);
    assert.equal(await store.count(), 1);
    const [survivor] = await store.list();
    assert.equal(survivor.id, 'hi');
  });

  it('无相似记忆时不误删', async () => {
    const store = await setupStore([
      entry('a', '苹果', 0.6, 1000),
      entry('b', '香蕉', 0.6, 2000),
    ]);
    const retriever = new HybridRetriever({ bm25: scripted({}) });
    const c = new Consolidator(store, retriever);
    const { merged } = await c.run({ similarityThreshold: 0.85 });
    assert.equal(merged, 0);
    assert.equal(await store.count(), 2);
  });
});

// ─── 原子性：先存后删 ────────────────────────────────────────────

/** 可注入 delete/save 故障的 MemoryStore 包装 */
class FaultyStore implements MemoryStore {
  constructor(
    private inner: InMemoryStore,
    private opts: { failDelete?: boolean; failSave?: boolean } = {},
  ) {}
  async save(entry: Parameters<MemoryStore['save']>[0]) {
    if (this.opts.failSave) throw new Error('save failed');
    return this.inner.save(entry);
  }
  async delete(id: string) {
    if (this.opts.failDelete) throw new Error('delete failed');
    return this.inner.delete(id);
  }
  async get(id: string) { return this.inner.get(id); }
  async list(limit?: number) { return this.inner.list(limit); }
  async search(query: string, limit?: number) { return this.inner.search(query, limit); }
  async searchVectors(vec: number[], limit?: number) { return this.inner.searchVectors(vec, limit); }
  async touchRecall(id: string, at?: number) { return this.inner.touchRecall(id, at); }
  async consolidate(opts?: unknown) { return this.inner.consolidate(opts as never); }
  async prune(opts?: unknown) { return this.inner.prune(opts as never); }
  async count() { return this.inner.count(); }
  setConsolidator(c: unknown) { this.inner.setConsolidator(c as never); }
  markConsolidated(at?: number) { this.inner.markConsolidated(at); }
  async stats() { return this.inner.stats(); }
  dispose() { this.inner.dispose(); }
}

describe('Consolidator 原子性', () => {
  it('save 失败时被合并记忆不丢失（旧实现先删后存会丢）', async () => {
    const e1 = entry('e1', '用户偏好深色主题', 0.5, 1000);
    const e2 = entry('e2', '用户偏好深色主题的界面', 0.6, 2000);
    const inner = await setupStore([e1, e2]);
    const store = new FaultyStore(inner, { failSave: true });

    const similarForQuery: Record<string, MemorySearchResult[]> = {
      [e2.content]: [hit(e1, 0.9), hit(e2, 0.95)],
    };
    const retriever = new HybridRetriever({ bm25: scripted(similarForQuery) });
    const c = new Consolidator(store, retriever);

    await assert.rejects(c.run());
    // save 失败：两条原始记忆都必须在（旧实现会先删掉 e1 再 save 抛错 → e1 丢失）
    assert.equal(await store.count(), 2, 'save 失败不应删除任何记忆');
    assert.ok(await store.get('e1'), 'e1 应保留');
    assert.ok(await store.get('e2'), 'e2 应保留');
  });

  it('delete 失败时不中断，幸存者已保存（重复条目可被下一轮吸收）', async () => {
    const e1 = entry('e1', '用户偏好深色主题', 0.5, 1000);
    const e2 = entry('e2', '用户偏好深色主题的界面', 0.6, 2000);
    const inner = await setupStore([e1, e2]);
    const store = new FaultyStore(inner, { failDelete: true });

    const similarForQuery: Record<string, MemorySearchResult[]> = {
      [e2.content]: [hit(e1, 0.9), hit(e2, 0.95)],
    };
    const retriever = new HybridRetriever({ bm25: scripted(similarForQuery) });
    const c = new Consolidator(store, retriever);

    const { merged } = await c.run();
    assert.equal(merged, 1, '合并计数应 +1');
    // 幸存者已保存（内容为合并后），被删失败的 e1 残留但不丢数据
    assert.equal(await store.count(), 2, 'delete 失败仅留重复，不丢数据');
    const survivor = await store.get('e2');
    assert.ok(survivor && survivor.content.includes('界面'), '幸存者应包含合并后的内容');
    assert.ok(await store.get('e1'), 'delete 失败的 e1 应保留（可被下一轮合并吸收）');
  });
});
