/**
 * Fork 重试机制单测 - 覆盖 P0#4 修复
 *  - isRetryableStreamError: 429/5xx 可重试、4xx/AbortError 不可重试
 *  - computeBackoffDelay: 指数退避 + maxMs 封顶
 *  - retryWithBackoff: 可重试错误重试成功、不可重试立即抛、重试耗尽抛错
 *  - runForkWithRetry: 返回 ForkResult（ok/retries/durationMs/usage）、session abort 立即返回
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ForkStreamError,
  isRetryableStreamError,
  computeBackoffDelay,
  retryWithBackoff,
  runForkWithRetry,
  DEFAULT_FORK_RETRY,
} from '../src/retry';
import { createSafetyState, abortSafetyState } from '../src/safety';

// ─── isRetryableStreamError ───────────────────────────────────────

test('isRetryableStreamError: 429 可重试', () => {
  assert.equal(isRetryableStreamError(new ForkStreamError('rate_limit', true, 429)), true);
});

test('isRetryableStreamError: 5xx 可重试', () => {
  assert.equal(isRetryableStreamError(new ForkStreamError('upstream', true, 502)), true);
});

test('isRetryableStreamError: 4xx 不可重试', () => {
  assert.equal(isRetryableStreamError(new ForkStreamError('bad_request', true, 400)), false);
});

test('isRetryableStreamError: retryable=false 不可重试', () => {
  assert.equal(isRetryableStreamError(new ForkStreamError('context_length_exceeded', false, 400)), false);
});

test('isRetryableStreamError: AbortError 不可重试', () => {
  const err = new Error('aborted');
  err.name = 'AbortError';
  assert.equal(isRetryableStreamError(err), false);
});

// ─── computeBackoffDelay ──────────────────────────────────────────

test('computeBackoffDelay: 指数退避增长', () => {
  const config = { retries: 3, baseMs: 100, maxMs: 1000 };
  const d1 = computeBackoffDelay(0, config);
  const d2 = computeBackoffDelay(1, config);
  const d3 = computeBackoffDelay(2, config);
  // 指数退避：100 → 200 → 400（±30% jitter）
  assert.ok(d1 >= 70 && d1 <= 130, `attempt0 应为 ~100，实际 ${d1}`);
  assert.ok(d2 >= 140 && d2 <= 260, `attempt1 应为 ~200，实际 ${d2}`);
  assert.ok(d3 >= 280 && d3 <= 520, `attempt2 应为 ~400，实际 ${d3}`);
});

test('computeBackoffDelay: maxMs 封顶', () => {
  const config = { retries: 5, baseMs: 100, maxMs: 300 };
  const d = computeBackoffDelay(10, config); // 理论上 100*2^10 远超 300
  assert.ok(d >= 210 && d <= 390, `应封顶在 ~300，实际 ${d}`);
});

// ─── retryWithBackoff ─────────────────────────────────────────────

test('retryWithBackoff: 瞬时错误重试后成功', async () => {
  let calls = 0;
  const result = await retryWithBackoff(
    async () => {
      calls++;
      if (calls < 3) throw new ForkStreamError('boom', true, 503);
      return 'ok';
    },
    { retries: 3, baseMs: 5, maxMs: 20 },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3, '前两次失败后第三次成功');
});

test('retryWithBackoff: 重试耗尽后抛出最后一次错误', async () => {
  await assert.rejects(
    retryWithBackoff(
      async () => { throw new ForkStreamError('persistent', true, 503); },
      { retries: 2, baseMs: 5, maxMs: 20 },
    ),
    /persistent/,
  );
});

test('retryWithBackoff: 不可重试错误立即抛出（不重试）', async () => {
  let calls = 0;
  await assert.rejects(
    retryWithBackoff(
      async () => {
        calls++;
        throw new ForkStreamError('bad_request', false, 400);
      },
      { retries: 3, baseMs: 5, maxMs: 20 },
    ),
    /bad_request/,
  );
  assert.equal(calls, 1, '不可重试错误不应重试');
});

test('retryWithBackoff: onRetry 回调收到 attempt 信息', async () => {
  let calls = 0;
  const attempts: number[] = [];
  await retryWithBackoff(
    async () => {
      calls++;
      if (calls < 3) throw new Error('boom');
      return 'ok';
    },
    { retries: 3, baseMs: 5, maxMs: 20 },
    (_err, attempt) => { attempts.push(attempt); },
  );
  assert.deepEqual(attempts, [1, 2], '应记录两次重试');
});

// ─── runForkWithRetry ─────────────────────────────────────────────

test('runForkWithRetry: 成功时返回 ok/value/usage', async () => {
  const state = createSafetyState({ forkTimeoutMs: 0 });
  const result = await runForkWithRetry(
    state,
    5000,
    DEFAULT_FORK_RETRY,
    async () => ({ value: 'hello', usage: { input: 10, output: 5, total: 15 } }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.value, 'hello');
  assert.deepEqual(result.usage, { input: 10, output: 5, total: 15 });
  assert.equal(result.retries, 0);
  assert.ok(result.durationMs >= 0);
});

test('runForkWithRetry: 失败时返回 ok=false', async () => {
  const state = createSafetyState({ forkTimeoutMs: 0 });
  const result = await runForkWithRetry(
    state,
    5000,
    { ...DEFAULT_FORK_RETRY, retries: 1, baseMs: 5, maxMs: 20 },
    async () => { throw new ForkStreamError('boom', true, 503); },
  );
  assert.equal(result.ok, false);
  assert.equal(result.value, null);
  assert.equal(result.retries, 1);
});

test('runForkWithRetry: session abort 后立即返回 ok=false', async () => {
  const state = createSafetyState({ forkTimeoutMs: 0 });
  abortSafetyState(state);
  const result = await runForkWithRetry(
    state,
    5000,
    DEFAULT_FORK_RETRY,
    async () => { throw new Error('不应被调用'); },
  );
  assert.equal(result.ok, false);
  assert.equal(result.durationMs, 0);
});

test('runForkWithRetry: 重试时每次创建新 signal（inFlightForks 归零）', async () => {
  const state = createSafetyState({ forkTimeoutMs: 0 });
  let calls = 0;
  const result = await runForkWithRetry(
    state,
    5000,
    { ...DEFAULT_FORK_RETRY, retries: 1, baseMs: 5, maxMs: 20 },
    async () => {
      calls++;
      if (calls === 1) throw new ForkStreamError('boom', true, 503);
      return { value: 'recovered' };
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.value, 'recovered');
  assert.equal(result.retries, 1);
  assert.equal(state.inFlightForks, 0, '所有 fork 结束后 inFlightForks 应归零');
});
