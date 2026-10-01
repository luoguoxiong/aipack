/**
 * packages/eval/src/core/judge-llm.ts - judge 模型装配（M5）
 *
 * 把 StreamFn + 框架 Model 装配成 llm-judge 需要的 complete(prompt)。
 * 与 runner 的 live 装配对称：judge 模型也走 createLiveLlm / 注入 StreamFn，
 * 单次非流式调用（内部仍消费事件流，聚合 text delta）。
 */

import type { Model, StreamFn } from '@aipack-ai/agent';
import type { JudgeDeps } from './scorer';

/** 单条消息 → complete(prompt) 的适配（temperature 0，judge 要确定性） */
export function createCompleteFromStreamFn(
  streamFn: StreamFn,
  model: Model | undefined,
): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    const context = {
      systemPrompt: '',
      messages: [{ role: 'user' as const, content: prompt, timestamp: Date.now() }],
    };
    let text = '';
    const result = streamFn(model as Model, context);
    for await (const event of result) {
      if (event.type === 'text_delta') text += event.delta;
      else if (event.type === 'done') {
        // 兜底：done 消息里的 text（个别 provider 不发 text_delta）
        if (!text) {
          const content = event.message.content;
          if (typeof content === 'string') text = content;
          else for (const block of content) if (block.type === 'text') text += block.text;
        }
        break;
      } else if (event.type === 'error') {
        throw new Error('judge 流式调用错误');
      }
    }
    return text;
  };
}

/** JudgeDeps 快捷装配 */
export function createJudgeDeps(
  streamFn: StreamFn,
  model: Model | undefined,
  modelLabel?: string,
): JudgeDeps {
  return {
    complete: createCompleteFromStreamFn(streamFn, model),
    ...(modelLabel ? { modelLabel } : {}),
  };
}
