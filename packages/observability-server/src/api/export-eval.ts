/**
 * M4（EVAL_PLAN.md 5.1）：trace → EvalCase 回流导出。
 *
 *   POST /api/v1/export-eval
 *
 * - 鉴权与 ingest 一致（x-app-id / x-app-secret），导出范围限定本 app 的 trace
 * - 从 TraceDetail 提取 (用户消息, 工具调用序列) 组装 EvalCase 骨架：
 *   期望轨迹 = 实际轨迹（好 case 固化）；坏 case 由人工用 userMessage /
 *   origin='bugfix' 修正后固化为回归用例
 * - 注意：SDK 不落消息文本（只有指标与时间轴），用户消息仅当应用通过
 *   obs.emit('user_message', { text }) 上报时可用；否则留占位符由人工补充
 * - 脱敏强制过 redactValue（EVAL_PLAN.md 风险表：脱敏遗漏 → 导出管道强制过 redact 层）
 */

import http from 'node:http';
import { redactValue } from '@aipack-ai/observability';
import type { TraceStore } from '../store';
import type { AppStore } from '../stores/app-store';
import type { TraceDetail } from '../store';
import { json, readJson } from './helpers';

// ─── 导出请求 ─────────────────────────────────────────────────────

export interface ExportEvalBody {
  /** 指定 trace 导出；缺省按 sessionKey/since/until/status 过滤 */
  traceIds?: string[];
  sessionKey?: string;
  since?: number;
  until?: number;
  status?: string;
  /** 最多导出条数（缺省 20，上限 100） */
  limit?: number;
  /** 用例套件（缺省 'trace-export'） */
  suite?: string;
  /** 数据来源（缺省 'trace'；坏 case 修复后固化为 'bugfix'） */
  origin?: 'trace' | 'bugfix';
  /** case id 前缀（缺省 'trace-export'） */
  idPrefix?: string;
  /** 人工补充/修正的用户消息（bugfix 场景），覆盖所有导出 case 的 input.message */
  userMessage?: string;
  /** 脱敏开关（缺省 true；关闭仅限本地调试，CI 抽查泄漏） */
  redact?: boolean;
}

export interface ExportedEvalCase {
  id: string;
  suite: string;
  description?: string;
  mode: 'live';
  input: { message: string };
  expected: { type: 'tool-call'; calls: Array<{ tool: string; isError?: boolean }>; order: 'exact' };
  origin: 'trace' | 'bugfix';
  metadata?: { tags?: string[]; maxSteps?: number; timeoutMs?: number; repeats?: number };
}

export interface ExportEvalResult {
  ok: true;
  count: number;
  cases: ExportedEvalCase[];
  skipped: Array<{ traceId: string; reason: string }>;
}

// ─── 纯转换（单测覆盖） ────────────────────────────────────────────

const PLACEHOLDER_MESSAGE =
  '(未捕获用户消息：trace 不落消息文本，请人工补充 input.message 后再入库)';

/** 从自定义事件提取用户消息（应用需 obs.emit('user_message', { text }) 上报） */
export function extractUserMessage(detail: TraceDetail): string | undefined {
  for (const ev of detail.events) {
    if (ev.name !== 'user_message') continue;
    const data = ev.data as { text?: unknown; message?: unknown } | undefined;
    const text = typeof data?.text === 'string' ? data.text : typeof data?.message === 'string' ? data.message : undefined;
    if (text && text.trim()) return text;
  }
  return undefined;
}

/** 工具调用序列 → 期望轨迹（好 case：期望轨迹 = 实际轨迹） */
export function extractExpectedCalls(detail: TraceDetail): ExportedEvalCase['expected']['calls'] {
  return detail.tools.map((t) =>
    t.status === 'error'
      ? { tool: t.toolName, isError: true }
      : t.status === 'ok'
        ? { tool: t.toolName, isError: false }
        : { tool: t.toolName }, // blocked / skipped：不断言结果
  );
}

export function traceDetailToEvalCase(
  detail: TraceDetail,
  opts: {
    appId?: string;
    suite: string;
    idPrefix: string;
    origin: 'trace' | 'bugfix';
    userMessage?: string;
  },
): ExportedEvalCase {
  const { run } = detail;
  const userMessage =
    opts.userMessage ?? extractUserMessage(detail) ?? PLACEHOLDER_MESSAGE;
  const calls = extractExpectedCalls(detail);
  return {
    id: `${opts.idPrefix}/${run.traceId}`,
    suite: opts.suite,
    description: `trace 回流: model=${run.model ?? 'unknown'} status=${run.status} turns=${run.turns}`,
    mode: 'live',
    input: { message: userMessage },
    expected: { type: 'tool-call', calls, order: 'exact' },
    origin: opts.origin,
    metadata: {
      tags: [opts.appId ?? 'unknown', run.model ?? 'unknown', run.status].filter(Boolean),
      maxSteps: run.turns + 10,
      timeoutMs: 60_000,
    },
  };
}

// ─── HTTP handler ─────────────────────────────────────────────────

export interface ExportEvalHandler {
  (req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
}

export function createExportEvalHandler(deps: {
  traceStore: TraceStore;
  appStore: AppStore;
}): ExportEvalHandler {
  return async (req, res) => {
    const appId = header(req, 'x-app-id');
    const secret = header(req, 'x-app-secret');
    if (!appId || !secret || !(await deps.appStore.verifyApp(appId, secret))) {
      return json(res, 401, { error: 'unauthorized: invalid appId or appSecret' });
    }

    let body: ExportEvalBody;
    try {
      body = (await readJson(req)) as ExportEvalBody;
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }

    const suite = typeof body.suite === 'string' && body.suite.trim() ? body.suite.trim() : 'trace-export';
    const origin = body.origin === 'bugfix' ? 'bugfix' : 'trace';
    const idPrefix =
      typeof body.idPrefix === 'string' && body.idPrefix.trim() ? body.idPrefix.trim() : 'trace-export';
    const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 100);

    // 解析目标 traceIds：显式指定 → 校验归属；否则按过滤条件查本 app 的 runs
    let traceIds = body.traceIds;
    if (!Array.isArray(traceIds) || traceIds.length === 0) {
      const { items } = await deps.traceStore.queryRuns({
        sessionKey: body.sessionKey,
        since: body.since,
        until: body.until,
        status: body.status,
        appId,
        offset: 0,
        limit,
      });
      traceIds = items.map((r) => r.traceId);
    } else {
      // 显式指定的 trace 逐条校验归属（防止越权导出他人 trace）
      const owned: string[] = [];
      for (const id of traceIds.slice(0, limit)) {
        if (typeof id !== 'string' || !id) continue;
        const owner = await deps.traceStore.getRunAppId(id);
        if (owner === appId) owned.push(id);
      }
      traceIds = owned;
    }

    const cases: ExportedEvalCase[] = [];
    const skipped: Array<{ traceId: string; reason: string }> = [];
    const doRedact = body.redact !== false;

    for (const traceId of traceIds) {
      const detail = await deps.traceStore.queryTrace(traceId);
      if (!detail) {
        skipped.push({ traceId, reason: 'trace 不存在' });
        continue;
      }
      const c = traceDetailToEvalCase(detail, { appId, suite, idPrefix, origin, userMessage: body.userMessage });
      // 脱敏：导出管道强制过 redact 层（EVAL_PLAN.md 9 风险表）
      cases.push(doRedact ? redactValue(c) : c);
    }

    return json(res, 200, { ok: true, count: cases.length, cases, skipped } satisfies ExportEvalResult);
  };
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}
