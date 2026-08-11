/**
 * 收集服务端到端验收（@aipack/observability-server，observability-s2.md §9）：
 * 起真实收集服务（createCollector + http server）→ SDK 埋点上报 → 查询 /metrics、/traces 断言。
 * 附加用例：鉴权失败丢弃、上报失败本地缓存补报。
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRuntime, createRequest } from '@aipack/agent';
import type { StreamFn, StreamEvent, Message, AssistantMessage, Tool } from '@aipack/agent';
import { createObservability, HttpReporter, ObservabilityTelemetry } from '@aipack/observability';
import type { EventBatch } from '@aipack/observability';
import { createCollector, createCollectorServer, SQLiteStore } from '../src/index';
import type { CollectorOptions } from '../src/index';
import type { RunRecord, SpanRecord, ToolCallRecord } from '@aipack/observability';

// ─── mock streamFn（与 telemetry.test.ts 同手法）──────────────────

function mockStreamFn(messages: Message[]): StreamFn {
  return async function* (): AsyncGenerator<StreamEvent> {
    for (const msg of messages) {
      yield { type: 'done', message: msg as AssistantMessage };
    }
  };
}

function assistant(
  text: string,
  usage?: { input?: number; output?: number; cost?: { input: number; output: number; total: number } },
): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: {
      input: usage?.input ?? 10,
      output: usage?.output ?? 5,
      total: (usage?.input ?? 10) + (usage?.output ?? 5),
      ...(usage?.cost ? { cost: usage.cost } : {}),
    },
    timestamp: Date.now(),
  };
}

const echoTool: Tool = {
  name: 'echo',
  description: '回显参数',
  parameters: { type: 'object', properties: { msg: { type: 'string' } } },
  execute: async (_id, args) => ({
    content: [{ type: 'text', text: String((args as any)?.msg ?? '') }],
    details: {},
  }),
};

/** 第一轮返回工具调用，后续返回纯文本 */
function mockToolStreamFn(): StreamFn {
  let called = 0;
  return async function* (): AsyncGenerator<StreamEvent> {
    called += 1;
    if (called === 1) {
      const toolCall: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'echo', arguments: { msg: 'foo' } }],
        stopReason: 'toolUse',
        usage: { input: 10, output: 5, total: 15 },
        timestamp: Date.now(),
      };
      yield { type: 'done', message: toolCall };
    } else {
      yield { type: 'done', message: assistant('done') };
    }
  };
}

/** 模拟 provider 内部重试：首次调用经 onRetryAttempt 通知后退避，随即成功 */
function retryStreamFn(): StreamFn {
  return async function* (_model, _context, options): AsyncGenerator<StreamEvent> {
    options?.onRetryAttempt?.({ attempt: 1, error: new Error('boom'), delayMs: 1 });
    yield { type: 'done', message: assistant('recovered') };
  };
}

// ─── 测试基础设施 ─────────────────────────────────────────────────

const APP_ID = 'test-app';
const APP_SECRET = 's3cret';
const ADMIN = { username: 'admin', password: 'admin123' };

let cleanup: Array<() => void> = [];

function tempDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tempDb(): string {
  return path.join(tempDir('obs-db'), 'obs.db');
}

/** 启动真实收集服务，返回 baseUrl + 面板 token + dbPath + collector */
async function startCollector(
  apps: Record<string, string> = { [APP_ID]: APP_SECRET },
  extraOpts: Omit<CollectorOptions, 'dbPath' | 'apps' | 'admin'> = {},
): Promise<{
  baseUrl: string;
  dbPath: string;
  token: string;
  collector: ReturnType<typeof createCollector>;
}> {
  const dbPath = tempDb();
  const collector = createCollector({ dbPath, apps, admin: ADMIN, ...extraOpts });
  const server = http.createServer((req, res) => void collector.handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  cleanup.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await collector.close();
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = await login(baseUrl);
  return { baseUrl, dbPath, token, collector };
}

/** 面板登录，返回 Bearer token */
async function login(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  assert.equal(res.status, 200, '面板登录应成功');
  const body = (await res.json()) as { token?: string };
  assert.ok(body.token, '应返回 token');
  return body.token as string;
}

async function requestJson(
  baseUrl: string,
  urlPath: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const getJson = (baseUrl: string, urlPath: string, token?: string) =>
  requestJson(baseUrl, urlPath, { token });

/** 直接 POST /api/v1/ingest，返回状态码（空批次也可，服务端返回 200） */
async function postIngest(
  baseUrl: string,
  appId: string,
  appSecret: string,
): Promise<number> {
  const res = await fetch(`${baseUrl}/api/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-app-id': appId, 'x-app-secret': appSecret },
    body: JSON.stringify({ appId, runs: [], spans: [], toolCalls: [], permissions: [] }),
  });
  return res.status;
}

async function runOnce(telemetry: any, opts: { streamFn: StreamFn; tools?: Tool[]; permissionPolicy?: any } = {
  streamFn: mockStreamFn([assistant('hello')]),
}) {
  const runtime = createRuntime({
    streamFn: opts.streamFn,
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.permissionPolicy ? { permissionPolicy: opts.permissionPolicy } : {}),
    telemetry,
  });
  return runtime.run(createRequest('hi'));
}

afterEach(() => {
  const fns = cleanup;
  cleanup = [];
  for (const fn of fns) fn();
});

// ─── 用例 ─────────────────────────────────────────────────────────

describe('S2 收集服务端到端', () => {
  it('run 成功：summary.requests=1、successRate=1，trace 含 run + model span', async () => {
    const { baseUrl, dbPath, token } = await startCollector();
    const obs = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    const result = await runOnce(obs.telemetry);
    assert.equal(result.success, true);
    await obs.close(); // 等上报完成

    const summary = await getJson(baseUrl, '/metrics/summary', token);
    assert.equal(summary.status, 200);
    assert.equal(summary.body.requests, 1);
    assert.equal(summary.body.successRate, 1);
    assert.equal(summary.body.avgTurns, 1);

    const detail = await getJson(baseUrl, `/traces/${result.metadata.traceId}`, token);
    assert.equal(detail.status, 200);
    const kinds = detail.body.spans.map((s: any) => s.kind);
    assert.ok(kinds.includes('run'));
    assert.ok(kinds.includes('model'));

    // 落盘持久化：关闭收集端后重开 db，trace 仍在
    const store = new SQLiteStore(dbPath);
    assert.ok(store.queryTrace(String(result.metadata.traceId)), 'trace 应已持久化');
    store.close();
  });

  it('工具循环 2 轮：avgTurns=2，/metrics/tools 工具 successRate=1', async () => {
    const { baseUrl, token } = await startCollector();
    const obs = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    await runOnce(obs.telemetry, { streamFn: mockToolStreamFn(), tools: [echoTool] });
    await obs.close();

    const summary = await getJson(baseUrl, '/metrics/summary', token);
    assert.equal(summary.body.avgTurns, 2);
    const tools = await getJson(baseUrl, '/metrics/tools', token);
    assert.equal(tools.body.length, 1);
    assert.equal(tools.body[0].tool, 'echo');
    assert.equal(tools.body[0].calls, 1);
    assert.equal(tools.body[0].successRate, 1);
  });

  it('工具抛错：该工具 successRate=0、errors=1，tool span status=error', async () => {
    const throwingTool: Tool = {
      name: 'echo',
      description: '总是抛错',
      parameters: { type: 'object' },
      execute: async () => {
        throw new Error('boom');
      },
    };
    const { baseUrl, token } = await startCollector();
    const obs = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    const result = await runOnce(obs.telemetry, { streamFn: mockToolStreamFn(), tools: [throwingTool] });
    await obs.close();

    const tools = await getJson(baseUrl, '/metrics/tools', token);
    assert.equal(tools.body[0].successRate, 0);
    assert.equal(tools.body[0].errors, 1);

    const detail = await getJson(baseUrl, `/traces/${result.metadata.traceId}`, token);
    const toolSpan = detail.body.spans.find((s: any) => s.kind === 'tool');
    assert.equal(toolSpan.status, 'error');
  });

  it('权限拒绝：permissionDenied=1，且工具统计不计入', async () => {
    const { baseUrl, token } = await startCollector();
    const obs = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    await runOnce(obs.telemetry, {
      streamFn: mockToolStreamFn(),
      tools: [echoTool],
      permissionPolicy: { check: async () => 'deny' },
    });
    await obs.close();

    const summary = await getJson(baseUrl, '/metrics/summary', token);
    assert.equal(summary.body.permissionDenied, 1);
    const tools = await getJson(baseUrl, '/metrics/tools', token);
    assert.equal(tools.body.length, 0, '被拒调用不计入工具统计分母');
  });

  it('模型重试：span.attempts=2、retryRate=1', async () => {
    const { baseUrl, token } = await startCollector();
    const obs = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    const result = await runOnce(obs.telemetry, { streamFn: retryStreamFn() });
    await obs.close();

    const summary = await getJson(baseUrl, '/metrics/summary', token);
    assert.equal(summary.body.retryRate, 1);
    const detail = await getJson(baseUrl, `/traces/${result.metadata.traceId}`, token);
    const modelSpan = detail.body.spans.find((s: any) => s.kind === 'model');
    assert.equal(modelSpan.attempts, 2);
  });

  it('流式请求：run 落库可查询（durationMs）', async () => {
    const { baseUrl, token } = await startCollector();
    const obs = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    const runtime = createRuntime({
      streamFn: async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', delta: 'hel' };
        yield { type: 'done', message: assistant('hello') };
      },
      telemetry: obs.telemetry,
    });
    for await (const _chunk of runtime.stream(createRequest('hi'))) {
      /* 排空 */
    }
    await obs.close();

    const list = await getJson(baseUrl, '/traces', token);
    assert.equal(list.body.total, 1);
    assert.ok(typeof list.body.items[0].durationMs === 'number');
  });

  it('校验失败请求：/traces?status=validation 命中', async () => {
    const { baseUrl, token } = await startCollector();
    const obs = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    const runtime = createRuntime({
      streamFn: mockStreamFn([assistant('hello')]),
      telemetry: obs.telemetry,
    });
    await runtime.run(createRequest(''));
    await obs.close();

    const list = await getJson(baseUrl, '/traces?status=validation', token);
    assert.equal(list.body.total, 1);
    assert.equal(list.body.items[0].status, 'validation');
    const summary = await getJson(baseUrl, '/metrics/summary', token);
    assert.equal(summary.body.requests, 1);
    assert.equal(summary.body.successRate, 0);
  });

  it('cost 透传：usage.cost.total 出现在 summary.costUsd 与 span.costUsd', async () => {
    const { baseUrl, token } = await startCollector();
    const obs = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    const result = await runOnce(obs.telemetry, {
      streamFn: mockStreamFn([assistant('hello', { cost: { input: 0.0001, output: 0.0002, total: 0.0003 } })]),
    });
    await obs.close();

    const summary = await getJson(baseUrl, '/metrics/summary', token);
    assert.equal(summary.body.costUsd, 0.0003);
    const detail = await getJson(baseUrl, `/traces/${result.metadata.traceId}`, token);
    const modelSpan = detail.body.spans.find((s: any) => s.kind === 'model');
    assert.equal(modelSpan.costUsd, 0.0003);
  });

  it('鉴权失败：错误 secret 被拒(401)，客户端丢弃且不缓存', async () => {
    const { baseUrl, token } = await startCollector();
    const cacheDir = tempDir('obs-cache');
    const obs = createObservability({ appId: APP_ID, appSecret: 'wrong-secret', endpoint: baseUrl, cacheDir });
    await runOnce(obs.telemetry);
    await obs.close();

    const list = await getJson(baseUrl, '/traces', token);
    assert.equal(list.body.total, 0, '未鉴权的数据不应入库');
    const cacheFile = path.join(cacheDir, `${APP_ID}.json`);
    assert.ok(!fs.existsSync(cacheFile), '4xx 不应写入缓存（重试无意义）');
  });

  it('上报失败本地缓存补报：断网落缓存 → 收集服务恢复后补报成功', async () => {
    const cacheDir = tempDir('obs-cache');

    // 1. endpoint 指向未监听端口 → 上报失败 → 写缓存
    // 起一个 http server 拿端口后立刻关闭，该端口即"死端口"
    const deadServer = http.createServer();
    await new Promise<void>((r) => deadServer.listen(0, '127.0.0.1', r));
    const deadPort = (deadServer.address() as AddressInfo).port;
    await new Promise<void>((r) => deadServer.close(() => r()));

    const reporter = new HttpReporter({
      endpoint: `http://127.0.0.1:${deadPort}`,
      appId: APP_ID,
      appSecret: APP_SECRET,
      cacheDir,
    });
    const telemetry = new ObservabilityTelemetry(reporter, { intervalMs: 10 ** 9 });
    const result = await runOnce(telemetry);
    await telemetry.close(); // 网络失败 → 缓存
    const cacheFile = path.join(cacheDir, `${APP_ID}.json`);
    assert.ok(fs.existsSync(cacheFile), '上报失败应写入本地缓存');

    // 2. 真实收集服务起来，用同一 cacheDir 的 reporter 补报
    const { baseUrl, token } = await startCollector();
    const reporter2 = new HttpReporter({
      endpoint: baseUrl,
      appId: APP_ID,
      appSecret: APP_SECRET,
      cacheDir,
    });
    const ok = await reporter2.send({ runs: [], spans: [], toolCalls: [], permissions: [] } satisfies EventBatch);
    assert.equal(ok, true, '缓存补报应成功');
    assert.ok(!fs.existsSync(cacheFile), '补报成功后缓存应删除');

    const detail = await getJson(baseUrl, `/traces/${result.metadata.traceId}`, token);
    assert.equal(detail.status, 200, '补报的数据应可查询');
    assert.equal(detail.body.traceId, result.metadata.traceId);
  });
});

describe('S2 面板 API（登录 + 应用管理 + 数据隔离）', () => {
  it('登录：正确凭证签发 token、/api/auth/me 可用；错误凭证 401', async () => {
    const { baseUrl, token } = await startCollector();

    const me = await getJson(baseUrl, '/api/auth/me', token);
    assert.equal(me.status, 200);
    assert.equal(me.body.username, ADMIN.username);

    const bad = await requestJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: ADMIN.username, password: 'wrong' },
    });
    assert.equal(bad.status, 401, '错误密码应被拒');
  });

  it('查询端点需登录：无 token 访问 /metrics/summary 返回 401', async () => {
    const { baseUrl } = await startCollector();
    const res = await getJson(baseUrl, '/metrics/summary');
    assert.equal(res.status, 401);
  });

  it('创建应用 → 生成 appId/appSecret → 新应用上报 → 按 appId 数据隔离', async () => {
    const { baseUrl, token } = await startCollector();

    // 面板创建新应用
    const created = await requestJson(baseUrl, '/api/apps', {
      method: 'POST',
      token,
      body: { name: '新应用' },
    });
    assert.equal(created.status, 201);
    assert.ok(created.body.appId.startsWith('app_'), 'appId 应自动生成');
    assert.ok(created.body.appSecret.startsWith('sk_'), 'appSecret 应自动生成');

    // 用种子应用上报一条
    const obs1 = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    await runOnce(obs1.telemetry);
    await obs1.close();

    // 用新应用上报一条
    const obs2 = createObservability({ appId: created.body.appId, appSecret: created.body.appSecret, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    await runOnce(obs2.telemetry);
    await obs2.close();

    // 全局 = 2；按应用过滤各为 1
    const all = await getJson(baseUrl, '/metrics/summary', token);
    assert.equal(all.body.requests, 2);
    const byNew = await getJson(baseUrl, `/metrics/summary?appId=${created.body.appId}`, token);
    assert.equal(byNew.body.requests, 1);
    const bySeed = await getJson(baseUrl, `/metrics/summary?appId=${APP_ID}`, token);
    assert.equal(bySeed.body.requests, 1);

    // /traces 列表带 appId，且新应用 trace 标记来源
    const traces = await getJson(baseUrl, `/traces?appId=${created.body.appId}`, token);
    assert.equal(traces.body.total, 1);
    assert.equal(traces.body.items[0].appId, created.body.appId);
  });

  it('删除应用后 ingest 被拒(401)', async () => {
    const { baseUrl, token } = await startCollector({});
    const created = await requestJson(baseUrl, '/api/apps', {
      method: 'POST',
      token,
      body: { name: '临时应用' },
    });
    assert.equal(created.status, 201);

    const del = await requestJson(baseUrl, `/api/apps/${created.body.appId}`, { method: 'DELETE', token });
    assert.equal(del.status, 200);

    const status = await postIngest(baseUrl, created.body.appId, created.body.appSecret);
    assert.equal(status, 401, '已删除应用的上报应被拒');
    const list = await getJson(baseUrl, '/traces', token);
    assert.equal(list.body.total, 0, '被删应用的上报不应入库');
  });

  it('重置 secret：旧 secret 失效、新 secret 生效', async () => {
    const { baseUrl, token } = await startCollector();
    const created = await requestJson(baseUrl, '/api/apps', {
      method: 'POST',
      token,
      body: { name: '密钥应用' },
    });
    const oldSecret = created.body.appSecret;

    const regen = await requestJson(baseUrl, `/api/apps/${created.body.appId}/regenerate-secret`, { method: 'POST', token });
    assert.equal(regen.status, 200);
    assert.notEqual(regen.body.appSecret, oldSecret, '新 secret 应不同');

    // 旧 secret 上报 → 401
    assert.equal(await postIngest(baseUrl, created.body.appId, oldSecret), 401, '旧 secret 应被拒');
    const list = await getJson(baseUrl, '/traces', token);
    assert.equal(list.body.total, 0, '旧 secret 数据不应入库');

    // 新 secret 上报 → 200
    assert.equal(await postIngest(baseUrl, created.body.appId, regen.body.appSecret), 200, '新 secret 应生效');
  });
});

// ─── P0 retention / alerting 测试数据构造 ─────────────────────────

function makeRun(traceId: string, startedAt: number): RunRecord {
  return {
    traceId,
    startedAt,
    endedAt: startedAt + 1000,
    sessionKey: 's',
    model: 'gpt-4o-mini',
    status: 'success',
    turns: 1,
    durationMs: 1000,
    activeMs: 900,
    queuedMs: 100,
    inputTokens: 10,
    outputTokens: 5,
  };
}

function makeSpan(traceId: string, startedAt: number): SpanRecord {
  return {
    traceId,
    spanId: `span-${traceId}`,
    kind: 'model',
    name: 'model:gpt-4o-mini',
    startedAt,
    durationMs: 800,
    status: 'ok',
    attempts: 1,
    inputTokens: 10,
    outputTokens: 5,
    sessionKey: 's',
  };
}

function makeTool(traceId: string): ToolCallRecord {
  return { traceId, spanId: `span-${traceId}`, toolName: 'echo', status: 'ok', durationMs: 100 };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 本地 mock webhook：捕获收到的告警通知载荷 */
function startWebhookServer(): Promise<{
  url: string;
  posts: any[];
  close: () => Promise<void>;
}> {
  const posts: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      try {
        posts.push(JSON.parse(raw));
      } catch {
        /* 忽略非法载荷 */
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      cleanup.push(async () => {
        await new Promise<void>((r) => server.close(() => r()));
      });
      resolve({ url: `http://127.0.0.1:${port}`, posts, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

// ─── P0-1 retention ───────────────────────────────────────────────

describe('P0 retention 数据保留', () => {
  it('prune 只删除过期明细（runs/spans/tool_calls），备份快照可生成', async () => {
    const dbPath = tempDb();
    const store = new SQLiteStore(dbPath);
    const now = Date.now();
    store.insertRun(makeRun('old', now - 40 * 86400_000));
    store.insertSpan(makeSpan('old', now - 40 * 86400_000));
    store.insertToolCall(makeTool('old'));
    store.insertRun(makeRun('new', now));

    const backupDir = path.join(path.dirname(dbPath), 'backup');
    const backupFile = store.backup(backupDir);
    assert.ok(fs.existsSync(backupFile), 'VACUUM INTO 备份文件应存在');

    const cleared = store.prune(now - 10 * 86400_000); // 保留 10 天
    assert.equal(cleared, 3, '应删除 3 条过期记录');
    assert.equal(store.queryTrace('old'), undefined, '过期 trace 应被删除');
    assert.ok(store.queryTrace('new'), '新 trace 应保留');
    store.close();
  });

  it('collector 定时清理：过期数据被 prune，startup 清理不误删', async () => {
    // days 极小 → before≈now，过期数据（1h 前）立即被清
    const { baseUrl, dbPath, token } = await startCollector(
      { [APP_ID]: APP_SECRET },
      { retention: { days: 0.000001, intervalMs: 20 } },
    );
    const writer = new SQLiteStore(dbPath);
    writer.insertRun(makeRun('old', Date.now() - 3600_000));
    writer.close();

    await sleep(150);
    const list = await getJson(baseUrl, '/traces', token);
    assert.equal(list.body.total, 0, '过期数据应被定时清理');
  });
});

// ─── P0-2 alerting ────────────────────────────────────────────────

const RULE_BODY = (webhookUrl?: string, extra: Record<string, unknown> = {}) => ({
  name: '成功率过低',
  metric: 'successRate',
  operator: 'lt',
  threshold: 0.95,
  lookbackMs: 60_000,
  cooldownMs: 0,
  webhookUrl,
  ...extra,
});

describe('P0 alerting 告警规则 API', () => {
  it('规则 CRUD + 鉴权 + 校验', async () => {
    const { baseUrl, token } = await startCollector();

    // 未登录 → 401
    assert.equal((await requestJson(baseUrl, '/api/alerts/rules', { method: 'POST', body: RULE_BODY() })).status, 401);

    // 非法 metric → 400
    const bad = await requestJson(baseUrl, '/api/alerts/rules', { method: 'POST', token, body: { ...RULE_BODY(), metric: 'nope' } });
    assert.equal(bad.status, 400);

    // 创建
    const created = await requestJson(baseUrl, '/api/alerts/rules', { method: 'POST', token, body: RULE_BODY() });
    assert.equal(created.status, 201);
    const id = created.body.id;
    assert.ok(id, '应生成规则 id');
    assert.equal(created.body.lookbackMs, 60_000);
    assert.equal(created.body.enabled, true);

    // 列表
    const list = await getJson(baseUrl, '/api/alerts/rules', token);
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);

    // 更新
    const updated = await requestJson(baseUrl, `/api/alerts/rules/${id}`, {
      method: 'PUT',
      token,
      body: { threshold: 0.99 },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.threshold, 0.99);
    assert.equal(updated.body.name, '成功率过低', '合并更新不应丢字段');

    // 删除
    const del = await requestJson(baseUrl, `/api/alerts/rules/${id}`, { method: 'DELETE', token });
    assert.equal(del.status, 200);
    assert.equal((await getJson(baseUrl, '/api/alerts/rules', token)).body.length, 0);
  });

  it('alert test 端点：未启用告警返回 400', async () => {
    const { baseUrl, token } = await startCollector(); // 未配置 alerts
    const created = await requestJson(baseUrl, '/api/alerts/rules', { method: 'POST', token, body: RULE_BODY() });
    const res = await requestJson(baseUrl, `/api/alerts/rules/${created.body.id}/test`, { method: 'POST', token });
    assert.equal(res.status, 400, '未启用告警时测试通知应报错');
  });
});

describe('P0 alerting 评估器（firing / recovered / 冷却 / webhook）', () => {
  it('触发 → firing + webhook 收到 payload；恢复 → recovered + 恢复通知', async () => {
    const webhook = await startWebhookServer();
    const { baseUrl, token, collector } = await startCollector(
      { [APP_ID]: APP_SECRET },
      { alerts: { evaluateIntervalMs: 3600_000, defaultWebhookUrl: webhook.url } },
    );
    assert.ok(collector.alerts, 'alerts 配置时应装配评估器');

    // 成功率 < 50% 规则（lookback 60s；窗口内旧数据保留，阈值取 0.5 便于状态迁移）
    const created = await requestJson(baseUrl, '/api/alerts/rules', {
      method: 'POST',
      token,
      body: RULE_BODY(webhook.url, { threshold: 0.5 }),
    });
    assert.equal(created.status, 201);

    // 阶段一：1 条失败（validation → successRate=0）→ 触发 firing
    const obs1 = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    const runtime1 = createRuntime({ streamFn: mockStreamFn([assistant('hello')]), telemetry: obs1.telemetry });
    await runtime1.run(createRequest(''));
    await obs1.close();

    const transitions = await collector.alerts!.evaluateOnce();
    assert.equal(transitions, 1, '本轮应恰好 1 条规则状态变化');

    const events = await getJson(baseUrl, '/api/alerts/events', token);
    assert.equal(events.body.total, 1);
    assert.equal(events.body.items[0].status, 'fired');
    assert.ok(events.body.items[0].value < 0.5, '事件应记录触发时的指标值');

    // webhook 收到 fired
    assert.equal(webhook.posts.length, 1);
    assert.equal(webhook.posts[0].status, 'fired');
    assert.equal(webhook.posts[0].rule.metric, 'successRate');

    // 阶段二：补 3 条成功 → 3/4=0.75 > 0.5 → 恢复
    const obs2 = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    await runOnce(obs2.telemetry);
    await runOnce(obs2.telemetry);
    await runOnce(obs2.telemetry);
    await obs2.close();
    await collector.alerts!.evaluateOnce();

    const events2 = await getJson(baseUrl, '/api/alerts/events', token);
    assert.equal(events2.body.total, 2);
    assert.equal(events2.body.items[0].status, 'recovered', '最新事件应为 recovered');
    assert.equal(webhook.posts.length, 2);
    assert.equal(webhook.posts[1].status, 'recovered');
  });

  it('冷却期内不重复通知（事件照常记录）', async () => {
    const webhook = await startWebhookServer();
    const { baseUrl, token, collector } = await startCollector(
      { [APP_ID]: APP_SECRET },
      { alerts: { evaluateIntervalMs: 3600_000 } },
    );

    // cooldown 1h：fired/recovered/fired 都发生在冷却内
    await requestJson(baseUrl, '/api/alerts/rules', {
      method: 'POST',
      token,
      body: RULE_BODY(webhook.url, { threshold: 0.5, cooldownMs: 3600_000 }),
    });

    const obs = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    const runtime = createRuntime({ streamFn: mockStreamFn([assistant('hello')]), telemetry: obs.telemetry });
    await runtime.run(createRequest('')); // 失败 → 0/1=0 < 0.5 → fire
    await obs.close();

    await collector.alerts!.evaluateOnce();
    assert.equal(webhook.posts.length, 1, '首次触发应通知');

    const obs2 = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    await runOnce(obs2.telemetry); // 成功 → 1/2=0.5 → recover
    await obs2.close();
    await collector.alerts!.evaluateOnce();

    const obs3 = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    const runtime3 = createRuntime({ streamFn: mockStreamFn([assistant('hello')]), telemetry: obs3.telemetry });
    await runtime3.run(createRequest('')); // 又失败 → 1/3=0.33 < 0.5 → fire again
    await obs3.close();
    await collector.alerts!.evaluateOnce();

    // 3 次状态变化（fired/recovered/fired）但冷却内只有首次通知
    const events = await getJson(baseUrl, '/api/alerts/events', token);
    assert.equal(events.body.total, 3);
    assert.equal(webhook.posts.length, 1, '冷却期内不应重复通知');
  });
});

// ─── P1 Prometheus / 限流 / 元信息 / TLS ──────────────────────────

/** POST /api/v1/ingest 并返回状态 + 响应头（供限流断言 Retry-After） */
async function postIngestWithHeaders(
  baseUrl: string,
  appId: string,
  appSecret: string,
): Promise<{ status: number; headers: Record<string, string | undefined> }> {
  const res = await fetch(`${baseUrl}/api/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-app-id': appId, 'x-app-secret': appSecret },
    body: JSON.stringify({ appId, runs: [], spans: [], toolCalls: [], permissions: [] }),
  });
  const headers: Record<string, string | undefined> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, headers };
}

describe('P1-2 Prometheus 抓取端点', () => {
  it('/metrics/prometheus：无鉴权、text/plain version=0.0.4、含全局与 per-app 指标', async () => {
    const { baseUrl, token } = await startCollector();
    const obs = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    await runOnce(obs.telemetry);
    await obs.close();

    // 无 token 直接抓取（设计上无鉴权）
    const res = await fetch(`${baseUrl}/metrics/prometheus`);
    assert.equal(res.status, 200);
    const ct = res.headers.get('content-type') || '';
    assert.match(ct, /text\/plain/);
    assert.match(ct, /version=0\.0\.4/);
    const text = await res.text();

    // 全局指标
    assert.match(text, /^# HELP aipack_requests_total .*$/m);
    assert.match(text, /^# TYPE aipack_requests_total counter$/m);
    assert.match(text, /^aipack_requests_total 1$/m, '全局窗口应有 1 次请求');
    assert.match(text, /^aipack_success_ratio 1$/m);
    assert.match(text, /^aipack_p50_ms \d+(\.\d+)?$/m);

    // per-app 标签（种子应用 test-app）
    assert.match(text, /aipack_requests_total\{app_id="test-app"\} 1/);
  });
});

describe('P1-3 ingest 限流（per-app 令牌桶）', () => {
  it('超限返回 429 + Retry-After；令牌补充后恢复 200', async () => {
    const { baseUrl } = await startCollector(
      { [APP_ID]: APP_SECRET },
      { rateLimit: { rate: 1, burst: 1 } },
    );

    // 第一次放行（桶初始满）
    const first = await postIngestWithHeaders(baseUrl, APP_ID, APP_SECRET);
    assert.equal(first.status, 200);
    // 第二次桶空 → 429 + Retry-After
    const second = await postIngestWithHeaders(baseUrl, APP_ID, APP_SECRET);
    assert.equal(second.status, 429);
    assert.equal(second.headers['retry-after'], '1');
    // 按 rate=1/s 补充 1 个令牌后恢复
    await sleep(1100);
    const third = await postIngestWithHeaders(baseUrl, APP_ID, APP_SECRET);
    assert.equal(third.status, 200);
  });

  it('限流不误伤其他应用（per-app 桶隔离）', async () => {
    const { baseUrl } = await startCollector(
      { [APP_ID]: APP_SECRET, 'app-2': 'secret-2' },
      { rateLimit: { rate: 1, burst: 1 } },
    );
    // app-1 占满自己的桶
    assert.equal((await postIngestWithHeaders(baseUrl, APP_ID, APP_SECRET)).status, 200);
    assert.equal((await postIngestWithHeaders(baseUrl, APP_ID, APP_SECRET)).status, 429);
    // app-2 不受影响
    assert.equal((await postIngestWithHeaders(baseUrl, 'app-2', 'secret-2')).status, 200);
  });
});

describe('P1-1 面板元信息 /api/meta', () => {
  it('配置 logStreamUrlTemplate 时返回模板；未配置时缺省', async () => {
    const { baseUrl, token } = await startCollector(
      { [APP_ID]: APP_SECRET },
      { logStreamUrlTemplate: 'https://loki.example.com/query?traceId=%s' },
    );
    const meta = await getJson(baseUrl, '/api/meta', token);
    assert.equal(meta.status, 200);
    assert.equal(meta.body.logStreamUrlTemplate, 'https://loki.example.com/query?traceId=%s');

    // 未配置模板的 collector → 字段缺省
    const plain = await startCollector();
    const meta2 = await getJson(plain.baseUrl, '/api/meta', plain.token);
    assert.equal(meta2.body.logStreamUrlTemplate, undefined);
  });

  it('/api/meta 需登录', async () => {
    const { baseUrl } = await startCollector();
    const res = await getJson(baseUrl, '/api/meta');
    assert.equal(res.status, 401);
  });
});

describe('P1-3 TLS（HTTPS 传输）', () => {
  it('createCollectorServer：无 tls → http；带 tls → https，且 HTTPS 上报/查询可用', async () => {
    const dbPath = tempDb();
    const collector = createCollector({ dbPath, apps: { [APP_ID]: APP_SECRET }, admin: ADMIN });

    // 无 tls → http.Server
    const plain = createCollectorServer(collector);
    assert.ok(plain instanceof http.Server);
    assert.ok(!(plain instanceof https.Server));
    await new Promise<void>((r) => plain.close(() => r()));

    // 自签证书 → https.Server（openssl 生成，macOS/Linux 自带）
    const dir = tempDir('obs-tls');
    const tls = makeSelfSignedCert(dir);
    const secured = createCollectorServer(collector, tls);
    assert.ok(secured instanceof https.Server);
    await new Promise<void>((r) => secured.listen(0, '127.0.0.1', r));
    const port = (secured.address() as AddressInfo).port;
    const baseUrl = `https://127.0.0.1:${port}`;

    // HTTPS 上报（自签证书 → rejectUnauthorized: false）
    const ingest = await httpsRequestJson(baseUrl, '/api/v1/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-app-id': APP_ID,
        'x-app-secret': APP_SECRET,
      },
      body: JSON.stringify({ appId: APP_ID, runs: [], spans: [], toolCalls: [], permissions: [] }),
    });
    assert.equal(ingest.status, 200, 'HTTPS ingest 应成功');

    // HTTPS 查询（面板登录 + summary）
    const login = await httpsRequestJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ADMIN),
    });
    assert.equal(login.status, 200);
    const summary = await httpsRequestJson(baseUrl, '/metrics/summary', {
      headers: { authorization: `Bearer ${login.body.token}` },
    });
    assert.equal(summary.status, 200);

    cleanup.push(async () => {
      await new Promise<void>((r) => secured.close(() => r()));
      await collector.close();
    });
  });
});

// ─── P1 测试辅助（openssl 自签证书 / HTTPS 请求）──────────────────

function makeSelfSignedCert(dir: string): { key: Buffer; cert: Buffer } {
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost'],
    { stdio: 'pipe' },
  );
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

function httpsRequestJson(
  baseUrl: string,
  urlPath: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      baseUrl + urlPath,
      {
        method: opts.method ?? 'GET',
        headers: opts.headers,
        rejectUnauthorized: false, // 自签证书仅用于测试
      },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => (raw += c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
