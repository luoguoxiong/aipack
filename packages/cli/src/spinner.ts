/**
 * 轻量级终端旋转动画（无第三方依赖）。
 *
 * 仅在 TTY 下生效；非 TTY（管道/重定向）自动降级为静默。
 * 用法：
 *   const s = new Spinner();
 *   s.start('思考中');
 *   ...
 *   s.stop('完成');  // 清除动画行并写一行结果摘要
 *
 * 支持在 start 后调用 message 切换前缀；stop 时恢复光标。
 *
 * 暂停/恢复：权限确认选择器接管终端前需暂停动画，避免 spinner
 * 每 80ms 的 \r\x1b[2K 覆盖选择器渲染。通过模块级 active 引用，
 * 任意处可调用 pauseActiveSpinner()/resumeActiveSpinner()。
 */
import chalk from 'chalk';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 80;

/** 当前活动 spinner（同进程唯一），供全局暂停/恢复 */
let activeSpinner: Spinner | null = null;

/** 暂停当前活动 spinner（如确认选择器接管终端前调用） */
export function pauseActiveSpinner(): void {
  activeSpinner?.pause();
}

/** 恢复暂停的 spinner（确认结束后调用） */
export function resumeActiveSpinner(): void {
  activeSpinner?.resume();
}

export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frameIdx = 0;
  private prefix = '';
  /** 是否处于暂停态（曾活动但被临时挂起） */
  private paused = false;

  /** 是否正在旋转；非 TTY 下 start 永远不真正起效 */
  get active(): boolean {
    return this.timer !== null;
  }

  start(prefix: string): void {
    if (this.timer) this.stop();
    if (!process.stdout.isTTY) return;
    this.prefix = prefix;
    this.frameIdx = 0;
    this.paused = false;
    activeSpinner = this;
    this.render();
    this.timer = setInterval(() => {
      this.frameIdx = (this.frameIdx + 1) % FRAMES.length;
      this.render();
    }, INTERVAL_MS);
  }

  /** 中途切换前缀文本（如 tool_start → tool_end 之间） */
  message(prefix: string): void {
    if (!this.timer) return;
    this.prefix = prefix;
    this.render();
  }

  /** 暂停动画：清掉定时器与行，但保留"应继续"状态供 resume */
  pause(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.paused = true;
    process.stdout.write('\r\x1b[2K');
  }

  /** 恢复暂停的动画 */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (!process.stdout.isTTY) return;
    this.frameIdx = 0;
    this.render();
    this.timer = setInterval(() => {
      this.frameIdx = (this.frameIdx + 1) % FRAMES.length;
      this.render();
    }, INTERVAL_MS);
  }

  /** 停止动画：清除行；可选写一行结果摘要 */
  stop(summary?: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      // 清除动画行
      process.stdout.write('\r\x1b[2K');
    }
    this.paused = false;
    if (activeSpinner === this) activeSpinner = null;
    if (summary) {
      process.stdout.write(`${summary}\n`);
    }
  }

  private render(): void {
    const frame = chalk.cyan(FRAMES[this.frameIdx]);
    const text = this.prefix ? `${frame} ${chalk.dim(this.prefix)}` : frame;
    process.stdout.write(`\r\x1b[2K${text}`);
  }
}
