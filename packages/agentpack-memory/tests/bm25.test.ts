/**
 * BM25 索引测试：基础检索、CJK bigram 区分度、增删改。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BM25Index, BM25Retriever } from '../src/retrieval/bm25';
import { tokenize } from '../src/retrieval/tokenizer';
import type { MemoryEntry } from '../src/types';

function entry(id: string, content: string): MemoryEntry {
  return {
    id,
    content,
    concepts: [],
    confidence: 0.6,
    source: 'tool',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    recallCount: 0,
  };
}

describe('BM25Index', () => {
  it('添加与检索 top-N', () => {
    const idx = new BM25Index();
    idx.add('a', tokenize('用户喜欢 React'));
    idx.add('b', tokenize('用户喜欢 Vue'));
    const hits = idx.search(tokenize('React'), 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, 'a');
  });

  it('CJK bigram 提升区分度（数据科学 vs 数据库）', () => {
    const idx = new BM25Index();
    idx.add('db', tokenize('数据库设计'));
    idx.add('ds', tokenize('数据科学项目'));
    // 查询「科学」应命中「数据科学」而非「数据库」
    const hits = idx.search(tokenize('科学'), 5);
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].id, 'ds');
  });

  it('同 id 覆盖更新（移除旧倒排）', () => {
    const idx = new BM25Index();
    idx.add('a', tokenize('苹果'));
    idx.add('a', tokenize('香蕉'));
    const hits = idx.search(tokenize('苹果'), 5);
    assert.equal(hits.length, 0);
    const hits2 = idx.search(tokenize('香蕉'), 5);
    assert.equal(hits2.length, 1);
    assert.equal(hits2[0].id, 'a');
    assert.equal(idx.size, 1);
  });

  it('移除文档', () => {
    const idx = new BM25Index();
    idx.add('a', tokenize('苹果'));
    idx.add('b', tokenize('香蕉'));
    idx.remove('a');
    assert.equal(idx.size, 1);
    assert.equal(idx.search(tokenize('苹果'), 5).length, 0);
  });

  it('clear 清空', () => {
    const idx = new BM25Index();
    idx.add('a', tokenize('苹果'));
    idx.clear();
    assert.equal(idx.size, 0);
    assert.equal(idx.search(tokenize('苹果'), 5).length, 0);
  });
});

describe('BM25Retriever', () => {
  it('返回 MemorySearchResult 并映射 entry', async () => {
    const idx = new BM25Index();
    const entries = new Map<string, MemoryEntry>();
    const e = entry('a', '用户偏好深色主题');
    entries.set('a', e);
    idx.add('a', tokenize(e.content));
    const retriever = new BM25Retriever(idx, entries);
    const results = await retriever.search('深色主题', 5);
    assert.equal(results.length, 1);
    assert.equal(results[0].entry.id, 'a');
    assert.equal(results[0].matchedBy, 'bm25');
    assert.ok(results[0].score > 0);
  });

  it('分数归一化到 [0,1]：完全同文≈1，绝对阈值（0.85）对 BM25 成立', async () => {
    const idx = new BM25Index();
    const entries = new Map<string, MemoryEntry>();
    // 高度相似的两条：完全同文查询应映射到接近 1（>0.85），可被合并器按绝对阈值判定
    const a = entry('a', '用户偏好深色主题和暗色模式');
    const b = entry('b', '用户偏好深色主题');
    entries.set('a', a);
    entries.set('b', b);
    idx.add('a', tokenize(a.content));
    idx.add('b', tokenize(b.content));
    const retriever = new BM25Retriever(idx, entries);

    const results = await retriever.search('用户偏好深色主题', 5);
    assert.ok(results.length >= 1);
    for (const r of results) {
      assert.ok(r.score >= 0 && r.score <= 1, `score 应在 [0,1]，实际 ${r.score}`);
    }
    // 完全同文的 b 应得到高分（可合并），而不仅是任意弱匹配
    const bHit = results.find(r => r.entry.id === 'b');
    assert.ok(bHit && bHit.score > 0.85, `完全同文分数应 > 0.85（可触发合并），实际 ${bHit?.score}`);
  });

  it('空库返回空', async () => {
    const idx = new BM25Index();
    const retriever = new BM25Retriever(idx, new Map());
    assert.deepEqual(await retriever.search('anything', 5), []);
  });
});
