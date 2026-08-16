/**
 * print 模式（-p）：非交互，处理一次提示后退出。
 * 文本回复写 stdout（可管道），工具/状态信息写 stderr。
 */
import type { Runtime, ResultChunk } from '@aipack-ai/agent';
import chalk from 'chalk';
import { ChunkRenderer } from './render.js';

export async function runPrintMode(
  runtime: Runtime,
  request: Parameters<Runtime['run']>[0],
): Promise<void> {
  const renderer = new ChunkRenderer({ toolStream: process.stderr });
  let error: string | undefined;

  try {
    for await (const chunk of runtime.stream(request) as AsyncGenerator<ResultChunk>) {
      if (chunk.type === 'error') error = chunk.content;
      renderer.render(chunk);
    }
  } catch (err) {
    process.stderr.write(chalk.red(`错误: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
    return;
  }

  if (error) process.exitCode = 1;
}
