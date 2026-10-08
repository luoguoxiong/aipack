/**
 * Tapable - 事件钩子系统
 *
 * 提供同步与异步钩子，允许 Extension 在 Runtime 生命周期的关键节点注入逻辑。
 *
 * 单个 tap 抛错的处理策略（setTapFailurePolicy，默认 'log'）：
 * - 'log'：console.warn 告警 + 调用已注册的错误处理器（如遥测上报），继续执行后续 tap
 * - 'silent'：完全静默（旧行为），继续执行后续 tap
 * - 'throw'：中断后续 tap 并向上抛出（严格模式）
 *
 * 默认策略保持向后兼容（单个 tap 失败不影响其他 tap），但不再无声吞掉：
 * 至少 console.warn，且可经 setTapErrorHandler 接入遥测等观测通道。
 */

// ─── 钩子类型 ─────────────────────────────────────────────────────

export type TapType = 'sync' | 'async' | 'promise';

export interface Tap {
  /** 钩子名称（用于调试与去重） */
  name: string;
  /** 钩子类型 */
  type: TapType;
  /** 回调函数 */
  fn: (...args: any[]) => any;
  /** 执行阶段：before / during / after */
  stage?: number;
}

// ─── tap 失败处理（全局策略 + 错误处理器）────────────────────────

/** tap 失败处理策略 */
export type TapFailurePolicy = 'log' | 'silent' | 'throw';

/** 单个 tap 失败的信息（错误处理器 / 遥测上报载荷） */
export interface TapErrorInfo {
  /** 钩子名（RuntimeHooks 中的钩子名或自定义名） */
  hook: string;
  /** tap 名（注册时传入的 name） */
  tap: string;
  /** tap 抛出的原始错误 */
  error: unknown;
}

/** tap 失败处理器：上报遥测等。处理器自身抛错会被静默忽略（防递归） */
export type TapErrorHandler = (info: TapErrorInfo) => void;

let tapFailurePolicy: TapFailurePolicy = 'log';
let tapErrorHandler: TapErrorHandler | undefined;

/**
 * 配置 tap 失败策略。
 * - 'log'（默认）：告警 + 错误处理器，继续执行后续 tap
 * - 'silent'：完全静默（旧行为）
 * - 'throw'：中断并向上抛出
 */
export function setTapFailurePolicy(policy: TapFailurePolicy): void {
  tapFailurePolicy = policy;
}

/** 读取当前 tap 失败策略 */
export function getTapFailurePolicy(): TapFailurePolicy {
  return tapFailurePolicy;
}

/**
 * 注册全局 tap 错误处理器（如 Runtime 构造时接入遥测 onHookError 上报）。
 * 传入 undefined 清除。多 Runtime 实例时后注册者生效。
 */
export function setTapErrorHandler(handler: TapErrorHandler | undefined): void {
  tapErrorHandler = handler;
}

/** 上报 tap 失败：错误处理器（遥测等）→ 按策略决定告警/抛出 */
function handleTapError(hook: string, tap: Tap, err: unknown): void {
  if (tapErrorHandler) {
    try {
      tapErrorHandler({ hook, tap: tap.name, error: err });
    } catch {
      // 处理器自身失败时静默（避免递归 / 影响主流程）
    }
  }
  if (tapFailurePolicy === 'throw') throw err;
  if (tapFailurePolicy === 'log') {
    console.warn(`[aipack] extension tap "${tap.name}" on hook "${hook}" 失败:`, err);
  }
}

// ─── SyncHook ─────────────────────────────────────────────────────

export class SyncHook<TArgs extends any[] = any[]> {
  private taps: Tap[] = [];

  constructor(private readonly name: string) {}

  tap(name: string, fn: (...args: TArgs) => void, stage?: number): void {
    this.taps.push({ name, type: 'sync', fn, stage: stage ?? 0 });
    this.taps.sort((a, b) => (a.stage ?? 0) - (b.stage ?? 0));
  }

  call(...args: TArgs): void {
    for (const tap of this.taps) {
      try {
        tap.fn(...args);
      } catch (err) {
        // 单个 tap 失败不影响其他 tap（默认策略），但不再无声吞掉
        handleTapError(this.name, tap, err);
      }
    }
  }

  isUsed(): boolean {
    return this.taps.length > 0;
  }

  clear(): void {
    this.taps = [];
  }
}

// ─── AsyncSeriesHook ──────────────────────────────────────────────

export class AsyncSeriesHook<TArgs extends any[] = any[]> {
  private taps: Tap[] = [];

  constructor(private readonly name: string) {}

  tapPromise(name: string, fn: (...args: TArgs) => Promise<void>, stage?: number): void {
    this.taps.push({ name, type: 'promise', fn, stage: stage ?? 0 });
    this.taps.sort((a, b) => (a.stage ?? 0) - (b.stage ?? 0));
  }

  async promise(...args: TArgs): Promise<void> {
    for (const tap of this.taps) {
      try {
        await tap.fn(...args);
      } catch (err) {
        // 单个 tap 失败不影响其他 tap（默认策略），但不再无声吞掉
        handleTapError(this.name, tap, err);
      }
    }
  }

  isUsed(): boolean {
    return this.taps.length > 0;
  }

  clear(): void {
    this.taps = [];
  }
}

// ─── AsyncSeriesWaterfallHook ─────────────────────────────────────

export class AsyncSeriesWaterfallHook<T = any> {
  private taps: Tap[] = [];

  constructor(private readonly name: string) {}

  tapPromise(name: string, fn: (value: T, ...rest: any[]) => Promise<T>, stage?: number): void {
    this.taps.push({ name, type: 'promise', fn, stage: stage ?? 0 });
    this.taps.sort((a, b) => (a.stage ?? 0) - (b.stage ?? 0));
  }

  async promise(value: T, ...rest: any[]): Promise<T> {
    let current = value;
    for (const tap of this.taps) {
      try {
        current = await tap.fn(current, ...rest);
      } catch (err) {
        // 失败时保持当前值继续（默认策略），但不再无声吞掉
        handleTapError(this.name, tap, err);
      }
    }
    return current;
  }

  isUsed(): boolean {
    return this.taps.length > 0;
  }

  clear(): void {
    this.taps = [];
  }
}

// ─── HookMap ──────────────────────────────────────────────────────

export class HookMap<THook> {
  private map = new Map<string, THook>();

  constructor(private readonly factory: () => THook) {}

  for(key: string): THook {
    let hook = this.map.get(key);
    if (!hook) {
      hook = this.factory();
      this.map.set(key, hook);
    }
    return hook;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get(key: string): THook | undefined {
    return this.map.get(key);
  }

  keys(): string[] {
    return Array.from(this.map.keys());
  }
}
