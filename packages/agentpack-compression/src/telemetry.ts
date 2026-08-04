/**
 * 遥测 - 压缩动作埋点
 */

import type { Extension, ExtensionContext, RuntimeHooks, ContextResource } from 'agentpack';

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
  };
}

// ─── 遥测上报 Extension ───────────────────────────────────────────

export interface TelemetryReporter {
  report(t: CompressionTelemetry): void;
}

/** 默认控制台上报器 */
export class ConsoleTelemetryReporter implements TelemetryReporter {
  report(t: CompressionTelemetry): void {
    console.log(JSON.stringify({
      event: 'tengu_compact',
      level: t.level,
      action: t.action,
      beforeTokens: t.beforeTokens,
      afterTokens: t.afterTokens,
      tokenDelta: t.beforeTokens - t.afterTokens,
      reductionRatio: t.beforeTokens > 0
        ? Number(((t.beforeTokens - t.afterTokens) / t.beforeTokens).toFixed(4))
        : 0,
      triggerReason: t.triggerReason,
      cachePreserved: t.cachePreserved,
      compressionDepth: t.compressionDepth,
      duration: t.duration,
    }));
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
    hooks.afterTransform.tapPromise('compression-telemetry', async (resources: ContextResource[]) => {
      const telemetry = context.shared.get('compression_telemetry') as CompressionTelemetry[] | undefined;
      if (!telemetry || telemetry.length === 0) return resources;

      for (const t of telemetry) {
        this.reporter.report(t);
      }
      context.shared.delete('compression_telemetry');
      return resources;
    });
  }
}
