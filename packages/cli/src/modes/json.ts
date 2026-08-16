/**
 * json 模式（--mode json）：全部流式事件以 JSON 行输出（stdout）。
 */
import type { Runtime, ResultChunk } from '@aipack-ai/agent';

export async function runJsonMode(
  runtime: Runtime,
  request: Parameters<Runtime['run']>[0],
): Promise<void> {
  let sawError = false;
  try {
    for await (const chunk of runtime.stream(request) as AsyncGenerator<ResultChunk>) {
      if (chunk.type === 'error') sawError = true;
      const line = JSON.stringify({
        type: chunk.type,
        content: chunk.content,
        toolName: chunk.toolName,
        toolCallId: chunk.toolCallId,
        isError: chunk.isError,
        // done 类型：透出最终 Result 摘要（usage / stopReason / toolsUsed）供程序消费
        usage: chunk.result?.usage,
        stopReason: chunk.result?.stopReason,
        toolsUsed: chunk.result?.toolsUsed,
        timestamp: Date.now(),
      });
      process.stdout.write(`${line}\n`);
    }
    if (sawError) process.exitCode = 1;
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      type: 'error',
      content: err instanceof Error ? err.message : String(err),
      timestamp: Date.now(),
    })}\n`);
    process.exitCode = 1;
  }
}
