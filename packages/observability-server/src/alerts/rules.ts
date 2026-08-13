/**
 * 告警规则模型与校验（P0-2）。
 *
 * 规则基于内存聚合器指标（aggregator.summary / tools），支持：
 *   successRate / p95Ms / avgTurns / retryRate / permissionDenied / tokensTotal /
 *   requests / toolSuccessRate（按工具名）/ errorClassCount（按错误分类）。
 *
 * 空数据防护：成功率/平均步数/重试率/工具成功率在窗口内无数据时跳过评估，
 * 避免「空窗口 → 指标=0 → 误触发 lt 规则」。
 */

export const ALERT_METRICS = [
  'successRate',
  'p95Ms',
  'avgTurns',
  'retryRate',
  'permissionDenied',
  'tokensTotal',
  'requests',
  'toolSuccessRate',
  'errorClassCount',
  'versionSuccessRate',
  'versionP95Ms',
] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];

export const ALERT_OPERATORS = ['lt', 'lte', 'gt', 'gte', 'regress_by'] as const;
export type AlertOperator = (typeof ALERT_OPERATORS)[number];

/** 版本回归类指标：评估器走 queryVersionMetrics 对比最近两个版本，不走聚合器 */
export const VERSION_REGRESSION_METRICS = ['versionSuccessRate', 'versionP95Ms'] as const;

export function isVersionRegressionMetric(metric: AlertMetric): boolean {
  return (VERSION_REGRESSION_METRICS as readonly string[]).includes(metric);
}

/** 版本回归冷启动防护：对比任一侧版本请求量低于该值时不评估（指标不可靠） */
export const MIN_VERSION_REQUESTS = 10;

export interface AlertRule {
  id: string;
  name: string;
  /** 缺省 = 全局（所有应用合并） */
  appId?: string;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  /** 评估回看窗口（ms），默认 15min */
  lookbackMs: number;
  /** 冷却（ms）：触发/恢复通知后 N ms 内不重复通知，默认 10min */
  cooldownMs: number;
  /** 规则级 webhook；缺省用收集服务全局 ALERTS_WEBHOOK_URL */
  webhookUrl?: string;
  /** metric=toolSuccessRate 时目标工具 */
  toolName?: string;
  /** metric=errorClassCount 时目标错误分类 */
  errorClass?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 创建/更新规则入参（id/时间戳由服务端生成） */
export type NewAlertRule = Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt'>;

export const DEFAULT_LOOKBACK_MS = 15 * 60 * 1000;
export const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

/** 窗口内无数据时跳过评估的指标（空值=0 会误触发 lt/lte 规则） */
const NO_DATA_GUARD_METRICS = new Set<AlertMetric>([
  'successRate',
  'avgTurns',
  'retryRate',
  'toolSuccessRate',
]);

export function requiresNoDataGuard(metric: AlertMetric): boolean {
  return NO_DATA_GUARD_METRICS.has(metric);
}

export type ValidateResult =
  | { ok: true; rule: NewAlertRule }
  | { ok: false; error: string };

/**
 * 校验并归一化规则入参（允许缺省字段补默认值）。
 * 用于面板创建（body 全部由前端给）与更新（patch 与存量合并后整体校验）。
 */
export function validateRule(input: Partial<NewAlertRule> | null | undefined): ValidateResult {
  if (!input || typeof input !== 'object') return { ok: false, error: '规则不能为空' };

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) return { ok: false, error: '规则名称必填' };

  const metric = input.metric;
  if (!ALERT_METRICS.includes(metric as AlertMetric)) {
    return { ok: false, error: `metric 仅支持: ${ALERT_METRICS.join('|')}` };
  }

  const operator = input.operator;
  if (!ALERT_OPERATORS.includes(operator as AlertOperator)) {
    return { ok: false, error: `operator 仅支持: ${ALERT_OPERATORS.join('|')}` };
  }

  const threshold = Number(input.threshold);
  if (!Number.isFinite(threshold)) return { ok: false, error: 'threshold 必须为数字' };

  const regressionMetric = isVersionRegressionMetric(metric as AlertMetric);
  if (regressionMetric && operator !== 'regress_by') {
    return { ok: false, error: '版本回归指标（versionSuccessRate/versionP95Ms）必须使用 operator=regress_by' };
  }
  if (!regressionMetric && operator === 'regress_by') {
    return { ok: false, error: 'operator=regress_by 仅支持版本回归指标（versionSuccessRate/versionP95Ms）' };
  }
  if (operator === 'regress_by' && threshold <= 0) {
    return { ok: false, error: 'regress_by 的 threshold（退化幅度）必须为正数' };
  }

  const lookbackMs =
    input.lookbackMs === undefined || input.lookbackMs === null
      ? DEFAULT_LOOKBACK_MS
      : Number(input.lookbackMs);
  if (!Number.isFinite(lookbackMs) || lookbackMs < 60_000) {
    return { ok: false, error: 'lookbackMs 至少 60s' };
  }

  const cooldownMs =
    input.cooldownMs === undefined || input.cooldownMs === null
      ? DEFAULT_COOLDOWN_MS
      : Number(input.cooldownMs);
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
    return { ok: false, error: 'cooldownMs 不能为负' };
  }

  const toolName = typeof input.toolName === 'string' ? input.toolName.trim() || undefined : undefined;
  if (metric === 'toolSuccessRate' && !toolName) {
    return { ok: false, error: 'metric=toolSuccessRate 时必须指定 toolName' };
  }
  const errorClass =
    typeof input.errorClass === 'string' ? input.errorClass.trim() || undefined : undefined;
  if (metric === 'errorClassCount' && !errorClass) {
    return { ok: false, error: 'metric=errorClassCount 时必须指定 errorClass' };
  }

  const appId = typeof input.appId === 'string' && input.appId.trim() ? input.appId.trim() : undefined;
  const webhookUrl =
    typeof input.webhookUrl === 'string' && input.webhookUrl.trim() ? input.webhookUrl.trim() : undefined;

  return {
    ok: true,
    rule: {
      name,
      appId,
      metric: metric as AlertMetric,
      operator: operator as AlertOperator,
      threshold,
      lookbackMs,
      cooldownMs,
      webhookUrl,
      toolName,
      errorClass,
      enabled: input.enabled !== false,
    },
  };
}

/** 指标比较：value 是否满足 op threshold（违规判定） */
export function compare(value: number, op: AlertOperator, threshold: number): boolean {
  switch (op) {
    case 'lt':
      return value < threshold;
    case 'lte':
      return value <= threshold;
    case 'gt':
      return value > threshold;
    case 'gte':
      return value >= threshold;
    case 'regress_by':
      // 回归违规由评估器按指标方向（成功率下降/P95 上升）判定，不走通用比较
      return false;
  }
}

export const ALERT_METRIC_LABELS: Record<AlertMetric, string> = {
  successRate: '成功率',
  p95Ms: 'P95 耗时(ms)',
  avgTurns: '平均步数',
  retryRate: '重试率',
  permissionDenied: '权限拦截数',
  tokensTotal: 'Token 消耗量',
  requests: '请求量',
  toolSuccessRate: '工具成功率',
  errorClassCount: '错误分类计数',
  versionSuccessRate: '版本成功率回归',
  versionP95Ms: '版本 P95 耗时回归',
};

export const ALERT_OPERATOR_LABELS: Record<AlertOperator, string> = {
  lt: '<',
  lte: '≤',
  gt: '>',
  gte: '≥',
  regress_by: '退化幅度',
};
