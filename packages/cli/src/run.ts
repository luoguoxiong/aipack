/**
 * packages/cli/src/run.ts
 *
 * 一次性提问：流式输出回复，返回最终文本。
 */

import { createRequest } from '@aipack-ai/agent';
import type { AssistantMessage, AiModel } from '@aipack-ai/agent';
import type { AipackConfig } from './config';
import { createAipackRuntime } from './runtime';

export interface RunResult {
  content: string;
  error?: string;
}

export async function runOnce(
  message: string,
  config: AipackConfig,
  model?: AiModel,
): Promise<RunResult> {
  const runtime = createAipackRuntime(config, model);

  try {
    let finalText = '';
    let error: string | undefined;
    let thinkingActive = false;
    let hasOutput = false;

    for await (const chunk of runtime.stream(
      createRequest(message, { channel: 'cli', sessionKey: config.sessionKey }),
    )) {
      switch (chunk.type) {
        case 'thinking':
          if (chunk.content) {
            hasOutput = true;
            if (!thinkingActive) {
              thinkingActive = true;
              process.stdout.write('\x1b[90mthink: ');
            }
            process.stdout.write(chunk.content);
          }
          break;
        case 'text':
          hasOutput = true;
          if (thinkingActive) {
            thinkingActive = false;
            process.stdout.write('\x1b[0m\n');
          }
          process.stdout.write(chunk.content ?? '');
          finalText += chunk.content ?? '';
          break;
        case 'tool_start':
          hasOutput = true;
          if (thinkingActive) {
            thinkingActive = false;
            process.stdout.write('\x1b[0m\n');
          }
          console.log(`\n🔧 正在运行：${chunk.toolName}`);
          break;
        case 'tool_end':
          if (chunk.isError) console.log(`\n❌ ${chunk.toolName} 失败`);
          else console.log(`\n✅ ${chunk.toolName} 完成`);
          break;
        case 'error':
          hasOutput = true;
          error = chunk.content;
          console.error(`\n❌ 错误：${chunk.content || '未知错误'}`);
          break;
        case 'done':
          if (thinkingActive) {
            thinkingActive = false;
            process.stdout.write('\x1b[0m\n');
          }
          break;
      }
    }

    if (thinkingActive) process.stdout.write('\x1b[0m\n');

    // LLM 层错误（如 API Key 无效）不会以 chunk 形式抛出，
    // 从最后一条 assistant 消息的 errorMessage 兜底捕获
    const messages = runtime.getMessages(config.sessionKey);
    const last = messages[messages.length - 1];
    if (!error && last?.role === 'assistant' && (last as AssistantMessage).errorMessage) {
      error = (last as AssistantMessage).errorMessage;
      console.error(`\n❌ 错误：${error}`);
    }

    if (!hasOutput && !error) console.log('\n（未收到响应）');
    console.log('');

    return { content: finalText, error };
  } finally {
    await runtime.close();
  }
}
