/**
 * VectorIndex 测试：精确检索、替换/删除、IVF 分桶、维度校验。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VectorIndex } from '../src/retrieval/vector-index';

function norm(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (norm(a) * norm(b));
}

describe('VectorIndex（brute-force）', () => {
  it('检索 top-k cosine 降序', () => {
    const vi = new VectorIndex();
    vi.add('a', [1, 0, 0]);
    vi.add('b', [0, 1, 0]);
    vi.add('c', [0.9, 0.1, 0]);
    const hits = vi.search([1, 0, 0], 2);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].id, 'a');
    assert.equal(hits[1].id, 'c');
    assert.ok(Math.abs(hits[0].score - 1) < 1e-9);
  });

  it('同 id 替换', () => {
    const vi = new VectorIndex();
    vi.add('a', [1, 0, 0]);
    vi.add('a', [0, 1, 0]);
    assert.equal(vi.size, 1);
    const hits = vi.search([0, 1, 0], 1);
    assert.equal(hits[0].id, 'a');
  });

  it('删除与清空', () => {
    const vi = new VectorIndex();
    vi.add('a', [1, 0, 0]);
    assert.equal(vi.remove('a'), true);
    assert.equal(vi.remove('a'), false);
    assert.equal(vi.size, 0);
    vi.add('b', [1, 0, 0]);
    vi.clear();
    assert.equal(vi.size, 0);
  });

  it('维度不一致忽略，查询维度不符返回空', () => {
    const vi = new VectorIndex();
    vi.add('a', [1, 0, 0]);
    assert.equal(vi.add('b', [1, 0]), false); // 维度不一致
    assert.equal(vi.size, 1);
    assert.deepEqual(vi.search([1, 0], 5), []);
  });

  it('分数与独立 cosine 计算一致', () => {
    const vi = new VectorIndex();
    vi.add('a', [0.3, 0.8, 0.5]);
    const [hit] = vi.search([0.5, 0.2, 0.7], 1);
    assert.ok(Math.abs(hit.score - cosine([0.5, 0.2, 0.7], [0.3, 0.8, 0.5])) < 1e-9);
  });

  it('空向量查询返回空', () => {
    const vi = new VectorIndex();
    vi.add('a', [1, 0, 0]);
    assert.deepEqual(vi.search([0, 0, 0], 5), []);
  });
});

describe('VectorIndex（IVF 分桶）', () => {
  it('近似召回：主导维度分桶仍能命中邻近桶', () => {
    const vi = new VectorIndex({ ivfBuckets: 8 });
    for (let i = 0; i < 8; i++) {
      const v = new Array(8).fill(0);
      v[i] = 1;
      vi.add(`d${i}`, v);
    }
    const hits = vi.search(new Array(8).fill(0).map((_, i) => (i === 3 ? 1 : 0.05)), 8);
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].id, 'd3');
  });

  it('同 id 替换后桶内无重复', () => {
    const vi = new VectorIndex({ ivfBuckets: 4 });
    vi.add('a', [1, 0, 0, 0]);
    vi.add('a', [0, 0, 1, 0]);
    const hits = vi.search([0, 0, 1, 0], 1);
    assert.equal(hits[0].id, 'a');
    assert.equal(vi.size, 1);
  });

  it('删除后不再命中', () => {
    const vi = new VectorIndex({ ivfBuckets: 4 });
    vi.add('a', [1, 0, 0, 0]);
    vi.remove('a');
    assert.deepEqual(vi.search([1, 0, 0, 0], 5), []);
  });
});
