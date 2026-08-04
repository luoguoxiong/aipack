/**
 * 并发原语测试：KeyedMutex 同 key 串行化、异 key 并行、无锁泄漏。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { KeyedMutex } from '../src/utils/keyed-mutex';

/** 让出事件循环若干次，放大交错窗口 */
function tick(n = 3): Promise<void> {
  let p: Promise<void> = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

describe('KeyedMutex', () => {
  it('同一 key 的操作严格串行', async () => {
    const m = new KeyedMutex();
    const order: number[] = [];
    const op = (n: number) =>
      m.withLock('k', async () => {
        order.push(n);
        await tick();
        order.push(n);
      });
    await Promise.all([op(1), op(2), op(3)]);
    // 每个 op 的进入/退出必须成对相邻，不允许交错
    for (let i = 0; i < order.length; i += 2) {
      assert.equal(order[i], order[i + 1], '同 key 不得交错');
    }
  });

  it('不同 key 并行执行（不互相等待）', async () => {
    const m = new KeyedMutex();
    let concurrent = 0;
    let peak = 0;
    const gate = () =>
      new Promise<void>((r) => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        setTimeout(() => {
          concurrent--;
          r();
        }, 20);
      });
    await Promise.all([
      m.withLock('a', gate),
      m.withLock('b', gate),
      m.withLock('c', gate),
    ]);
    assert.ok(peak >= 2, '不同 key 应并行执行');
  });

  it('fn 抛错不污染链，后续调用仍可执行', async () => {
    const m = new KeyedMutex();
    await assert.rejects(() => m.withLock('k', async () => { throw new Error('boom'); }));
    const v = await m.withLock('k', async () => 42);
    assert.equal(v, 42);
  });

  it('批量并行调用后无锁泄漏', async () => {
    const m = new KeyedMutex();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => m.withLock(`key-${i % 5}`, async () => i)),
    );
    assert.equal(m.pending, 0, '所有 key 的锁应全部释放');
  });

  it('支持全局 key（*）作互斥锁', async () => {
    const m = new KeyedMutex();
    const order: number[] = [];
    await Promise.all([
      m.withLock('*', async () => { order.push(1); await tick(); order.push(1); }),
      m.withLock('*', async () => { order.push(2); await tick(); order.push(2); }),
    ]);
    assert.deepEqual(order, [1, 1, 2, 2]);
  });
});
