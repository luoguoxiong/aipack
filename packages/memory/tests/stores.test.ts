/**
 * 存储测试：InMemoryStore 与 FileMemoryStore 的 CRUD、TTL、统计、并发安全。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { InMemoryStore, finalizeEntry } from '../src/store/in-memory-store';
import { FileMemoryStore } from '../src/store/file-memory-store';
import type { Embedder, MemoryEvent } from '../src/types';

/** 延迟 embedder：人为引入异步窗口以暴露竞态 */
function slowEmbedder(delay = 5): Embedder {
  return {
    dimension: 3,
    async embed(text: string): Promise<number[]> {
      await new Promise((r) => setTimeout(r, delay));
      // 确定性伪向量：hash 首个字符
      return [text.charCodeAt(0) % 3, 1, 0.5];
    },
  };
}

function base(over: Partial<Parameters<InMemoryStore['save']>[0]> = {}): Parameters<InMemoryStore['save']>[0] {
  return { content: '测试内容', concepts: [], confidence: 0.6, source: 'tool', ...over };
}

describe('InMemoryStore', () => {
  it('save/get/delete/list/count 基本流转', async () => {
    const store = new InMemoryStore();
    const e = await store.save(base());
    assert.ok(e.id);
    assert.equal(await store.count(), 1);
    assert.equal((await store.get(e.id))?.content, '测试内容');
    assert.equal(await store.delete(e.id), true);
    assert.equal(await store.count(), 0);
  });

  it('ttlMs 换算为 expiresAt，prune 清理过期', async () => {
    const store = new InMemoryStore();
    const e = await store.save(base({ ttlMs: -1000 })); // 立即过期
    await store.save(base({ content: '不过期' }));
    const pruned = await store.prune();
    assert.equal(pruned, 1);
    assert.equal(await store.get(e.id), null);
    assert.equal(await store.count(), 1);
  });

  it('prune 清理低置信度', async () => {
    const store = new InMemoryStore();
    await store.save(base({ content: '低', confidence: 0.05 }));
    await store.save(base({ content: '高', confidence: 0.5 }));
    assert.equal(await store.prune({ minConfidence: 0.1 }), 1);
    assert.equal(await store.count(), 1);
  });

  it('touchRecall 更新统计但不刷新 updatedAt', async () => {
    const store = new InMemoryStore();
    const e = await store.save(base());
    const before = e.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await store.touchRecall(e.id);
    const after = await store.get(e.id);
    assert.equal(after!.recallCount, 1);
    assert.ok(after!.lastRecalledAt != null);
    assert.equal(after!.updatedAt, before); // updatedAt 仅表示内容修改时间
  });

  it('stats 汇总来源/置信度/召回/向量', async () => {
    const store = new InMemoryStore({ embedder: slowEmbedder(0) });
    await store.save(base({ source: 'tool', concepts: ['a'] }));
    await store.save(base({ source: 'capture', content: '会话要点', confidence: 0.8 }));
    const stats = await store.stats();
    assert.equal(stats.count, 2);
    assert.equal(stats.bySource.tool, 1);
    assert.equal(stats.bySource.capture, 1);
    assert.equal(stats.embeddingCount, 2);
    assert.ok(stats.avgConfidence >= 0.6);
  });

  it('searchVectors 返回向量命中', async () => {
    const store = new InMemoryStore({ embedder: slowEmbedder(0) });
    await store.save(base({ content: '苹果' }));
    const hits = await store.searchVectors([0, 1, 0.5], 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].matchedBy, 'embedding');
  });

  it('并发同 id save 串行化，不丢 embedding、不崩溃', async () => {
    const store = new InMemoryStore({ embedder: slowEmbedder(8) });
    const id = 'same-id';
    const [a, b] = await Promise.all([
      store.save(base({ id, content: '第一版' })),
      store.save(base({ id, content: '第二版' })),
    ]);
    assert.equal(a.id, b.id);
    const final = await store.get(id);
    assert.equal(final?.content, '第二版'); // 最后一次写入胜出
    assert.ok(final?.embedding); // embedding 保留（不因并发丢向量）
    assert.equal(await store.count(), 1);
  });
});

describe('FileMemoryStore', () => {
  async function tmpDir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'agp-mem-'));
  }

  it('持久化往返 + 并发批量加载', async () => {
    const dir = await tmpDir();
    const s1 = new FileMemoryStore({ baseDir: dir });
    const e1 = await s1.save(base({ content: '持久化第一条' }));
    await s1.save(base({ content: '持久化第二条' }));

    // 新实例加载同一目录
    const s2 = new FileMemoryStore({ baseDir: dir });
    assert.equal(await s2.count(), 2);
    assert.equal((await s2.get(e1.id))?.content, '持久化第一条');
    assert.equal((await s2.search('持久化', 5)).length, 2);
  });

  it('损坏文件跳过并上报事件', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'bad.json'), 'not-json{{{', 'utf-8');
    await s1Save(dir, '正常条目');
    const events: MemoryEvent[] = [];
    const s = new FileMemoryStore({ baseDir: dir, onEvent: (e) => events.push(e) });
    assert.equal(await s.count(), 1);
    assert.ok(events.some((e) => e.type === 'store:corrupt'));
    assert.ok(events.some((e) => e.type === 'store:load'));
  });

  it('maxAge 惰性过期清理', async () => {
    const dir = await tmpDir();
    const s0 = new FileMemoryStore({ baseDir: dir });
    await s0.save(base({ content: '即将过期' }));
    await new Promise((r) => setTimeout(r, 100));
    await s0.save(base({ content: '保留' }));
    // maxAge=50ms：第一条（≥100ms 前）必然过期，第二条（刚写入）保留
    const s = new FileMemoryStore({ baseDir: dir, maxAge: 50 });
    assert.equal(await s.count(), 1);
    assert.equal((await s.search('保留', 5)).length, 1);
  });

  it('delete 移除磁盘文件', async () => {
    const dir = await tmpDir();
    const s = new FileMemoryStore({ baseDir: dir });
    const e = await s.save(base());
    await s.delete(e.id);
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 0);
  });

  it('并发同 id save 串行化（文件存储不丢数据）', async () => {
    const dir = await tmpDir();
    const s = new FileMemoryStore({ baseDir: dir, embedder: slowEmbedder(8) });
    const id = 'race-id';
    await Promise.all([
      s.save(base({ id, content: 'A' })),
      s.save(base({ id, content: 'B' })),
    ]);
    const final = await s.get(id);
    assert.equal(final?.content, 'B');
    assert.ok(final?.embedding);
    assert.equal(await s.count(), 1);
  });
});

async function s1Save(dir: string, content: string): Promise<void> {
  const s = new FileMemoryStore({ baseDir: dir });
  await s.save(base({ content }));
}

describe('finalizeEntry', () => {
  it('填充默认字段并换算 expiresAt', () => {
    const e = finalizeEntry({ content: 'x', concepts: [], confidence: 0.6, source: 'tool', ttlMs: 1000 }, 1000);
    assert.equal(e.createdAt, 1000);
    assert.equal(e.expiresAt, 2000);
    assert.equal(e.recallCount, 0);
    assert.ok(e.id);
    assert.ok(!('ttlMs' in e)); // ttlMs 不进入条目
  });

  it('显式 expiresAt 保留', () => {
    const e = finalizeEntry({ content: 'x', concepts: [], confidence: 0.6, source: 'tool', expiresAt: 999 }, 1000);
    assert.equal(e.expiresAt, 999);
  });
});
