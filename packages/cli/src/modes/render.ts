/**
 * 流式 chunk 的终端渲染（interactive / print 共用）
 */
import chalk from 'chalk';
import type { ResultChunk } from '@aipack-ai/agent';

export interface RenderOptions {
  /** 显示思考过程（默认折叠为省略提示） */
  showThinking?: boolean;
  /** 输出目标（默认 stdout；print 模式工具信息走 stderr 保持 stdout 纯文本） */
  toolStream?: NodeJS.WriteStream;
}

export class ChunkRenderer {
  private thinkingShown = false;
  private inTool = false;

  constructor(private opts: RenderOptions = {}) {}

  render(chunk: ResultChunk): void {
    const err = this.opts.toolStream ?? process.stdout;
    switch (chunk.type) {
      case 'text':
        if (chunk.content) process.stdout.write(chunk.content);
        break;

      case 'thinking': {
        if (this.opts.showThinking && chunk.content) {
          process.stdout.write(chalk.dim(chunk.content));
        } else if (!this.thinkingShown) {
          this.thinkingShown = true;
          err.write(chalk.dim('  (思考中...)\n'));
        }
        break;
      }

      case 'tool_start':
        this.inTool = true;
        err.write(chalk.cyan(`\n⚙ ${chunk.toolName} `));
        break;

      case 'tool_end':
        if (this.inTool) {
          err.write(chunk.isError ? chalk.red(' ✗\n') : chalk.green(' ✓\n'));
          this.inTool = false;
        }
        break;

      case 'error':
        err.write(chalk.red(`\n错误: ${chunk.content ?? '未知错误'}\n`));
        break;

      case 'done':
        process.stdout.write('\n');
        break;
    }
  }

  reset(): void {
    this.thinkingShown = false;
    this.inTool = false;
  }
}
