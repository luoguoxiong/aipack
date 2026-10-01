/**
 * M4（EVAL_PLAN.md 5.1）：trace → EvalCase 回流导出测试。
 * 纯转换（traceDetailToEvalCase）+ 端到端（createCollector 内存 store + HTTP）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createCollector } from '../src/collector';
import { traceDetailToEvalCase, extractUserMessage } from '../src/api/export-eval';
import type { AppStore, TraceStore, TraceDetail } from '../src/index';
import type {
  RunRecord,
  ToolCallRecord as ObsToolCallRecord,
  EventRecord,
} from '@aipack-ai/observability';

// ─── 测试数据 ─────────────────────────────────────────────────────

const APP_ID = 'eval-app';
const APP_SECRET = 's3cret';

function makeRun(traceId: string, startedAt = Date.now()): RunRecord {
  return {
    traceId,
    startedAt,
    endedAt: startedAt + 1000,
    sessionKey: 'sess-1',
    model: 'deepseek-chat',
    status: 'success',
    turns: 2,
    durationMs: 1000,
    activeMs: 900,
    queuedMs: 100,
    inputTokens: 10,
    outputTokens: 5,
  };
}

function makeTool(traceId: string, name: string, status: ObsToolCallRecord['status']): ObsToolCallRecord {
  return {
    traceId,
    spanId: `span-${traceId}-${name}`,
    toolName: name,
    status,
    durationMs: 10,
  };
}

function makeEvent(traceId: string, name: string, data: unknown): EventRecord {
  return { traceId, name, data, timestamp: Date.now() };
}

function makeDetail(
  run: RunRecord,
  tools: ObsToolCallRecord[] = [],
  events: EventRecord[] = [],
): TraceDetail {
  return { run, spans: [], tools, events, retries: [] };
}

// ─── 内存 mock Store（只实现 export-eval 依赖的子集）────────────────

class StubTraceStore implements Partial<TraceStore> {
  details = new Map<string, TraceDetail>();
  owners = new Map<string, string>();

  async queryTrace(traceId: string): Promise<TraceDetail | undefined> {
    return this.details.get(traceId);
  }

  async getRunAppId(traceId: string): Promise<string | undefined> {
    return this.owners.get(traceId);
  }

  async queryRuns(filter: { appId?: string; sessionKey?: string; status?: string; offset: number; limit: number }) {
    const items = [...this.details.values()]
      .map((d) => d.run)
      .filter((r) => {
        if (filter.sessionKey && r.sessionKey !== filter.sessionKey) return false;
        if (filter.status && r.status !== filter.status) return false;
        if (filter.appId && this.owners.get(r.traceId) !== filter.appId) return false;
        return true;
      });
    return { total: items.length, items: items.slice(filter.offset, filter.offset + filter.limit).map((r) => ({ ...r, appId: this.owners.get(r.traceId), retries: 0 })) };
  }

  // TraceStore 其余方法不实现（handler 不触达）；用 as 断言
  asStore(): TraceStore {
    return this as unknown as TraceStore;
  }

  async close(): Promise<void> {}
  async healthCheck(): Promise<void> {}
}

class StubAppStore implements Partial<AppStore> {
  private apps = new Map<string, string>([[APP_ID, APP_SECRET]]);
  async verifyApp(appId: string, secret: string): Promise<boolean> {
    return this.apps.get(appId) === secret;
  }
  async seedApps(apps: Record<string, string>): Promise<void> {
    for (const [k, v] of Object.entries(apps)) this.apps.set(k, v);
  }
  asStore(): AppStore {
    return this as unknown as AppStore;
  }
}

// ─── 纯转换 ───────────────────────────────────────────────────────

describe('traceDetailToEvalCase（纯转换）', () => {
  it('期望轨迹 = 实际轨迹（order: exact），isError 对齐工具状态', () => {
    const run = makeRun('t-1');
    const detail = makeDetail(run, [
      makeTool('t-1', 'readFile', 'ok'),
      makeTool('t-1', 'writeFile', 'error'),
      makeTool('t-1', 'blockedTool', 'blocked'),
    ]);
    const c = traceDetailToEvalCase(detail, { suite: 'trace-export', idPrefix: 'trace-export', origin: 'trace' });
    assert.equal(c.id, 'trace-export/t-1');
    assert.equal(c.mode, 'live');
    assert.equal(c.origin, 'trace');
    assert.equal(c.expected.type, 'tool-call');
    assert.equal(c.expected.order, 'exact');
    assert.deepEqual(c.expected.calls, [
      { tool: 'readFile', isError: false },
      { tool: 'writeFile', isError: true },
      { tool: 'blockedTool' },
    ]);
    assert.equal(c.metadata?.maxSteps, 12); // turns + 10
  });

  it('用户消息：事件上报 > 人工补充 > 占位符', () => {
    const run = makeRun('t-2');
    const withEvent = makeDetail(run, [], [makeEvent('t-2', 'user_message', { text: '查询天气' })]);
    assert.equal(extractUserMessage(withEvent), '查询天气');
    const c1 = traceDetailToEvalCase(withEvent, { suite: 's', idPrefix: 'p', origin: 'trace' });
    assert.equal(c1.input.message, '查询天气');

    const noEvent = makeDetail(run);
    const c2 = traceDetailToEvalCase(noEvent, { suite: 's', idPrefix: 'p', origin: 'trace', userMessage: '人工修正' });
    assert.equal(c2.input.message, '人工修正');

    const c3 = traceDetailToEvalCase(noEvent, { suite: 's', idPrefix: 'p', origin: 'bugfix' });
    assert.ok(c3.input.message.includes('人工补充'), '无来源时留占位符');
    assert.equal(c3.origin, 'bugfix');
  });
});

// ─── 端到端（HTTP） ────────────────────────────────────────────────

async function postExport(
  port: number,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/export-eval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('POST /api/v1/export-eval（端到端）', () => {
  it('按 traceId 导出：脱敏 + EvalCase 骨架；归属校验拒外部 trace', async () => {
    const traceStore = new StubTraceStore();
    const detail = makeDetail(makeRun('t-ok'), [makeTool('t-ok', 'echo', 'ok')], [
      makeEvent('t-ok', 'user_message', { text: '我的手机号是 13800138000，帮我处理' }),
    ]);
    traceStore.details.set('t-ok', detail);
    traceStore.owners.set('t-ok', APP_ID);
    // 外部 app 的 trace
    traceStore.details.set('t-other', makeDetail(makeRun('t-other')));
    traceStore.owners.set('t-other', 'other-app');

    const collector = createCollector({
      apps: { [APP_ID]: APP_SECRET },
      businessStores: { appStore: new StubAppStore().asStore(), close: async () => {} } as never,
      traceStore: traceStore.asStore(),
    });
    const server = http.createServer((req, res) => void collector.handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const auth = { 'x-app-id': APP_ID, 'x-app-secret': APP_SECRET };

      // 鉴权失败
      assert.equal((await postExport(port, { traceIds: ['t-ok'] }, {})).status, 401);
      assert.equal((await postExport(port, { traceIds: ['t-ok'] }, { 'x-app-id': APP_ID, 'x-app-secret': 'bad' })).status, 401);

      // 归属校验：外部 trace 静默忽略（不暴露他人 traceId 存在性）
      const foreign = await postExport(port, { traceIds: ['t-ok', 't-other'] }, auth);
      assert.equal(foreign.status, 200);
      assert.equal(foreign.body.count, 1);
      assert.equal(foreign.body.cases[0].id, 'trace-export/t-ok');
      assert.deepEqual(foreign.body.skipped, []);

      // 脱敏：手机号被 mask
      const ok = await postExport(port, { traceIds: ['t-ok'] }, auth);
      assert.equal(ok.status, 200);
      const c = ok.body.cases[0];
      assert.ok(!JSON.stringify(c).includes('13800138000'), '导出内容不得包含手机号明文');
      assert.equal(c.expected.calls[0].tool, 'echo');
      assert.equal(c.suite, 'trace-export');
      assert.equal(c.origin, 'trace');

      // 人工修正：origin/suite/userMessage 覆盖
      const fixed = await postExport(
        port,
        { traceIds: ['t-ok'], suite: 'bugfix-regression', origin: 'bugfix', idPrefix: 'bfix', userMessage: '修正后的消息' },
        auth,
      );
      const fc = fixed.body.cases[0];
      assert.equal(fc.suite, 'bugfix-regression');
      assert.equal(fc.origin, 'bugfix');
      assert.equal(fc.id, 'bfix/t-ok');
      assert.equal(fc.input.message, '修正后的消息');

      // 不存在的 trace → 静默忽略（归属校验阶段丢弃，不暴露 traceId 存在性）
      const missing = await postExport(port, { traceIds: ['t-nope'] }, auth);
      assert.equal(missing.body.count, 0);
      assert.deepEqual(missing.body.skipped, []);
    } finally {
      server.close();
      await collector.close();
    }
  });

  it('按过滤条件导出（sessionKey/status，限定本 app）', async () => {
    const traceStore = new StubTraceStore();
    const errDetail = makeDetail({ ...makeRun('t-err'), status: 'error' as const }, [
      makeTool('t-err', 'writeFile', 'error'),
    ]);
    traceStore.details.set('t-err', errDetail);
    traceStore.owners.set('t-err', APP_ID);
    traceStore.details.set('t-foreign', makeDetail(makeRun('t-foreign')));
    traceStore.owners.set('t-foreign', 'other-app');

    const collector = createCollector({
      apps: { [APP_ID]: APP_SECRET },
      businessStores: { appStore: new StubAppStore().asStore(), close: async () => {} } as never,
      traceStore: traceStore.asStore(),
    });
    const server = http.createServer((req, res) => void collector.handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await postExport(
        port,
        { status: 'error' },
        { 'x-app-id': APP_ID, 'x-app-secret': APP_SECRET },
      );
      assert.equal(res.status, 200);
      assert.equal(res.body.count, 1, '只导出本 app 的 error trace');
      assert.equal(res.body.cases[0].id, 'trace-export/t-err');
      assert.deepEqual(res.body.cases[0].expected.calls, [{ tool: 'writeFile', isError: true }]);
    } finally {
      server.close();
      await collector.close();
    }
  });
});
