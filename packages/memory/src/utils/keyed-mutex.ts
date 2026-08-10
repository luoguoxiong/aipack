/**
 * 零依赖 keyed mutex（promise 链实现）。
 *
 * 用于串行化同一 key 上的 read-modify-write 操作（如 FileMemoryStore 的同 id 更新），
 * 以及全局写锁（consolidate / prune 与 save 互斥）。
 * 任一批量 fn 抛错不会污染链，后续调用者不受影响。
 */

export class KeyedMutex {
  /** key -> 当前链尾 promise */
  private tails = new Map<string, Promise<void>>();

  /**
   * 在 key 上串行执行 fn：同一 key 的并发调用按调用顺序排队，逐个执行。
   * 不同 key 之间互不阻塞（`withLock('*', ...)` 可作全局锁）。
   */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => gate);
    this.tails.set(key, tail);

    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        release();
        // 若链尾仍是我们这条，清掉避免 Map 泄漏
        if (this.tails.get(key) === tail) {
          this.tails.delete(key);
        }
      }
    });
  }

  /** 当前持锁 key 数量（调试用） */
  get pending(): number {
    return this.tails.size;
  }
}

/** 全局共享实例（各 store 复用；互不冲突） */
export const globalMutex = new KeyedMutex();
