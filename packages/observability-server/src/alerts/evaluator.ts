/**
 * 告警评估器（P0-2）：定时轮询规则 → 从内存聚合器取指标 → 状态机 firing/recovered。
 *
 * - 指标全部来自聚合器（summary / tools），O(1) 评估，无需 SQL；
 * - 状态机：违规 → firing（通知+记事件）；恢复 → recovered（通知+记事件）；
 * - 冷却：触发/恢复通知后 cooldownMs 内不重复通知（防抖动，事件照常记录）；
 * - 空数据防护：见 rules.ts requiresNoDataGuard —— 空窗口不评估，避免误报。
 */

import type { Aggregator } from '../aggregator';
import type { AggregatedMetrics } from '../types';
import type { SQLiteStore, AlertRuleRow } from '../store';
import type { Notifier } from './notify';
import { compare, requiresNoDataGuard } from './rules';

export interface EvaluatorDeps {
  /** 按应用解析聚合器（与查询 API 同一实例） */
  aggregatorFor(appId?: string): Aggregator;
  store: SQLiteStore;
  notifier: Notifier;
  /** 评估周期（ms），默认 60s */
  intervalMs?: number;
}

export interface AlertEvaluator {
  start(): void;
  stop(): void;
  /** 立即执行一轮评估，返回状态发生变化的规则数（测试/手动触发用） */
  evaluateOnce(): Promise<number>;
}

interface RuleState {
  firing: boolean;
  lastFiredAt?: number;
  lastNotifiedAt?: number;
}

export function createAlertEvaluator(deps: EvaluatorDeps): AlertEvaluator {
  const intervalMs = deps.intervalMs ?? 60_000;
  const states = new Map<string, RuleState>();
  let timer: NodeJS.Timeout | undefined;

  const stateOf = (id: string): RuleState => {
    let st = states.get(id);
    if (!st) {
      st = { firing: false };
      states.set(id, st);
    }
    return st;
  };

  /** 取指标值；无数据/指标不可得时返回 undefined（跳过评估） */
  function computeValue(rule: AlertRuleRow): number | undefined {
    const since = Date.now() - rule.lookbackMs;
    const agg = deps.aggregatorFor(rule.appId || undefined);
    const metric = rule.metric;
    // summary 无 groupBy 时恒返回 AggregatedMetrics（聚合器签名是联合类型，此处显式窄化）
    const summaryOf = (): AggregatedMetrics => agg.summary({ since }) as AggregatedMetrics;

    if (metric === 'toolSuccessRate') {
      const tool = agg.tools({ since }).find((t) => t.tool === rule.toolName);
      if (!tool) return undefined; // 窗口内该工具无调用 → 不评估
      return tool.successRate;
    }
    if (metric === 'errorClassCount') {
      return summaryOf().errorClasses[rule.errorClass ?? ''] ?? 0;
    }

    const summary = summaryOf();
    if (requiresNoDataGuard(metric) && summary.requests === 0) return undefined;

    switch (metric) {
      case 'successRate':
        return summary.successRate;
      case 'p95Ms':
        return summary.p95Ms;
      case 'avgTurns':
        return summary.avgTurns;
      case 'retryRate':
        return summary.retryRate;
      case 'permissionDenied':
        return summary.permissionDenied;
      case 'costUsd':
        return summary.costUsd;
      case 'requests':
        return summary.requests;
      default:
        return undefined;
    }
  }

  async function transition(rule: AlertRuleRow, value: number, status: 'fired' | 'recovered', st: RuleState): Promise<void> {
    const now = Date.now();
    deps.store.insertAlertEvent({
      ruleId: rule.id,
      ruleName: rule.name,
      appId: rule.appId,
      metric: rule.metric,
      operator: rule.operator,
      threshold: rule.threshold,
      value,
      status,
      createdAt: now,
    });
    // 冷却：距上次通知不足 cooldownMs 则只记事件不通知
    if (st.lastNotifiedAt !== undefined && now - st.lastNotifiedAt < rule.cooldownMs) return;
    st.lastNotifiedAt = now;
    await deps.notifier.send({ status, rule, value, at: now });
  }

  async function evaluateOnce(): Promise<number> {
    const rules = deps.store.listAlertRules();
    let transitions = 0;
    for (const rule of rules) {
      if (!rule.enabled) continue;
      const value = computeValue(rule);
      if (value === undefined) continue;
      const violated = compare(value, rule.operator, rule.threshold);
      const st = stateOf(rule.id);
      if (violated && !st.firing) {
        st.firing = true;
        st.lastFiredAt = Date.now();
        transitions += 1;
        await transition(rule, value, 'fired', st);
      } else if (!violated && st.firing) {
        st.firing = false;
        transitions += 1;
        await transition(rule, value, 'recovered', st);
      }
    }
    return transitions;
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void evaluateOnce().catch((err) => {
          console.warn('[observability-server] 告警评估失败:', (err as Error).message);
        });
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    evaluateOnce,
  };
}
