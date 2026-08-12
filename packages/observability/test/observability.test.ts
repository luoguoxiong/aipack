/**
 * 上报 SDK 测试（@aipack/observability）：
 *  - HttpReporter：上报成功/失败分级（5xx 缓存、4xx 丢弃）/ 补报 / 裁剪，用 mock fetch
 *  - ObservabilityTelemetry：事件 → 原始记录转换 + 批量上报
 * 端到端（真实收集服务）见 @aipack/observability-server 的测试。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HttpReporter, ObservabilityTelemetry, createLogger, toOtlpJsonTraces, createOtlpTraceExporter } from '../src/index';
import type { EventBatch, RunRecord } from '../src/types';

const APP_ID = 'test-app';
const APP_SECRET = 's3cret';

function tempDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function mockFetch(status: number): { fetch: typeof fetch; calls: Array<{ url: string; headers: any; body: any }> } {
  const calls: Array<{ url: string; headers: any; body: any }> = [];
  const impl = async (url: unknown, init?: any): Promise<Response> => {
    calls.push({
      url: String(url),
      headers: init?.headers,
      body: JSON.parse(init?.body ?? '{}'),
    });
    return { ok: status >= 200 && status < 300, status } as Response;
  };
  const fetchImpl: typeof globalThis.fetch = impl as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

const emptyBatch = (): EventBatch => ({
  runs: [],
  spans: [],
  toolCalls: [],
  permissions: [],
  retries: [],
  events: [],
});

function sampleBatch(): EventBatch {
  return {
    runs: [
      {
        traceId: 't1', startedAt: 1, endedAt: 2, sessionKey: 's', channel: 'test',
        status: 'success', turns: 1, durationMs: 10, activeMs: 10, queuedMs: 0,
        inputTokens: 1, outputTokens: 1,
      } as RunRecord,
    ],
    spans: [], toolCalls: [], permissions: [], retries: [], events: [],
  };
}

describe('HttpReporter', () => {
  it('上报成功：POST /api/v1/ingest，携带鉴权头与批量 body，返回 true', async () => {
    const { fetch, calls } = mockFetch(200);
    const reporter = new HttpReporter({
      endpoint: 'http://collector.local', appId: APP_ID, appSecret: APP_SECRET,
      cacheDir: tempDir('obs-cache'), fetchImpl: fetch,
    });
    const ok = await reporter.send(sampleBatch());

    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://collector.local/api/v1/ingest');
    assert.equal(calls[0].headers['x-app-id'], APP_ID);
    assert.equal(calls[0].headers['x-app-secret'], APP_SECRET);
    assert.equal(calls[0].body.appId, APP_ID);
    assert.equal(calls[0].body.runs.length, 1);
  });

  it('5xx 失败：写本地缓存，返回 false；4xx 拒绝：丢弃且不缓存', async () => {
    // 5xx → 可重试 → 缓存
    const cacheDir = tempDir('obs-cache');
    const r1 = new HttpReporter({
      endpoint: 'http://collector.local', appId: APP_ID, appSecret: APP_SECRET,
      cacheDir, fetchImpl: mockFetch(503).fetch,
    });
    assert.equal(await r1.send(sampleBatch()), false);
    assert.ok(fs.existsSync(path.join(cacheDir, `${APP_ID}.json`)), '5xx 应写缓存');

    // 4xx → 丢弃 → 不缓存（返回 true，视为已处理）
    const cacheDir2 = tempDir('obs-cache');
    const r2 = new HttpReporter({
      endpoint: 'http://collector.local', appId: APP_ID, appSecret: APP_SECRET,
      cacheDir: cacheDir2, fetchImpl: mockFetch(401).fetch,
    });
    assert.equal(await r2.send(sampleBatch()), true);
    assert.ok(!fs.existsSync(path.join(cacheDir2, `${APP_ID}.json`)), '4xx 不应写缓存');
  });

  it('缓存补报：失败落缓存后，下次 send 先补报缓存并删除', async () => {
    const cacheDir = tempDir('obs-cache');
    const failFetch = mockFetch(503);
    const r1 = new HttpReporter({
      endpoint: 'http://collector.local', appId: APP_ID, appSecret: APP_SECRET,
      cacheDir, fetchImpl: failFetch.fetch,
    });
    await r1.send(sampleBatch());
    assert.ok(fs.existsSync(path.join(cacheDir, `${APP_ID}.json`)));

    // 收集服务恢复：同一 cacheDir 的新 reporter，首次 send 即补报缓存
    const okFetch = mockFetch(200);
    const r2 = new HttpReporter({
      endpoint: 'http://collector.local', appId: APP_ID, appSecret: APP_SECRET,
      cacheDir, fetchImpl: okFetch.fetch,
    });
    const ok = await r2.send(emptyBatch());
    assert.equal(ok, true);
    assert.equal(okFetch.calls.length, 1, '空批次也应先补报缓存');
    assert.equal(okFetch.calls[0].body.runs.length, 1, '缓存中的 run 应被补报');
    assert.ok(!fs.existsSync(path.join(cacheDir, `${APP_ID}.json`)), '补报成功后缓存应删除');
  });

  it('缓存裁剪：超过 maxCacheSize 保留最新记录', async () => {
    const cacheDir = tempDir('obs-cache');
    const reporter = new HttpReporter({
      endpoint: 'http://collector.local', appId: APP_ID, appSecret: APP_SECRET,
      cacheDir, maxCacheSize: 5, fetchImpl: mockFetch(503).fetch,
    });
    await reporter.send({
      ...emptyBatch(),
      runs: Array.from({ length: 10 }, (_, i) => ({ traceId: `t${i}` })) as RunRecord[],
    });

    const raw = JSON.parse(fs.readFileSync(path.join(cacheDir, `${APP_ID}.json`), 'utf8'));
    assert.equal(raw.runs.length, 5, '缓存应裁剪到 maxCacheSize');
    assert.equal(raw.runs[0].traceId, 't5', '丢弃最旧 5 条，保留最新');
  });

  it('P2 合并批次保留 retries/events：pending 队列多批合并不丢新字段', async () => {
    const { fetch, calls } = mockFetch(200);
    const reporter = new HttpReporter({
      endpoint: 'http://collector.local', appId: APP_ID, appSecret: APP_SECRET,
      cacheDir: tempDir('obs-cache'), fetchImpl: fetch,
    });
    const batch: EventBatch = {
      ...emptyBatch(),
      retries: [{ traceId: 't1', provider: 'p', modelId: 'm', attempt: 1, delayMs: 10, timestamp: 1 }],
      events: [{ traceId: 't1', name: 'evt', data: { a: 1 }, timestamp: 1 }],
    };
    // 并发两次 send：第二次被串行锁吸收（返回 false 但数据合入第一轮 drain）
    const [ok1] = await Promise.all([reporter.send(batch), reporter.send(emptyBatch())]);
    assert.equal(ok1, true);
    assert.equal(calls.length, 1, '两批应合并为一次上报');
    assert.equal(calls[0].body.retries.length, 1, '合并批次应保留 retries');
    assert.equal(calls[0].body.events.length, 1, '合并批次应保留 events');
  });
});

describe('ObservabilityTelemetry', () => {
  it('onRunEnd → 1 run + 1 run span，flush 批量上报', async () => {
    const { fetch, calls } = mockFetch(200);
    const reporter = { send: async (b: EventBatch) => fetch('http://x', { method: 'POST', headers: {}, body: JSON.stringify({ ...b }) }) as any };
    const telemetry = new ObservabilityTelemetry(reporter as any, { intervalMs: 10 ** 9 });

    telemetry.onRunStart({ traceId: 't1', queuedAt: 1000 } as any);
    telemetry.onRunEnd({
      traceId: 't1', sessionKey: 's', durationMs: 20, success: true,
      turnCount: 2, request: { channel: 'test', model: 'm1' },
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    } as any);
    await telemetry.close();

    assert.equal(calls.length, 1);
    const body = calls[0].body;
    assert.equal(body.runs.length, 1);
    assert.equal(body.runs[0].traceId, 't1');
    assert.equal(body.runs[0].status, 'success');
    assert.equal(body.runs[0].turns, 2);
    assert.equal(body.spans.length, 1);
    assert.equal(body.spans[0].kind, 'run');
    assert.equal(body.spans[0].sessionKey, 's');
    assert.equal(body.spans[0].startedAt, 1000, 'run 级 startedAt 用 queuedAt');
  });

  it('权限拦截 → PermissionRecord 上报', async () => {
    const { fetch, calls } = mockFetch(200);
    const reporter = { send: async (b: EventBatch) => fetch('http://x', { method: 'POST', headers: {}, body: JSON.stringify({ ...b }) }) as any };
    const telemetry = new ObservabilityTelemetry(reporter as any, { intervalMs: 10 ** 9 });

    telemetry.onPermissionDenied({
      traceId: 't1', sessionKey: 's', toolName: 'echo', reason: 'deny',
    } as any);
    await telemetry.close();

    assert.equal(calls[0].body.permissions.length, 1);
    assert.equal(calls[0].body.permissions[0].toolName, 'echo');
  });

  // ─── P2-1 自定义事件 / 明细采样 / 脱敏 ───────────────────────────

  it('P2-1 emit：run 内自动注入 traceId，事件随批次上报', async () => {
    const { fetch, calls } = mockFetch(200);
    const reporter = { send: async (b: EventBatch) => fetch('http://x', { method: 'POST', headers: {}, body: JSON.stringify({ ...b }) }) as any };
    const telemetry = new ObservabilityTelemetry(reporter as any, { intervalMs: 10 ** 9 });

    telemetry.onRunStart({ traceId: 't1', queuedAt: 1000 } as any);
    telemetry.emit('agent.start', { step: 1 });
    telemetry.emit('tool.selected', { tool: 'echo' });
    await telemetry.close();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.events.length, 2);
    assert.equal(calls[0].body.events[0].name, 'agent.start');
    assert.equal(calls[0].body.events[0].traceId, 't1', 'run 内 emit 应自动注入 traceId');
    assert.deepEqual(calls[0].body.events[0].data, { step: 1 });
    assert.equal(calls[0].body.events[1].name, 'tool.selected');
  });

  it('P2-1 明细采样：sampleRate=0 时 model/tool spans 与 toolCalls 丢弃，run 全量保留', async () => {
    const { fetch, calls } = mockFetch(200);
    const reporter = { send: async (b: EventBatch) => fetch('http://x', { method: 'POST', headers: {}, body: JSON.stringify({ ...b }) }) as any };
    const telemetry = new ObservabilityTelemetry(reporter as any, { intervalMs: 10 ** 9, sampleRate: 0 });

    telemetry.onRunEnd({
      traceId: 't1', sessionKey: 's', durationMs: 20, success: true,
      turnCount: 2, request: { channel: 'test', model: 'm1' },
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    } as any);
    telemetry.onModelCall({ traceId: 't1', spanId: 'm1', modelId: 'm1', durationMs: 5, status: 'ok', attempts: 1, inputTokens: 1, outputTokens: 1 } as any);
    telemetry.onToolCall({ traceId: 't1', spanId: 'c1', toolName: 'echo', status: 'ok', durationMs: 3 } as any);
    await telemetry.close();

    assert.equal(calls[0].body.runs.length, 1, 'run 不受采样影响');
    assert.equal(calls[0].body.spans.length, 1, '仅 run span，model/tool span 被采样丢弃');
    assert.equal(calls[0].body.spans[0].kind, 'run');
    assert.equal(calls[0].body.toolCalls.length, 0, 'toolCalls 被采样丢弃');
  });

  it('P2-1 脱敏钩子：redact 在 send 前改写批次（PII 防护）', async () => {
    const { fetch, calls } = mockFetch(200);
    const reporter = { send: async (b: EventBatch) => fetch('http://x', { method: 'POST', headers: {}, body: JSON.stringify({ ...b }) }) as any };
    const telemetry = new ObservabilityTelemetry(reporter as any, {
      intervalMs: 10 ** 9,
      redact: (batch) => ({
        ...batch,
        events: batch.events.map((e) =>
          e.name === 'user.input' ? { ...e, data: { text: '***' } } : e,
        ),
      }),
    });

    telemetry.onRunStart({ traceId: 't1', queuedAt: 1000 } as any);
    telemetry.emit('user.input', { text: '我的银行卡号是 6222...' });
    await telemetry.close();

    assert.equal(calls[0].body.events[0].data.text, '***', '敏感事件数据应被脱敏钩子改写');
  });

  // ─── P2-2 per-attempt 重试明细 ───────────────────────────────────

  it('P2-2 onRetry：RetryRecord 入队并随批次上报（含 spanId/status/delayMs）', async () => {
    const { fetch, calls } = mockFetch(200);
    const reporter = { send: async (b: EventBatch) => fetch('http://x', { method: 'POST', headers: {}, body: JSON.stringify({ ...b }) }) as any };
    const telemetry = new ObservabilityTelemetry(reporter as any, { intervalMs: 10 ** 9 });

    telemetry.onRetry({
      traceId: 't1', spanId: 'm1', provider: 'deepseek', modelId: 'deepseek-chat',
      attempt: 2, errorClass: 'rate-limit', status: 429, delayMs: 1500,
    } as any);
    await telemetry.close();

    assert.equal(calls[0].body.retries.length, 1);
    const r = calls[0].body.retries[0];
    assert.equal(r.traceId, 't1');
    assert.equal(r.spanId, 'm1');
    assert.equal(r.modelId, 'deepseek-chat');
    assert.equal(r.attempt, 2);
    assert.equal(r.status, 429);
    assert.equal(r.delayMs, 1500);
    assert.equal(typeof r.timestamp, 'number');
  });
});

// ─── P1-1 结构化 logger（日志关联）─────────────────────────────────

/** 收集 logger 输出行 */
function captureLogger(opts: Parameters<typeof createLogger>[0] = {}): {
  logger: ReturnType<typeof createLogger>;
  lines: string[];
} {
  const lines: string[] = [];
  const logger = createLogger({ ...opts, dest: (l) => lines.push(l) });
  return { logger, lines };
}

describe('createLogger 结构化日志', () => {
  it('logfmt：含 time/level/msg + tags；fields 覆盖同名 tags', () => {
    const { logger, lines } = captureLogger({ tags: { app: 'demo', env: 'test' } });
    logger.info('hello', { env: 'prod', tool: 'echo' });

    assert.equal(lines.length, 1);
    const line = lines[0];
    assert.match(line, /^time=\S+ level=info msg=hello /);
    assert.match(line, / app=demo /);
    assert.match(line, / env=prod /, 'fields 应覆盖同名 tags');
    assert.match(line, / tool=echo/);
  });

  it('json：可 JSON.parse，字段结构完整', () => {
    const { logger, lines } = captureLogger({ format: 'json', tags: { app: 'demo' } });
    logger.error('boom', { err: 'x' });

    const obj = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(obj.level, 'error');
    assert.equal(obj.msg, 'boom');
    assert.equal(obj.app, 'demo');
    assert.equal(obj.err, 'x');
  });

  it('脱敏：secret/token/password/authorization 等字段值打码为 ***', () => {
    const { logger, lines } = captureLogger({ format: 'json' });
    logger.info('auth', { apiKey: 'sk-123', token: 't', password: 'p', safe: 'ok' });

    const obj = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(obj.apiKey, '***');
    assert.equal(obj.token, '***');
    assert.equal(obj.password, '***');
    assert.equal(obj.safe, 'ok');
  });

  it('context 动态注入：traceId 出现在日志行（日志关联核心）', () => {
    let traceId: string | undefined;
    const { logger, lines } = captureLogger({
      context: () => (traceId ? { traceId } : {}),
    });
    traceId = 't-abc';
    logger.warn('rate limited', { retryInMs: 100 });
    traceId = undefined;
    logger.info('no trace');

    assert.match(lines[0], / traceId=t-abc /, 'in-flight traceId 应注入日志行');
    assert.ok(!lines[1].includes('traceId'), '无 in-flight run 时不应有 traceId 字段');
  });

  it('level 过滤：level=error 时 info/warn 不输出', () => {
    const { logger, lines } = captureLogger({ level: 'error' });
    logger.info('a');
    logger.warn('b');
    logger.error('c');
    assert.equal(lines.length, 1);
    assert.match(lines[0], / level=error msg=c$/);
  });

  it('child 派生：合并 tags，保留父级格式', () => {
    const { logger, lines } = captureLogger({ tags: { app: 'demo' } });
    const child = logger.child({ tags: { env: 'prod' } });
    child.info('hi');

    assert.match(lines[0], / app=demo /);
    assert.match(lines[0], / env=prod$/);
  });
});

// ─── P1-2 currentContext（logger 关联的数据源）──────────────────────

describe('ObservabilityTelemetry.currentContext', () => {
  it('onRunStart 后返回该 traceId；并发取最近开始；onRunEnd 移除', async () => {
    const reporter = { send: async () => true };
    const telemetry = new ObservabilityTelemetry(reporter, { intervalMs: 10 ** 9 });

    telemetry.onRunStart({ traceId: 't1', queuedAt: 1 } as any);
    assert.deepEqual(telemetry.currentContext(), { traceId: 't1' });

    telemetry.onRunStart({ traceId: 't2', queuedAt: 2 } as any);
    assert.deepEqual(telemetry.currentContext(), { traceId: 't2' }, '并发时取最近开始的 run');

    // onRunEnd 会构造 RunRecord（访问 request/tokens），需完整 info
    const fullInfo = {
      sessionKey: 's', durationMs: 10, success: true, turnCount: 1,
      request: { channel: 'test', model: 'm1' },
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    telemetry.onRunEnd({ traceId: 't2', ...fullInfo } as any);
    assert.deepEqual(telemetry.currentContext(), { traceId: 't1' });

    telemetry.onRunEnd({ traceId: 't1', ...fullInfo } as any);
    assert.deepEqual(telemetry.currentContext(), {}, '全部结束后返回空');
    await telemetry.close();
  });

  it('createObservability 的 logger 与 telemetry 联动：run 内输出含 traceId', async () => {
    const { fetch, calls } = mockFetch(200);
    const reporter = { send: async (b: EventBatch) => fetch('http://x', { method: 'POST', headers: {}, body: JSON.stringify({ ...b }) }) as any };
    const telemetry = new ObservabilityTelemetry(reporter, { intervalMs: 10 ** 9 });
    const lines: string[] = [];
    const logger = createLogger({ context: () => telemetry.currentContext(), dest: (l) => lines.push(l) });

    telemetry.onRunStart({ traceId: 't-trace', queuedAt: 1000 } as any);
    logger.info('step', { tool: 'echo' });
    assert.match(lines[0], / traceId=t-trace /, 'run 进行中的日志应带 traceId');

    telemetry.onRunEnd({ traceId: 't-trace', sessionKey: 's', durationMs: 10, success: true, turnCount: 1, request: {}, tokens: { input: 0, output: 0 } } as any);
    logger.info('after');
    assert.ok(!lines[1].includes('traceId'), 'run 结束后日志不应带 traceId');
    await telemetry.close();
  });
});

// ─── P1-2 OTLP/JSON trace exporter ─────────────────────────────────

function sampleOtlpBatch(): EventBatch {
  return {
    runs: [
      {
        traceId: 't-otlp', startedAt: 1000, endedAt: 1100, sessionKey: 's', model: 'm1',
        status: 'error', errorClass: 'timeout', turns: 2, durationMs: 100,
        activeMs: 90, queuedMs: 10, inputTokens: 10, outputTokens: 5, costUsd: 0.001,
      } as RunRecord,
    ],
    spans: [
      {
        traceId: 't-otlp', spanId: 'span-1', kind: 'model', name: 'model:m1',
        startedAt: 1000, durationMs: 80, status: 'ok', attempts: 1,
        inputTokens: 10, outputTokens: 5, costUsd: 0.001, sessionKey: 's',
      },
    ],
    toolCalls: [],
    permissions: [],
    retries: [],
    events: [],
  };
}

describe('toOtlpJsonTraces', () => {
  it('结构：resourceSpans → scopeSpans → spans，service.name 与 app 标签正确', () => {
    const json = toOtlpJsonTraces(sampleOtlpBatch(), 'demo-svc', 'app-x') as any;

    assert.equal(json.resourceSpans.length, 1);
    const rs = json.resourceSpans[0];
    const resourceAttrs = Object.fromEntries(
      rs.resource.attributes.map((a: any) => [a.key, a.value]),
    );
    assert.equal(resourceAttrs['service.name'].stringValue, 'demo-svc');
    assert.equal(resourceAttrs['telemetry.sdk.name'].stringValue, 'aipack');

    const spans = rs.scopeSpans[0].spans;
    assert.equal(spans.length, 2, '1 run + 1 span → 2 个 OTLP span');
    const run = spans[0];
    // traceId 是 16 字节 base64
    assert.equal(Buffer.from(run.traceId, 'base64').length, 16);
    assert.equal(Buffer.from(run.spanId, 'base64').length, 8);
    // 时间戳为纳秒字符串（BigInt）
    assert.equal(run.startTimeUnixNano, (1000 * 1_000_000).toString());
    assert.equal(run.endTimeUnixNano, (1100 * 1_000_000).toString());
    // 失败 run → status code 2 + message
    assert.equal(run.status.code, 2);
    assert.equal(run.status.message, 'timeout');
    const runAttrs = Object.fromEntries(run.attributes.map((a: any) => [a.key, a.value]));
    assert.equal(runAttrs['aipack.app'].stringValue, 'app-x');
    assert.equal(runAttrs['model'].stringValue, 'm1');
    assert.equal(runAttrs['tokens.input'].intValue, '10');
    assert.equal(runAttrs['cost.usd'].doubleValue, 0.001);

    // span kind=model
    const model = spans[1];
    assert.equal(model.name, 'model:m1');
    assert.equal(model.status.code, 1, '成功 span → ok');
    assert.equal(Buffer.from(model.traceId, 'base64').length, 16);
    assert.equal(Buffer.from(model.spanId, 'base64').length, 8);
  });

  it('确定性：同一 traceId 恒映射为同一 16 字节 base64', () => {
    const a = toOtlpJsonTraces(sampleOtlpBatch(), 'svc') as any;
    const b = toOtlpJsonTraces(sampleOtlpBatch(), 'svc') as any;
    assert.equal(a.resourceSpans[0].scopeSpans[0].spans[0].traceId, b.resourceSpans[0].scopeSpans[0].spans[0].traceId);
  });
});

describe('createOtlpTraceExporter', () => {
  it('export：POST {endpoint}/v1/traces，content-type json，body 为 OTLP JSON', async () => {
    const { fetch, calls } = mockFetch(200);
    const exporter = createOtlpTraceExporter({
      endpoint: 'http://otel:4318/',
      serviceName: 'svc',
      appId: 'app-x',
      headers: { 'x-otlp-token': 'tok' },
      fetchImpl: fetch as typeof globalThis.fetch,
    });

    const ok = await exporter.export(sampleOtlpBatch());
    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://otel:4318/v1/traces', '末尾斜杠应归一');
    assert.equal(calls[0].headers['content-type'], 'application/json');
    assert.equal(calls[0].headers['x-otlp-token'], 'tok');
    assert.equal(calls[0].body.resourceSpans.length, 1);
  });

  it('export 失败/被拒：返回 false 且不抛错（旁路不影响主上报）', async () => {
    const exporter = createOtlpTraceExporter({
      endpoint: 'http://otel:4318',
      fetchImpl: (async () => ({ ok: false, status: 429 }) as Response) as typeof fetch,
    });
    assert.equal(await exporter.export(sampleOtlpBatch()), false);

    const throwing = createOtlpTraceExporter({
      endpoint: 'http://otel:4318',
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
    });
    assert.equal(await throwing.export(sampleOtlpBatch()), false, '网络异常应被内部消化');
  });

  it('export 纯 tool/permission 批次：无 trace 数据 → 不发请求直接 true', async () => {
    const { fetch, calls } = mockFetch(200);
    const exporter = createOtlpTraceExporter({
      endpoint: 'http://otel:4318',
      fetchImpl: fetch as typeof globalThis.fetch,
    });
    assert.equal(await exporter.export({ runs: [], spans: [], toolCalls: [{} as never], permissions: [], retries: [], events: [] }), true);
    assert.equal(calls.length, 0);
  });
});
