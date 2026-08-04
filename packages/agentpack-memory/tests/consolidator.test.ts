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
import type { MemoryEntry, MemorySearchResult } from '../src/types';

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
