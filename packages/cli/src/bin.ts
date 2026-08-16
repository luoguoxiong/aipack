#!/usr/bin/env node
/**
 * bin 入口：仅作为可执行程序运行（dist/bin.js），
 * 无条件调用 main，不依赖 argv 检测，避免代码分割/符号链接下入口判断失效。
 * 库使用者经 index.js 导入 main，不会触发本文件。
 */
import { main } from './cli.js';

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
