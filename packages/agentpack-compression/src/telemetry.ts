/**
 * 遥测 - 压缩动作埋点
 *
 * ContextCompressionTransformer 把每轮遥测写入 `context.shared['compression_telemetry']`，
 * CompressionTelemetryExtension 通过 afterTransform hook 读取并上报。
 */

import type { Extension, ExtensionContext, RuntimeHooks, ContextResource } from 'agentpack';

// ─── 共享状态键 ───────────────────────────────────────────────────

export const TELEMETRY_SHARED_KEY = 'compression_telemetry';

// ─── 遥测数据结构 ─────────────────────────────────────────────────

export interface CompressionTelemetry {
  timestamp: number;
  sessionKey: string;
  turn: number;
  level: 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
  action: string;
  beforeTokens: number;
  afterTokens: number;
  resourcesAffected: number;
  triggerReason: string;
  cachePreserved: boolean;
  compressionDepth: number;
  duration: number;
  /** 是否发生了回滚（如配对验证失败） */
  rolledBack?: boolean;
  /** 是否发生错误（如持久化失败、fork 失败） */
  failed?: boolean;
  /** 错误/警告信息 */
  message?: string;
}

/** 创建遥测条目的辅助函数 */
export function createTelemetry(
  level: CompressionTelemetry['level'],
  action: string,
  beforeTokens: number,
  afterTokens: number,
  options?: Partial<CompressionTelemetry>,
): CompressionTelemetry {
  return {
    timestamp: Date.now(),
    sessionKey: '',
    turn: 0,
    level,
    action,
    beforeTokens,
    afterTokens,
    resourcesAffected: options?.resourcesAffected ?? 0,
    triggerReason: options?.triggerReason ?? 'threshold_exceeded',
    cachePreserved: options?.cachePreserved ?? true,
    compressionDepth: options?.compressionDepth ?? 0,
    duration: options?.duration ?? 0,
    rolledBack: options?.rolledBack,
    failed: options?.failed,
    message: options?.message,
  };
}

// ─── 遥测上报 Extension ───────────────────────────────────────────

export interface TelemetryReporter {
  report(t: CompressionTelemetry): void;
}

export interface ConsoleReporterOptions {
  logTokenDelta: boolean;
  logTriggerReason: boolean;
}

/** 默认控制台上报器 */
export class ConsoleTelemetryReporter implements TelemetryReporter {
  constructor(private opts: ConsoleReporterOptions = { logTokenDelta: true, logTriggerReason: true }) {}

  report(t: CompressionTelemetry): void {
    const payload: Record<string, unknown> = {
      event: 'tengu_compact',
      level: t.level,
      action: t.action,
      beforeTokens: t.beforeTokens,
      afterTokens: t.afterTokens,
      reductionRatio: t.beforeTokens > 0
        ? Number(((t.beforeTokens - t.afterTokens) / t.beforeTokens).toFixed(4))
        : 0,
      cachePreserved: t.cachePreserved,
      compressionDepth: t.compressionDepth,
      duration: t.duration,
    };
    if (this.opts.logTokenDelta) {
      payload.tokenDelta = t.beforeTokens - t.afterTokens;
    }
    if (this.opts.logTriggerReason) {
      payload.triggerReason = t.triggerReason;
    }
    if (t.rolledBack) payload.rolledBack = true;
    if (t.failed) payload.failed = true;
    if (t.message) payload.message = t.message;
    console.log(JSON.stringify(payload));
  }
}

/** 遥测 Extension - 通过 afterTransform hook 自动上报 */
export class CompressionTelemetryExtension implements Extension {
  readonly name = 'compression-telemetry';

  private reporter: TelemetryReporter;

  constructor(reporter?: TelemetryReporter) {
    this.reporter = reporter ?? new ConsoleTelemetryReporter();
  }

  apply(hooks: RuntimeHooks, context: ExtensionContext): void {
    // 在 apply 闭包中捕获 context，以便 tap 回调访问 shared 状态
    const reporter = this.reporter;
    const shared = context.shared;

    hooks.afterTransform.tapPromise('compression-telemetry', async (resources: ContextResource[]) => {
      const telemetry = shared.get(TELEMETRY_SHARED_KEY) as CompressionTelemetry[] | undefined;
      if (!telemetry || telemetry.length === 0) return resources;

      for (const t of telemetry) {
        try {
          reporter.report(t);
        } catch {
          // 上报失败不影响 pipeline
        }
      }
      // 清空本轮遥测，避免下一轮重复上报
      shared.delete(TELEMETRY_SHARED_KEY);
      return resources;
    });
  }
}
