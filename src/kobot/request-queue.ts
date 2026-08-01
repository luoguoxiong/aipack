/**
 * 按 sessionKey 串行化请求，保证同一会话不并发执行。
 */
export class RequestQueue {
  private queues = new Map<string, Promise<void>>();

  /**
   * 获取队列锁，返回等待函数与释放函数。
   * 适用于需要手动控制锁生命周期的场景（如 async generator）。
   */
  acquire(sessionKey: string): { wait: Promise<void>; release: () => void } {
    const prevQueue = this.queues.get(sessionKey) ?? Promise.resolve();
    let release!: () => void;
    const currentQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(sessionKey, prevQueue.then(() => currentQueue));

    return { wait: prevQueue, release };
  }

  /**
   * 将异步任务排入指定会话的串行队列。
   * 适用于普通 async 函数。
   */
  async enqueue<T>(sessionKey: string, fn: () => Promise<T>): Promise<T> {
    const { wait, release } = this.acquire(sessionKey);

    try {
      await wait;
    } catch {
      // 前一个请求的错误不影响当前请求
    }

    try {
      return await fn();
    } finally {
      release();
    }
  }

  clear(sessionKey?: string): void {
    if (sessionKey) {
      this.queues.delete(sessionKey);
    } else {
      this.queues.clear();
    }
  }
}
