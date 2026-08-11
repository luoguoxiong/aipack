/**
 * 告警通知（P0-2）：webhook JSON POST + console 兜底。
 *
 * - 取 webhookUrl：规则级 webhookUrl > 收集服务全局 ALERTS_WEBHOOK_URL；
 * - 5xx / 网络错误 / 超时 → 指数退避重试（默认 2 次：0.5s / 1s）；
 *   4xx（地址不存在等）→ 判定为配置问题，放弃重试；
 * - 未配置任何 webhook → console.log 兜底（服务日志即通知）。
 */

import type { AlertRuleRow } from '../store';

export interface AlertNotification {
  status: 'fired' | 'recovered';
  rule: AlertRuleRow;
  /** 触发/恢复时的指标值 */
  value: number;
  /** 事件时间（epoch ms） */
  at: number;
}

export interface NotifierOptions {
  defaultWebhookUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export interface Notifier {
  /** 发送通知；返回是否成功（无 webhook 时 console 兜底并返回 false） */
  send(n: AlertNotification): Promise<boolean>;
}

export function createNotifier(opts: NotifierOptions = {}): Notifier {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxRetries = opts.maxRetries ?? 2;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  return {
    async send(n) {
      const target = n.rule.webhookUrl?.trim() || opts.defaultWebhookUrl?.trim() || '';
      if (!target) {
        console.log(
          `[observability-server] 告警[${n.status}] 规则=${n.rule.name}` +
            ` (${n.rule.metric} ${n.rule.operator} ${n.rule.threshold}) value=${n.value}` +
            ` appId=${n.rule.appId ?? '全局'}\n` +
            `  → 未配置 webhook，仅记录本地日志（设置 ALERTS_WEBHOOK_URL 或规则 webhookUrl 可推送）`,
        );
        return false;
      }

      const payload = {
        type: 'alert',
        status: n.status,
        rule: {
          id: n.rule.id,
          name: n.rule.name,
          metric: n.rule.metric,
          operator: n.rule.operator,
          threshold: n.rule.threshold,
        },
        value: n.value,
        appId: n.rule.appId ?? null,
        at: n.at,
      };

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), timeoutMs);
          let res: Response;
          try {
            res = await fetchImpl(target, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
              signal: ac.signal,
            });
          } finally {
            clearTimeout(timer);
          }
          if (res.ok) return true;
          if (res.status >= 400 && res.status < 500 && res.status !== 429) {
            console.warn(
              `[observability-server] 告警 webhook 被拒绝(${res.status})，放弃重试。规则=${n.rule.name}`,
            );
            return false;
          }
          // 5xx / 429：进入退避重试
        } catch (err) {
          if (attempt >= maxRetries) {
            console.warn(
              `[observability-server] 告警 webhook 发送失败（已重试 ${maxRetries} 次）: ${(err as Error).message}`,
            );
            return false;
          }
        }
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
      }
      return false;
    },
  };
}
