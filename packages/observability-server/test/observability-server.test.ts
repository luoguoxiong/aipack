/**
 * 收集服务端到端验收（@aipack/observability-server，observability-s2.md §9）：
 * 起真实收集服务（createCollector + http server）→ SDK 埋点上报 → 查询 /metrics、/traces 断言。
 * 附加用例：鉴权失败丢弃、上报失败本地缓存补报。
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRuntime, createRequest } from '@aipack/agent';
import type { StreamFn, StreamEvent, Message, AssistantMessage, Tool } from '@aipack/agent';
import { createObservability, HttpReporter, ObservabilityTelemetry } from '@aipack/observability';
import type { EventBatch } from '@aipack/observability';
import { createCollector, SQLiteStore } from '../src/index';

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

/** 启动真实收集服务，返回 baseUrl + 面板 token + dbPath */
async function startCollector(
  apps: Record<string, string> = { [APP_ID]: APP_SECRET },
): Promise<{
  baseUrl: string;
  dbPath: string;
  token: string;
}> {
  const dbPath = tempDb();
  const collector = createCollector({ dbPath, apps, admin: ADMIN });
  const server = http.createServer((req, res) => void collector.handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  cleanup.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await collector.close();
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = await login(baseUrl);
  return { baseUrl, dbPath, token };
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
