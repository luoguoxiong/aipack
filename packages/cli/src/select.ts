/**
 * 原生终端选择器（无第三方依赖）
 *
 * 渲染：
 *   ? 问题文本
 *   ❯ 选项一
 *     选项二
 *
 * 按键：↑/↓ 或 j/k 移动，1-9 直选，回车确认，Esc/q/Ctrl+C 取消。
 * 仅在 TTY 下可用；结束时恢复 raw mode 原状并清掉选项区、保留结果摘要。
 */
import chalk from 'chalk';

export interface SelectOption<T extends string = string> {
  label: string;
  value: T;
}

export async function select<T extends string = string>(
  question: string,
  options: SelectOption<T>[],
  defaultIndex = 0,
): Promise<T | null> {
  const stdin = process.stdin;
  const out = process.stdout;
  if (!stdin.isTTY || options.length === 0) return null;

  return new Promise<T | null>(resolve => {
    let selected = Math.min(Math.max(defaultIndex, 0), options.length - 1);

    const prevRaw = stdin.isRaw ?? false;
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();

    /** 光标约定：每次 render 前光标位于选项区首行行首 */
    function render(): void {
      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const line = i === selected
          ? `${chalk.cyan('❯ ')}${chalk.bold(opt.label)}`
          : `  ${opt.label}`;
        out.write(`\x1b[2K\r${line}\n`);
      }
      out.write(`\x1b[${options.length}A`);
    }

    function finish(value: T | null): void {
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(prevRaw); } catch { /* 进程退出竞态可忽略 */ }
      if (!prevRaw) stdin.pause();

      // 清除选项区，写一行结果摘要
      for (let i = 0; i < options.length; i++) out.write('\x1b[2K\r\n');
      out.write(`\x1b[${options.length}A`);
      const chosen = options.find(o => o.value === value);
      const summary = chosen
        ? chalk.green(`✓ ${chosen.label}`)
        : chalk.dim('已取消');
      out.write(`\x1b[2K\r  ${summary}\n`);

      resolve(value);
    }

    function onData(chunk: string): void {
      if (chunk.startsWith('\x1b[A') || chunk === 'k') {
        selected = (selected - 1 + options.length) % options.length;
      } else if (chunk.startsWith('\x1b[B') || chunk === 'j') {
        selected = (selected + 1) % options.length;
      } else if (chunk === '\r' || chunk === '\n') {
        finish(options[selected].value);
        return;
      } else if (chunk === '\x1b' || chunk === '\x1b\x1b' || chunk === 'q' || chunk === '\x03') {
        finish(null);
        return;
      } else if (/^[1-9]$/.test(chunk)) {
        const idx = Number(chunk) - 1;
        if (idx < options.length) {
          finish(options[idx].value);
          return;
        }
        return;
      } else {
        return; // 其余按键无操作（不重绘）
      }
      render();
    }

    out.write(`${chalk.yellow('?')} ${chalk.bold(question)}\n`);
    render();
    stdin.on('data', onData);
  });
}
