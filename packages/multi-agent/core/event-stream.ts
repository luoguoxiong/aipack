/**
 * core/event-stream.ts - 流式事件队列工具
 *
 * 统一各执行器 stream() 的 push-pull 事件队列实现：
 * 后台执行图逻辑，事件按发生顺序产出给消费者，
 * 同时同步分发到外部事件监听（on() API 的 eventSink）。
 */

import type { MultiAgentEvent } from './types';

/**
 * 创建流式事件生成器。
 *
 * @param execute - 后台执行函数，通过 emit 发出事件；
 *   返回的 Promise 决不 reject（错误应转换为 graph_error 事件后 resolve）
 * @param sink - 外部事件监听（可选），异常会被吞掉以防中断事件传播
 */
export function createEventStream(
  execute: (emit: (event: MultiAgentEvent) => void) => Promise<void>,
  sink?: (event: MultiAgentEvent) => void,
): AsyncGenerator<MultiAgentEvent> {
  const eventQueue: MultiAgentEvent[] = [];
  let resolveEvent: (() => void) | null = null;
  let done = false;

  const emit = (event: MultiAgentEvent) => {
    eventQueue.push(event);
    if (sink) {
      try { sink(event); } catch { /* 防止监听器异常中断事件传播 */ }
    }
    resolveEvent?.();
  };

  const graphPromise = execute(emit).finally(() => {
    done = true;
    resolveEvent?.();
  });

  return (async function* (): AsyncGenerator<MultiAgentEvent> {
    while (!done || eventQueue.length > 0) {
      if (eventQueue.length > 0) {
        yield eventQueue.shift()!;
      } else {
        await new Promise<void>(resolve => { resolveEvent = resolve; });
      }
    }
    await graphPromise;
  })();
}

/** 将执行 Promise 的成功/失败转换为事件（供 createEventStream 的 execute 使用） */
export function settleAsEvent(
  promise: Promise<unknown>,
  emit: (event: MultiAgentEvent) => void,
  onError?: (errorMsg: string) => void,
): Promise<void> {
  return promise.then(
    () => { /* 成功事件由调用方在 promise 内部发出 */ },
    (err) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      onError?.(errorMsg);
      emit({ type: 'graph_error', error: errorMsg });
    },
  );
}
