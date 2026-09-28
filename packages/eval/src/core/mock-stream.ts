/**
 * packages/eval/src/core/mock-stream.ts - Mock StreamFn（fixture replay）
 *
 * 通过 RuntimeOptions.streamFn 注入脚本化的 LLM 响应，零改动 Runtime。
 * 每次 streamFn 调用消费 MockScript.turns 中的一条；轮次耗尽后按
 * fallbackText / infiniteTool 兜底。
 */

import type {
  AssistantMessage,
  ContentBlock,
  StreamFn,
} from '@aipack-ai/agent';
import type { MockScript } from './types';

const DEFAULT_USAGE = { input: 10, output: 5, total: 15 };

/** 把脚本轮次转成框架层 AssistantMessage */
function buildTurnMessage(
  turn: {
    toolCalls?: Array<{ id?: string; name: string; args?: Record<string, unknown> }>;
    text?: string;
    stopReason?: string;
    usage?: { input?: number; output?: number; total?: number };
  },
  idBase: number,
): AssistantMessage {
  const content: ContentBlock[] = [];

  if (turn.text) content.push({ type: 'text', text: turn.text });
  for (const [i, tc] of (turn.toolCalls ?? []).entries()) {
    content.push({
      type: 'toolCall',
      id: tc.id ?? `mock_tc_${idBase}_${i + 1}`,
      name: tc.name,
      arguments: tc.args ?? {},
    });
  }

  const hasToolCalls = (turn.toolCalls ?? []).length > 0;
  return {
    role: 'assistant',
    content,
    stopReason: turn.stopReason ?? (hasToolCalls ? 'toolUse' : 'stop'),
    usage: {
      input: turn.usage?.input ?? DEFAULT_USAGE.input,
      output: turn.usage?.output ?? DEFAULT_USAGE.output,
      total: turn.usage?.total ?? DEFAULT_USAGE.total,
    },
    timestamp: Date.now(),
  };
}

/**
 * 创建脚本式 StreamFn：第 n 次调用返回第 n 轮脚本。
 *
 * - 轮次耗尽且未配置 infiniteTool：返回 stopReason 'stop' 的兜底文本轮
 * - 配置 infiniteTool：持续返回该工具调用（模拟死循环，配合 maxTurns 断言）
 */
export function createMockStreamFn(script: MockScript): StreamFn {
  let callIndex = 0;
  return async function* () {
    // 每次调用让出一次事件循环（模拟网络延迟）：
    // 保证墙钟超时 / 并发调度有执行机会，行为更接近真实 provider
    await new Promise<void>((resolve) => setImmediate(resolve));
    const turn = script.turns[callIndex];
    if (turn) {
      callIndex += 1;
      yield { type: 'done' as const, message: buildTurnMessage(turn, callIndex) };
      return;
    }
    if (script.infiniteTool) {
      callIndex += 1;
      yield {
        type: 'done' as const,
        message: buildTurnMessage(
          {
            toolCalls: [
              { name: script.infiniteTool, args: script.infiniteToolArgs ?? {} },
            ],
          },
          callIndex,
        ),
      };
      return;
    }
    yield {
      type: 'done' as const,
      message: buildTurnMessage({ text: script.fallbackText ?? 'done' }, callIndex + 1),
    };
  };
}
