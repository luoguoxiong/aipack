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
import { HttpReporter, ObservabilityTelemetry } from '../src/index';
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

const emptyBatch = (): EventBatch => ({ runs: [], spans: [], toolCalls: [], permissions: [] });

function sampleBatch(): EventBatch {
  return {
    runs: [
      {
        traceId: 't1', startedAt: 1, endedAt: 2, sessionKey: 's', channel: 'test',
        status: 'success', turns: 1, durationMs: 10, activeMs: 10, queuedMs: 0,
        inputTokens: 1, outputTokens: 1,
      } as RunRecord,
    ],
    spans: [], toolCalls: [], permissions: [],
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
});
