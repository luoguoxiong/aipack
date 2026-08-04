/**
 * Safety guard 单测 - 覆盖熔断器状态机、配对验证、AbortController
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CompressionSafetyGuard,
  createSafetyState,
  abortSafetyState,
  buildToolPairMap,
  isToolPairComplete,
} from '../src/safety';
import type { ContextResource } from 'agentpack';

function makeResource(
  id: string,
  type: ContextResource['type'],
  deps: string[] = [],
): ContextResource {
  return {
    id,
    type,
    role: 'system',
    content: '',
    timestamp: 0,
    dependencies: deps,
    meta: {},
    pinned: false,
  };
}

test('canCompress: 跨 turn 重置 attemptCount', () => {
  const guard = new CompressionSafetyGuard({ maxAttempts: 2, cooldownTurns: 5 });
  const state = createSafetyState({ forkTimeoutMs: 0 });

  // turn 1: 允许压缩，累积 2 次后熔断
  assert.equal(guard.canCompress(state, 1), true);
  guard.recordAttempt(state);
  assert.equal(guard.canCompress(state, 1), true);
  guard.recordAttempt(state);
  // 第 3 次应被熔断
  assert.equal(guard.canCompress(state, 1), false);
  assert.equal(state.circuitBreakerTripped, true);
  assert.equal(state.cooldownRemaining, 5);

  // turn 1 内继续调用：仍在冷却，递减
  assert.equal(guard.canCompress(state, 1), false);
  assert.equal(state.cooldownRemaining, 4);

  // turn 2: 跨 turn 不会自动重置（因为有 cooldown）；继续冷却
  assert.equal(guard.canCompress(state, 2), false);
});

test('canCompress: cooldown 耗尽后恢复', () => {
  const guard = new CompressionSafetyGuard({ maxAttempts: 1, cooldownTurns: 2 });
  const state = createSafetyState({ forkTimeoutMs: 0 });

  // turn 1: 1 次即熔断
  assert.equal(guard.canCompress(state, 1), true);
  guard.recordAttempt(state);
  assert.equal(guard.canCompress(state, 1), false);
  assert.equal(state.circuitBreakerTripped, true);
  assert.equal(state.cooldownRemaining, 2);

  // 模拟跨 turn 调用，每次 cooldown 递减
  guard.canCompress(state, 2); // cooldown 2->1
  guard.canCompress(state, 3); // cooldown 1->0，但仍返回 false（在递减分支）
  // 下一次：cooldown 已为 0，应解除熔断
  assert.equal(guard.canCompress(state, 4), true);
  assert.equal(state.circuitBreakerTripped, false);
});

test('canCompress: handoffCompleted 后永远拒绝', () => {
  const guard = new CompressionSafetyGuard({ maxAttempts: 10, cooldownTurns: 1 });
  const state = createSafetyState({ forkTimeoutMs: 0 });
  state.handoffCompleted = true;
  assert.equal(guard.canCompress(state, 1), false);
  assert.equal(guard.canCompress(state, 2), false);
});

test('createSafetyState: forkTimeoutMs > 0 时创建 AbortController', () => {
  const state = createSafetyState({ forkTimeoutMs: 100 });
  assert.ok(state.abortController, 'abortController 应被创建');
  assert.equal(state.abortController?.signal.aborted, false);
  // 等待超时触发
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(state.abortController?.signal.aborted, true, '超时后应 abort');
      resolve();
    }, 150);
  });
});

test('createSafetyState: forkTimeoutMs=0 仍创建 AbortController（但不设超时）', () => {
  const state = createSafetyState({ forkTimeoutMs: 0 });
  // forkTimeoutMs=0 表示不自动超时，但 AbortController 仍存在（可主动 abort）
  assert.ok(state.abortController, 'abortController 应被创建（用于主动 abort）');
  assert.equal(state.abortController?.signal.aborted, false);

  // 验证不会自动 abort：等待一段时间后仍未 aborted
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(state.abortController?.signal.aborted, false, 'forkTimeoutMs=0 时不应自动 abort');
      resolve();
    }, 50);
  });
});

test('abortSafetyState: 主动 abort', () => {
  const state = createSafetyState({ forkTimeoutMs: 1000 });
  abortSafetyState(state);
  assert.equal(state.abortController?.signal.aborted, true);
});

test('validateToolPairing: 完整配对通过', () => {
  const guard = new CompressionSafetyGuard({ maxAttempts: 5, cooldownTurns: 1 });
  const resources = [
    makeResource('a1', 'assistant_message', ['call_1']),
    makeResource('tr1', 'tool_result', ['call_1']),
  ];
  assert.equal(guard.validateToolPairing(resources), true);
});

test('validateToolPairing: 悬空 tool_result 失败', () => {
  const guard = new CompressionSafetyGuard({ maxAttempts: 5, cooldownTurns: 1 });
  const resources = [
    makeResource('a1', 'assistant_message', ['call_other']),
    makeResource('tr1', 'tool_result', ['call_1']), // 没有对应 assistant_message
  ];
  assert.equal(guard.validateToolPairing(resources), false);
});

test('validateToolPairing: tool_call 类型资源也能匹配', () => {
  const guard = new CompressionSafetyGuard({ maxAttempts: 5, cooldownTurns: 1 });
  const resources = [
    makeResource('tc1', 'tool_call', ['call_1']),
    makeResource('tr1', 'tool_result', ['call_1']),
  ];
  assert.equal(guard.validateToolPairing(resources), true);
});

test('validateToolPairing: 无 tool_result 时通过', () => {
  const guard = new CompressionSafetyGuard({ maxAttempts: 5, cooldownTurns: 1 });
  const resources = [
    makeResource('u1', 'user_message'),
    makeResource('a1', 'assistant_message'),
  ];
  assert.equal(guard.validateToolPairing(resources), true);
});

test('buildToolPairMap + isToolPairComplete: 完整对返回 true', () => {
  const resources = [
    makeResource('a1', 'assistant_message', ['call_1']),
    makeResource('tr1', 'tool_result', ['call_1']),
  ];
  const map = buildToolPairMap(resources);
  assert.equal(isToolPairComplete(resources[0], resources, map), true);
  assert.equal(isToolPairComplete(resources[1], resources, map), true);
});

test('isToolPairComplete: assistant_message 无对应 tool_result 返回 false', () => {
  const resources = [
    makeResource('a1', 'assistant_message', ['call_1']),
  ];
  const map = buildToolPairMap(resources);
  assert.equal(isToolPairComplete(resources[0], resources, map), false);
});
