/**
 * 混合检索测试：纯 BM25、双路独立召回融合（修复向量被 BM25 封顶）、
 * 按次 minScore 覆盖、自定义 store 候选重排回退。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HybridRetriever } from '../src/retrieval/hybrid-retriever';
import type {
  RetrieverLike,
  VectorSearchLike,
} from '../src/retrieval/hybrid-retriever';
import type { Embedder, MemoryEntry, MemorySearchResult } from '../src/types';

function entry(id: string, content: string): MemoryEntry {
  return {
    id,
    content,
    concepts: [],
    confidence: 0.6,
    source: 'tool',
    createdAt: 0,
    updatedAt: 0,
    recallCount: 0,
  };
}

function hit(e: MemoryEntry, score: number, matchedBy: MemorySearchResult['matchedBy']): MemorySearchResult {
  return { entry: e, score, matchedBy };
}

function scriptedBm25(map: Record<string, MemorySearchResult[]>): RetrieverLike & { calls: string[] } {
  return {
    calls: [],
    async search(query: string, limit = 5) {
      this.calls.push(query);
      return (map[query] ?? []).slice(0, limit);
    },
  };
}

const embedder: Embedder = {
  async embed(): Promise<number[]> {
    return [1, 0];
  },
};

describe('HybridRetriever', () => {
  it('纯 BM25：min-max 归一化 + 阈值过滤', async () => {
    const e1 = entry('a', '苹果');
    const e2 = entry('b', '香蕉');
    const bm25 = scriptedBm25({ 水果: [hit(e1, 3, 'bm25'), hit(e2, 1, 'bm25')] });
    const r = new HybridRetriever({ bm25, minScore: 0.5 });
    const res = await r.search('水果', 5);
    assert.equal(res.length, 1);
    assert.equal(res[0].entry.id, 'a');
    assert.equal(res[0].score, 1); // 3 归一化为 1
    assert.equal(res[0].matchedBy, 'bm25');
  });

  it('双路独立召回：向量路可召回 BM25 完全漏掉的记忆（核心修复）', async () => {
    const onlyBm25 = entry('a', '用户喜欢 React');
    const onlyVec = entry('b', '前端框架的选型偏好');
    const bm25 = scriptedBm25({ 技术: [hit(onlyBm25, 2.0, 'bm25')] });
    const vector: VectorSearchLike = {
      async searchVectors(vec, limit = 5) {
        return [hit(onlyVec, 0.9, 'embedding')].slice(0, limit);
      },
    };
    const r = new HybridRetriever({ bm25, vector, embedder });
    const res = await r.search('技术', 5);
    const ids = res.map((x) => x.entry.id);
    assert.ok(ids.includes('b'), '向量独立召回的条目应出现在结果中');
    assert.ok(ids.includes('a'));
    // 仅向量命中的条目 matchedBy = embedding
    assert.equal(res.find((x) => x.entry.id === 'b')?.matchedBy, 'embedding');
  });

  it('两路同时命中标记为 hybrid', async () => {
    const e = entry('a', 'React 前端');
    const bm25 = scriptedBm25({ React: [hit(e, 2.0, 'bm25')] });
    const vector: VectorSearchLike = {
      async searchVectors() {
        return [hit(e, 0.8, 'embedding')];
      },
    };
    const r = new HybridRetriever({ bm25, vector, embedder });
    const res = await r.search('React', 5);
    assert.equal(res[0].matchedBy, 'hybrid');
  });

  it('按次 minScore 覆盖，不影响 retriever 默认值', async () => {
    const e1 = entry('a', '苹果');
    const e2 = entry('b', '香蕉');
    const bm25 = scriptedBm25({ 水果: [hit(e1, 3, 'bm25'), hit(e2, 1, 'bm25')] });
    const r = new HybridRetriever({ bm25, minScore: 0.1 });
    // 默认阈值 0.1：min-max 归一化后 e1=1、e2=0，仅 e1 通过
    assert.equal((await r.search('水果', 5)).length, 1);
    // 按次覆盖阈值 0：两条都保留
    const loose = await r.search('水果', 5, { minScore: 0 });
    assert.equal(loose.length, 2);
    // 按次覆盖阈值 0.9：仅归一化后为 1 的保留
    const strict = await r.search('水果', 5, { minScore: 0.9 });
    assert.equal(strict.length, 1);
    assert.equal(strict[0].entry.id, 'a');
    // 默认值未被篡改
    assert.equal(r.minScore, 0.1);
  });

  it('有 embedder 但无向量源：退化为候选重排（兼容路径）', async () => {
    const e1 = entry('a', '用户喜欢 React');
    const bm25 = scriptedBm25({ React: [hit(e1, 2.0, 'bm25')] });
    const r = new HybridRetriever({ bm25, embedder }); // 无 vector
    const res = await r.search('React', 5);
    assert.ok(res.length >= 1);
    assert.equal(res[0].entry.id, 'a');
  });

  it('embedder 失败退化为纯 BM25', async () => {
    const e1 = entry('a', '用户喜欢 React');
    const bm25 = scriptedBm25({ React: [hit(e1, 2.0, 'bm25')] });
    const broken: Embedder = {
      async embed() {
        throw new Error('embed 服务不可用');
      },
    };
    const r = new HybridRetriever({ bm25, embedder: broken });
    const res = await r.search('React', 5);
    assert.equal(res.length, 1);
    assert.equal(res[0].matchedBy, 'bm25');
  });

  it('空结果返回空数组', async () => {
    const bm25 = scriptedBm25({});
    const r = new HybridRetriever({ bm25 });
    assert.deepEqual(await r.search('无', 5), []);
    assert.deepEqual(await r.search('无', 0), []);
  });
});
