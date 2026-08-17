/**
 * Phase 5：Agent 发布 webhook 通知器（HTTP POST 到订阅 URL）。
 *
 * 配置环境变量：
 *   AGENT_WEBHOOK_URL  全局默认 webhook 接收地址（可被项目级配置覆盖，未来扩展）
 *   AGENT_WEBHOOK_TIMEOUT_MS  请求超时（默认 5s）
 *
 * 实现：零依赖 Node fetch（Node 18+ 内置）。
 *
 * 当前为全局单 URL；项目级订阅表（agent_subscribers）留待未来扩展。
 */
import type { AgentPublishedEvent, AgentWebhook } from '../api/agent-definitions';

export interface WebhookOptions {
  /** 全局默认 webhook URL（AGENT_WEBHOOK_URL） */
  url?: string;
  /** 请求超时 ms（默认 5000） */
  timeoutMs?: number;
}

export function createAgentWebhook(opts: WebhookOptions = {}): AgentWebhook {
  const url = opts.url;
  const timeoutMs = opts.timeoutMs ?? 5000;

  return {
    async onPublished(event: AgentPublishedEvent): Promise<void> {
      if (!url) return; // 未配置：no-op
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-aipack-event': 'agent.published' },
          body: JSON.stringify({
            event: 'agent.published',
            projectId: event.projectId,
            agentId: event.agentId,
            name: event.name,
            version: event.version,
            spec: event.spec,
            publishedBy: event.publishedBy,
            publishedAt: event.publishedAt,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          console.warn(
            `[observability-server] webhook 响应非 2xx: ${res.status} ${res.statusText}`,
          );
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
