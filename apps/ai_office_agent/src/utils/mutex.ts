/**
 * apps/ai_office_agent/src/utils/mutex.ts
 *
 * 按 key 的互斥锁:同一文件的并发「读-改-写」整文件操作串行化。
 * Office 原地修改(excel_update / word_write 覆盖)是整文件替换,
 * 并发写同一文件会互相覆盖,因此需要 per-file 锁。
 */
const queues = new Map<string, Promise<unknown>>();

export async function withFileLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  queues.set(key, next.catch(() => {}));
  try {
    return await next;
  } finally {
    // 仅当仍是最新任务时清理,避免误删后续排队的任务
    if (queues.get(key) === next) queues.delete(key);
  }
}
