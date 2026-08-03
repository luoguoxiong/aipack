/**
 * Tapable - 事件钩子系统
 *
 * 灵感来自 webpack 的 tapable 库。
 * 提供同步与异步钩子，允许 Extension 在 Runtime 生命周期的关键节点注入逻辑。
 *
 * Webpack 映射: tapable
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
        // 单个 tap 失败不影响其他 tap（与 webpack 行为一致）
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
        // 单个 tap 失败不影响其他 tap
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
        // 失败时保持当前值不变
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
