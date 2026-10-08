#!/usr/bin/env node
/**
 * bin 入口：仅作为可执行程序运行（dist/bin.js），
 * 无条件调用 main，不依赖 argv 检测，避免代码分割/符号链接下入口判断失效。
 * 库使用者经 index.js 导入 main，不会触发本文件。
 */
import { main } from './cli.js';

// 管道下游提前退出（如 `aipack -p ... | head`）触发 EPIPE：
// 静默退出而非打印"致命错误"栈（输出被截断是用户的预期行为）
process.stdout?.on?.('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') {
    process.exit(0);
  }
  throw err;
});
process.stderr?.on?.('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') {
    process.exit(0);
  }
  throw err;
});

main(process.argv.slice(2))
  .then(code => process.exit(code))
  .catch(err => {
    // chalk 延迟引入，避免 bin 启动即加载
    import('chalk')
      .then(({ default: chalk }) => {
        console.error(chalk.red(`致命错误: ${err instanceof Error ? err.stack ?? err.message : String(err)}`));
        process.exit(1);
      })
      .catch(() => {
        console.error(`致命错误: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        process.exit(1);
      });
  });
