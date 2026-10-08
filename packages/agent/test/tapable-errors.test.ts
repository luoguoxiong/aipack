/**
 * tapable 抛错路径测试（修复"系统性吞异常"后补齐）：
 * - 默认策略（'log'）：单个 tap 抛错不影响其他 tap，但 console.warn 可观测
 * - 'silent'：完全静默（旧行为）
 * - 'throw'：中断并向上抛出
 * - setTapErrorHandler：错误信息转发（hook/tap/error）；处理器自身失败不扩散
 * - 集成：扩展钩子抛错 → run 正常完成 + telemetry.onHookError 上报
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  SyncHook,
  AsyncSeriesHook,
  AsyncSeriesWaterfallHook,
  setTapFailurePolicy,
  setTapErrorHandler,
} from '../core/tapable';
import { createRuntime, createRequest } from '../index.ts';
import type { StreamFn, StreamEvent, AssistantMessage, Telemetry } from '../core/index.ts';

// 每个用例后恢复默认全局状态，避免污染其他测试
afterEach(() => {
  setTapFailurePolicy('log');
  setTapErrorHandler(undefined);
});

describe('SyncHook 抛错路径', () => {
  it('默认策略：抛错 tap 不影响后续 tap', () => {
    const hook = new SyncHook<[number]>();
    const calls: number[] = [];
    hook.tap('bad', () => { throw new Error('boom'); });
    hook.tap('good', (n: number) => { calls.push(n); });

    hook.call(42);
    assert.deepEqual(calls, [42]); // 后续 tap 仍执行
  });

  it('silent 策略：完全静默', () => {
    setTapFailurePolicy('silent');
    const hook = new SyncHook();
    hook.tap('bad', () => { throw new Error('boom'); });
    // 不抛即通过（旧行为：吞掉继续）
    hook.call();
  });

  it('throw 策略：中断并向上抛出', () => {
    setTapFailurePolicy('throw');
    const hook = new SyncHook();
    const calls: string[] = [];
    hook.tap('bad', () => { throw new Error('boom'); });
    hook.tap('never', () => { calls.push('never'); });

    assert.throws(() => hook.call(), /boom/);
    assert.deepEqual(calls, []); // 后续 tap 未执行
  });
});

describe('AsyncSeriesHook 抛错路径', () => {
  it('默认策略：抛错 tap 不影响后续 tap', async () => {
    const hook = new AsyncSeriesHook<[string]>();
    const calls: string[] = [];
    hook.tapPromise('bad', async () => { throw new Error('boom'); });
    hook.tapPromise('good', async (s: string) => { calls.push(s); });

    await hook.promise('x');
    assert.deepEqual(calls, ['x']);
  });

  it('throw 策略：中断并向上抛出', async () => {
    setTapFailurePolicy('throw');
    const hook = new AsyncSeriesHook();
    const calls: string[] = [];
    hook.tapPromise('bad', async () => { throw new Error('boom'); });
    hook.tapPromise('never', async () => { calls.push('never'); });

    await assert.rejects(() => hook.promise(), /boom/);
    assert.deepEqual(calls, []);
  });
});

describe('AsyncSeriesWaterfallHook 抛错路径', () => {
  it('默认策略：抛错保持当前值继续', async () => {
    const hook = new AsyncSeriesWaterfallHook<number>();
    hook.tapPromise('bad', async (v: number) => { throw new Error('boom'); });
    hook.tapPromise('next', async (v: number) => v * 2);

    const result = await hook.promise(21);
    assert.equal(result, 42); // 失败 tap 跳过后，后续 tap 基于当前值继续
  });

  it('throw 策略：中断并向上抛出', async () => {
    setTapFailurePolicy('throw');
    const hook = new AsyncSeriesWaterfallHook<number>();
    hook.tapPromise('bad', async () => { throw new Error('boom'); });

    await assert.rejects(() => hook.promise(1), /boom/);
  });
});

describe('setTapErrorHandler', () => {
  it('收到 hook / tap / error 信息', () => {
    const seen: Array<{ hook: string; tap: string; error: unknown }> = [];
    setTapErrorHandler(info => seen.push(info));

    const hook = new SyncHook('myHook');
    const boom = new Error('boom');
    hook.tap('bad', () => { throw boom; });
    hook.call();

    assert.equal(seen.length, 1);
    assert.equal(seen[0].hook, 'myHook');
    assert.equal(seen[0].tap, 'bad');
    assert.equal(seen[0].error, boom);
  });

  it('处理器自身抛错不影响主流程（防递归）', () => {
    setTapErrorHandler(() => { throw new Error('handler boom'); });
    const hook = new SyncHook();
    const calls: string[] = [];
    hook.tap('ok', () => { calls.push('ok'); });

    hook.call(); // 不抛
    assert.deepEqual(calls, ['ok']);
  });
});

describe('集成：扩展 tap 抛错 + 遥测上报', () => {
  it('tap 抛错时 run 正常完成，onHookError 收到事件', async () => {
    const hookErrors: Array<{ hook: string; tap: string }> = [];
    const telemetry: Telemetry = {
      onHookError(info) {
        hookErrors.push({ hook: info.hook, tap: info.tap });
      },
    };

    const streamFn: StreamFn = async function* (): AsyncGenerator<StreamEvent> {
      yield {
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          stopReason: 'stop',
          usage: { input: 1, output: 1, total: 2 },
          timestamp: Date.now(),
        } as AssistantMessage,
      };
    };

    const runtime = createRuntime({ streamFn, telemetry });
    runtime.hooks.beforeInitialize.tapPromise('bad-ext', async () => {
      throw new Error('extension boom');
    });

    const result = await runtime.run(createRequest('hi'));
    // tap 抛错不影响主流程：run 正常完成
    assert.equal(result.success, true);
    assert.equal(result.content, 'ok');
    // 但不再无声吞掉：onHookError 上报
    assert.ok(
      hookErrors.some(e => e.hook === 'beforeInitialize' && e.tap === 'bad-ext'),
      `应收到 beforeInitialize/bad-ext 事件，实际: ${JSON.stringify(hookErrors)}`,
    );
    await runtime.close();
  });
});
