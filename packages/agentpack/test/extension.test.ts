/**
 * extension 模块测试：LoggingExtension / EventCaptureExtension /
 * RequestInterceptorExtension / ResultPostProcessorExtension /
 * SharedStateExtension / createDefaultExtensions / createExtensionManager
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  LoggingExtension,
  EventCaptureExtension,
  RequestInterceptorExtension,
  ResultPostProcessorExtension,
  SharedStateExtension,
  createDefaultExtensions,
  createExtensionManager,
} from '../extension/index.ts';
import { ExtensionManager } from '../core/index.ts';
import type { RuntimeHooks, ExtensionContext, Request, Result } from '../core/index.ts';
import { createRequest } from '../core/index.ts';

function makeHooks(): RuntimeHooks {
  return new ExtensionManager().getHooks();
}

function makeCtx(): ExtensionContext {
  return {
    config: {},
    workspace: '/tmp',
    sessionKey: 'test',
    shared: new Map(),
  };
}

// ─── LoggingExtension ──────────────────────────────────────────────

describe('LoggingExtension', () => {
  it('注册到 beforeInitialize / beforeRun / done / failed', () => {
    const hooks = makeHooks();
    const ext = new LoggingExtension(false);
    ext.apply(hooks, makeCtx());
    assert.equal(hooks.beforeInitialize.isUsed(), true);
    assert.equal(hooks.beforeRun.isUsed(), true);
    assert.equal(hooks.done.isUsed(), true);
    assert.equal(hooks.failed.isUsed(), true);
  });

  it('done 钩子被调用时不抛错', async () => {
    const hooks = makeHooks();
    new LoggingExtension(false).apply(hooks, makeCtx());
    const result: Result = {
      content: 'hi',
      toolsUsed: ['t'],
      usage: {},
      stopReason: 'stop',
      metadata: {},
      success: true,
    };
    await hooks.done.promise(result);
  });

  it('failed 钩子被调用时不抛错', async () => {
    const hooks = makeHooks();
    new LoggingExtension(false).apply(hooks, makeCtx());
    await hooks.failed.promise(new Error('test'), createRequest('hi'));
  });
});

// ─── EventCaptureExtension ─────────────────────────────────────────

describe('EventCaptureExtension', () => {
  it('捕获所有钩子事件', async () => {
    const hooks = makeHooks();
    const ext = new EventCaptureExtension();
    ext.apply(hooks, makeCtx());
    const req = createRequest('hi', { sessionKey: 'ec1' });
    await hooks.beforeInitialize.promise(req);
    await hooks.afterInitialize.promise(req);
    await hooks.beforeRun.promise(req);
    const events = ext.getEvents();
    assert.ok(events.length >= 3);
    assert.ok(events.some(e => e.hook === 'beforeInitialize'));
    assert.ok(events.some(e => e.hook === 'afterInitialize'));
    assert.ok(events.some(e => e.hook === 'beforeRun'));
  });

  it('clearEvents 清空事件', async () => {
    const hooks = makeHooks();
    const ext = new EventCaptureExtension();
    ext.apply(hooks, makeCtx());
    await hooks.beforeInitialize.promise(createRequest('hi'));
    assert.ok(ext.getEvents().length > 0);
    ext.clearEvents();
    assert.equal(ext.getEvents().length, 0);
  });

  it('事件上限 maxEvents', async () => {
    const hooks = makeHooks();
    const ext = new EventCaptureExtension(5);
    ext.apply(hooks, makeCtx());
    for (let i = 0; i < 20; i++) {
      await hooks.beforeInitialize.promise(createRequest(`hi${i}`));
    }
    assert.equal(ext.getEvents().length, 5);
  });

  it('maxEvents 最小为 1', () => {
    const ext = new EventCaptureExtension(0);
    assert.ok(ext instanceof EventCaptureExtension);
  });

  it('getEvents 返回拷贝', async () => {
    const hooks = makeHooks();
    const ext = new EventCaptureExtension();
    ext.apply(hooks, makeCtx());
    await hooks.beforeInitialize.promise(createRequest('hi'));
    const events1 = ext.getEvents();
    events1.push({ hook: 'injected', timestamp: 0 });
    const events2 = ext.getEvents();
    assert.equal(events2.length, 1);
  });

  it('捕获 beforeTransform / afterTransform', async () => {
    const hooks = makeHooks();
    const ext = new EventCaptureExtension();
    ext.apply(hooks, makeCtx());
    const resources = [];
    await hooks.beforeTransform.promise(resources);
    await hooks.afterTransform.promise(resources);
    const events = ext.getEvents();
    assert.ok(events.some(e => e.hook === 'beforeTransform'));
    assert.ok(events.some(e => e.hook === 'afterTransform'));
  });
});

// ─── RequestInterceptorExtension ───────────────────────────────────

describe('RequestInterceptorExtension', () => {
  it('beforeRun 调用 interceptor', async () => {
    const hooks = makeHooks();
    const ext = new RequestInterceptorExtension(async (req) => {
      return createRequest(req.message + ' [modified]', { sessionKey: req.sessionKey });
    });
    ext.apply(hooks, makeCtx());
    const result = await hooks.beforeRun.promise(createRequest('original', { sessionKey: 'ri1' }));
    assert.equal(result.message, 'original [modified]');
  });
});

// ─── ResultPostProcessorExtension ──────────────────────────────────

describe('ResultPostProcessorExtension', () => {
  it('done 钩子调用 processor', async () => {
    const hooks = makeHooks();
    let processed: Result | null = null;
    const ext = new ResultPostProcessorExtension(async (result) => {
      processed = result;
    });
    ext.apply(hooks, makeCtx());
    const result: Result = {
      content: 'done',
      toolsUsed: [],
      usage: {},
      stopReason: 'stop',
      metadata: {},
      success: true,
    };
    await hooks.done.promise(result);
    assert.ok(processed);
    assert.equal(processed!.content, 'done');
  });
});

// ─── SharedStateExtension ──────────────────────────────────────────

describe('SharedStateExtension', () => {
  it('set / get 管理共享状态', () => {
    const ext = new SharedStateExtension();
    ext.set('key1', 'value1');
    assert.equal(ext.get('key1'), 'value1');
  });

  it('apply 时将状态注入到 context.shared', () => {
    const ext = new SharedStateExtension(new Map([['injected', true]]));
    const ctx = makeCtx();
    ext.apply(makeHooks(), ctx);
    assert.equal(ctx.shared.get('injected'), true);
  });

  it('done 钩子从 shared 读取 result_data 写入 metadata', async () => {
    const hooks = makeHooks();
    const ext = new SharedStateExtension();
    const ctx = makeCtx();
    ext.apply(hooks, ctx);
    ctx.shared.set('result_data', 'shared-value');
    const result: Result = {
      content: '',
      toolsUsed: [],
      usage: {},
      stopReason: 'stop',
      metadata: {},
      success: true,
    };
    await hooks.done.promise(result);
    assert.equal((result.metadata as any).sharedState, 'shared-value');
  });

  it('无 result_data 时不写入 metadata', async () => {
    const hooks = makeHooks();
    const ext = new SharedStateExtension();
    ext.apply(hooks, makeCtx());
    const result: Result = {
      content: '',
      toolsUsed: [],
      usage: {},
      stopReason: 'stop',
      metadata: {},
      success: true,
    };
    await hooks.done.promise(result);
    assert.equal((result.metadata as any).sharedState, undefined);
  });
});

// ─── createDefaultExtensions ───────────────────────────────────────

describe('createDefaultExtensions', () => {
  it('返回包含 LoggingExtension 的数组', () => {
    const exts = createDefaultExtensions();
    assert.ok(exts.length > 0);
    assert.ok(exts.some(e => e.name === 'logging'));
  });

  it('verbose 选项传递给 LoggingExtension', () => {
    const exts = createDefaultExtensions({ verbose: true });
    const logging = exts.find(e => e.name === 'logging');
    assert.ok(logging);
  });
});

// ─── createExtensionManager ────────────────────────────────────────

describe('createExtensionManager', () => {
  it('返回包含默认扩展的 manager', () => {
    const mgr = createExtensionManager();
    const exts = mgr.getExtensions();
    assert.ok(exts.some(e => e.name === 'logging'));
  });

  it('注册额外扩展', () => {
    const mgr = createExtensionManager({
      extensions: [new EventCaptureExtension()],
    });
    const exts = mgr.getExtensions();
    assert.ok(exts.some(e => e.name === 'event-capture'));
  });
});
