/**
 * PermissionPolicy 框架级权限层测试：
 * - 内置策略单元：createPermissionPolicy / createAllowListPolicy / denyAll / allowAll / hasPermission
 * - Runtime 集成：deny → blocked 结果、confirm 批准/拒绝、未配置放行、流式同样生效、
 *   telemetry onPermissionDenied 上报、工具 permissions 声明传递
 * - 异步审批（pending 决策 + ApprovalManager）：挂起/批准/驳回/超时/取消/abort 传导/遥测
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPermissionPolicy,
  createAllowListPolicy,
  createDenyAllPolicy,
  createAllowAllPolicy,
  hasPermission,
  createApprovalManager,
  createRuntime,
} from '../index.ts';
import type {
  StreamFn,
  StreamEvent,
  AssistantMessage,
  Tool,
} from '../core/index.ts';
import type { ApprovalManager, PendingApproval } from '../core/index.ts';

// ─── 工具调用流：第一次返回带 toolCall 的 assistant，第二次返回纯文本 ──

function mockToolStreamFn(toolCalls: Array<{ id: string; name: string; args: unknown }>): StreamFn {
  return async function* (): AsyncGenerator<StreamEvent> {
    if (toolCalls.length > 0) {
      const tc = toolCalls.shift()!;
      const assistant: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'toolCall', id: tc.id, name: tc.name, arguments: tc.args as Record<string, unknown> }],
        stopReason: 'toolUse',
        usage: { input: 10, output: 5, total: 15 },
        timestamp: Date.now(),
      };
      yield { type: 'done', message: assistant };
    } else {
      const assistant: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'stop',
        usage: { input: 10, output: 5, total: 15 },
        timestamp: Date.now(),
      };
      yield { type: 'done', message: assistant };
    }
  };
}

// 记录是否真实执行的测试工具
function makeProbeTool(name: string, permissions?: string[]): Tool & { calls: () => number } {
  let count = 0;
  return {
    name,
    description: name,
    permissions,
    parameters: {},
    async execute() {
      count++;
      return { content: [{ type: 'text', text: 'ok' }], details: {} };
    },
    calls: () => count,
  };
}

// ─── 内置策略单元测试 ─────────────────────────────────────────────

describe('PermissionPolicy 内置策略', () => {
  it('createDenyAllPolicy 拒绝一切', async () => {
    const p = createDenyAllPolicy();
    const req = {
      toolName: 'x',
      permissions: [],
      args: {},
      sessionKey: 's',
      request: {} as never,
      shared: new Map(),
    };
    assert.equal(await p.check(req), 'deny');
  });

  it('createAllowAllPolicy 放行一切', async () => {
    const p = createAllowAllPolicy();
    assert.equal(
      await p.check({
        toolName: 'x',
        permissions: [],
        args: {},
        sessionKey: 's',
        request: {} as never,
        shared: new Map(),
      }),
      'allow',
    );
  });

  it('createAllowListPolicy 白名单放行 / 其余 deny', async () => {
    const p = createAllowListPolicy({ allow: ['safe_tool'] });
    const base = {
      permissions: [],
      args: {},
      sessionKey: 's',
      request: {} as never,
      shared: new Map(),
    };
    assert.equal(await p.check({ ...base, toolName: 'safe_tool' }), 'allow');
    assert.equal(await p.check({ ...base, toolName: 'other' }), 'deny');
  });

  it('createAllowListPolicy 白名单外走 confirm（confirmFn 批准放行）', async () => {
    let confirmed = 0;
    const p = createAllowListPolicy({
      allow: ['safe_tool'],
      confirmFn: async () => {
        confirmed++;
        return true;
      },
    });
    const base = {
      permissions: [],
      args: {},
      sessionKey: 's',
      request: {} as never,
      shared: new Map(),
    };
    assert.equal(await p.check({ ...base, toolName: 'safe_tool' }), 'allow');
    assert.equal(await p.check({ ...base, toolName: 'other' }), 'confirm');
    assert.equal(await p.confirm!({ ...base, toolName: 'other' }), true);
    assert.equal(confirmed, 1);
  });

  it('createPermissionPolicy 按工具名正则 + 无匹配默认 deny', async () => {
    const p = createPermissionPolicy({
      rules: [{ name: 'allow-glob', toolName: /^glob$/, decision: 'allow' }],
    });
    const base = { permissions: [], args: {}, sessionKey: 's', request: {} as never, shared: new Map() };
    assert.equal(await p.check({ ...base, toolName: 'glob' }), 'allow');
    assert.equal(await p.check({ ...base, toolName: 'write_file' }), 'deny');
  });

  it('createPermissionPolicy 按能力前缀匹配（shell 命中 shell:exec）', async () => {
    const p = createPermissionPolicy({
      rules: [
        { name: 'no-shell', permission: 'shell', decision: 'deny' },
        { name: 'allow-fs', permission: 'fs:read', decision: 'allow' },
      ],
    });
    const base = { args: {}, sessionKey: 's', request: {} as never, shared: new Map() };
    // shell 前缀命中（shell:exec）
    assert.equal(
      await p.check({ ...base, toolName: 'run_command', permissions: ['shell:exec'] }),
      'deny',
    );
    // fs 前缀不命中 shell，命中 allow-fs
    assert.equal(
      await p.check({ ...base, toolName: 'read_file', permissions: ['fs:read'] }),
      'allow',
    );
    // 无能力声明的工具无规则命中 → deny
    assert.equal(await p.check({ ...base, toolName: 'safe', permissions: [] }), 'deny');
  });

  it('createPermissionPolicy matchArgs 基于参数二次裁决', async () => {
    const p = createPermissionPolicy({
      rules: [
        {
          name: 'deny-rm',
          toolName: /^run_command$/,
          matchArgs: (args) => {
            const a = args as { command?: string };
            return !!a.command?.trim().startsWith('rm ');
          },
          decision: 'deny',
        },
      ],
      defaultDecision: 'allow',
    });
    const base = { permissions: [], sessionKey: 's', request: {} as never, shared: new Map() };
    assert.equal(await p.check({ ...base, toolName: 'run_command', args: { command: 'rm -rf x' } }), 'deny');
    assert.equal(await p.check({ ...base, toolName: 'run_command', args: { command: 'ls' } }), 'allow');
  });

  it('createPermissionPolicy confirm 决策调用 confirmFn，未提供则 deny', async () => {
    const makeReq = {
      toolName: 'git_push',
      permissions: [],
      args: {},
      sessionKey: 's',
      request: {} as never,
      shared: new Map(),
    };
    // 无 confirmFn → check 返回 confirm，但 confirm 未提供（框架视为 deny）
    const p1 = createPermissionPolicy({
      rules: [{ name: 'confirm-x', decision: 'confirm' }],
    });
    assert.equal(await p1.check(makeReq), 'confirm');
    assert.equal(p1.confirm, undefined, '未提供 confirmFn 时 confirm 回调缺失');

    // 有 confirmFn → 决策 confirm，confirm() 可批准
    const p2 = createPermissionPolicy({
      rules: [{ name: 'confirm-x', decision: 'confirm' }],
      confirmFn: async () => true,
    });
    assert.equal(await p2.check(makeReq), 'confirm');
    assert.equal(await p2.confirm!(makeReq), true);
  });

  it('hasPermission 支持前缀与精确匹配', () => {
    assert.equal(hasPermission(['shell:exec'], 'shell'), true);
    assert.equal(hasPermission(['shell:exec'], 'shell:exec'), true);
    assert.equal(hasPermission(['shell:exec'], 'fs'), false);
    assert.equal(hasPermission([], 'fs:read'), false);
  });
});

// ─── Runtime 集成测试 ─────────────────────────────────────────────

describe('Runtime PermissionPolicy 集成', () => {
  it('未配置策略时工具正常执行（向后兼容）', async () => {
    const probe = makeProbeTool('echo_tool');
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'echo_tool', args: {} }]),
      tools: [probe],
    });
    const result = await runtime.run({ message: 'hi', type: 'message' });
    assert.equal(result.success, true);
    assert.equal(probe.calls(), 1, '未配置策略应放行工具执行');
    await runtime.close();
  });

  it('denyAllPolicy 阻断所有工具（不执行、产生 blocked 结果、不终止 run）', async () => {
    const probe = makeProbeTool('echo_tool');
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'echo_tool', args: {} }]),
      tools: [probe],
      permissionPolicy: createDenyAllPolicy(),
    });
    const result = await runtime.run({ message: 'hi', type: 'message' });
    assert.equal(result.success, true, 'deny 工具结果只是 blocked，不应让整个 run 失败');
    assert.equal(probe.calls(), 0, '被拒绝的工具不应真实执行');
    // 工具结果回传模型，模型第二次返回纯文本 → 正常结束
    const msgs = runtime.getMessages();
    const blocked = msgs.find(m => m.role === 'toolResult');
    assert.ok(blocked, '应生成 toolResult 消息');
    await runtime.close();
  });

  it('按工具名规则放行/拒绝', async () => {
    const safe = makeProbeTool('safe_tool');
    const risky = makeProbeTool('risky_tool');
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([
        { id: 't1', name: 'safe_tool', args: {} },
        { id: 't2', name: 'risky_tool', args: {} },
      ]),
      tools: [safe, risky],
      permissionPolicy: createAllowListPolicy({ allow: ['safe_tool'] }),
    });
    await runtime.run({ message: 'hi', type: 'message' });
    assert.equal(safe.calls(), 1, '白名单内工具应执行');
    assert.equal(risky.calls(), 0, '白名单外工具应被拒绝');
    await runtime.close();
  });

  it('confirm 决策：confirmFn 批准执行 / 拒绝则 blocked', async () => {
    const approved = makeProbeTool('approved_tool');
    const denied = makeProbeTool('denied_tool');
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([
        { id: 't1', name: 'approved_tool', args: {} },
        { id: 't2', name: 'denied_tool', args: {} },
      ]),
      tools: [approved, denied],
      permissionPolicy: createAllowListPolicy({
        allow: [],
        confirmFn: async (req) => req.toolName === 'approved_tool',
      }),
    });
    await runtime.run({ message: 'hi', type: 'message' });
    assert.equal(approved.calls(), 1, 'confirm 批准的工具应执行');
    assert.equal(denied.calls(), 0, 'confirm 拒绝的工具应被 blocked');
    await runtime.close();
  });

  it('工具 permissions 声明传入 PermissionRequest', async () => {
    let received: string[] | null = null;
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'shell_tool', args: { command: 'ls' } }]),
      tools: [makeProbeTool('shell_tool', ['shell:exec'])],
      permissionPolicy: {
        async check(req) {
          received = [...req.permissions];
          return 'deny';
        },
      },
    });
    await runtime.run({ message: 'hi', type: 'message' });
    assert.deepEqual(received, ['shell:exec']);
    await runtime.close();
  });

  it('deny 触发 telemetry onPermissionDenied', async () => {
    const denied: Array<{ toolName: string; reason: string }> = [];
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'x', args: {} }]),
      tools: [makeProbeTool('x')],
      permissionPolicy: createDenyAllPolicy(),
      telemetry: {
        onPermissionDenied(info) {
          denied.push({ toolName: info.toolName, reason: info.reason });
        },
      },
    });
    await runtime.run({ message: 'hi', type: 'message' });
    assert.equal(denied.length, 1);
    assert.equal(denied[0].toolName, 'x');
    assert.match(denied[0].reason, /permission denied/);
    await runtime.close();
  });

  it('流式 stream() 同样受策略约束', async () => {
    const probe = makeProbeTool('x');
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'x', args: {} }]),
      tools: [probe],
      permissionPolicy: createDenyAllPolicy(),
    });
    const chunks: string[] = [];
    for await (const c of runtime.stream({ message: 'hi', type: 'message' })) {
      chunks.push(c.type);
    }
    assert.ok(chunks.includes('tool_start'));
    assert.ok(chunks.includes('tool_end'));
    assert.equal(probe.calls(), 0, '流式下被拒绝的工具同样不执行');
    await runtime.close();
  });
});

// ─── ApprovalManager 单元测试 ─────────────────────────────────────

function makePermReq(toolName: string) {
  return {
    toolName,
    permissions: ['fs:write'] as const,
    args: { path: '/tmp/x' },
    sessionKey: 's',
    request: {} as never,
    shared: new Map(),
  };
}

/** 等待审批单出现（onPending 触发；最多 2s 防挂死） */
function nextApproval(mgr: ApprovalManager): Promise<PendingApproval> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('approval not created within 2s')), 2000);
    const off = mgr.onPending(a => {
      clearTimeout(timer);
      off();
      resolve(a);
    });
  });
}

describe('ApprovalManager 内存审批管理器', () => {
  it('resolve 批准 → wait 返回 approved，审批单从未决列表移除', async () => {
    const mgr = createApprovalManager();
    const approval = mgr.create(makePermReq('write_file'));
    assert.equal(mgr.list().length, 1);
    assert.equal(mgr.list()[0].id, approval.id);
    assert.equal(approval.request.toolName, 'write_file');

    const waitPromise = mgr.wait(approval);
    assert.equal(mgr.resolve(approval.id, true), true, '未决审批单 resolve 应生效');
    const outcome = await waitPromise;
    assert.equal(outcome.status, 'approved');
    assert.equal(outcome.approval.id, approval.id);
    assert.equal(mgr.list().length, 0, '结算后从未决列表移除');
  });

  it('resolve 驳回 → wait 返回 denied', async () => {
    const mgr = createApprovalManager();
    const approval = mgr.create(makePermReq('write_file'));
    const waitPromise = mgr.wait(approval);
    mgr.resolve(approval.id, false);
    assert.equal((await waitPromise).status, 'denied');
  });

  it('超时未审批 → wait 返回 timeout', async () => {
    const mgr = createApprovalManager();
    const approval = mgr.create(makePermReq('write_file'), { timeoutMs: 20 });
    const outcome = await mgr.wait(approval);
    assert.equal(outcome.status, 'timeout');
    assert.ok(outcome.waitedMs >= 20, 'waitedMs 应不小于超时阈值');
  });

  it('已结算审批单重复 resolve 不生效', async () => {
    const mgr = createApprovalManager();
    const approval = mgr.create(makePermReq('write_file'));
    const waitPromise = mgr.wait(approval);
    mgr.resolve(approval.id, true);
    await waitPromise;
    assert.equal(mgr.resolve(approval.id, false), false, '二次 resolve 应返回 false');
    assert.equal(mgr.resolve('apr_unknown', true), false, '未知 id 应返回 false');
  });

  it('cancel → wait 返回 cancelled；abort signal 同样触发取消', async () => {
    const mgr = createApprovalManager();
    const a1 = mgr.create(makePermReq('t1'));
    const wait1 = mgr.wait(a1);
    mgr.cancel(a1.id);
    assert.equal((await wait1).status, 'cancelled');

    // abort 信号传导：signal abort → 审批单取消
    const controller = new AbortController();
    const a2 = mgr.create(makePermReq('t2'), { signal: controller.signal });
    const wait2 = mgr.wait(a2);
    controller.abort();
    assert.equal((await wait2).status, 'cancelled');
    assert.equal(mgr.list().length, 0);
  });

  it('wait 迟到调用：已结算返回记录结果，未知 id 视为 cancelled', async () => {
    const mgr = createApprovalManager();
    const approval = mgr.create(makePermReq('write_file'));
    mgr.resolve(approval.id, true);
    await Promise.resolve(); // 让结算回调先行
    const outcome = await mgr.wait(approval); // 结算后才调用 wait
    assert.equal(outcome.status, 'approved', '已结算的迟到 wait 应返回记录结果');

    const ghost = { id: 'apr_missing', request: makePermReq('x'), createdAt: 0 } as PendingApproval;
    assert.equal((await mgr.wait(ghost)).status, 'cancelled');
  });

  it('onPending / onSettled 事件订阅与退订', async () => {
    const mgr = createApprovalManager();
    const pendingSeen: string[] = [];
    const settledSeen: string[] = [];
    const offPending = mgr.onPending(a => pendingSeen.push(a.id));
    const offSettled = mgr.onSettled(o => settledSeen.push(o.status));

    const approval = mgr.create(makePermReq('write_file'));
    assert.deepEqual(pendingSeen, [approval.id], '创建即触发 onPending');

    offPending();
    mgr.create(makePermReq('other'));
    assert.equal(pendingSeen.length, 1, '退订后不再触发 onPending');

    mgr.resolve(approval.id, true);
    await Promise.resolve();
    assert.deepEqual(settledSeen, ['approved'], '结算触发 onSettled');
    offSettled();
  });
});

// ─── Runtime pending 决策集成测试 ─────────────────────────────────

describe('Runtime 异步审批（pending）集成', () => {
  it('pending 挂起 → 外部批准 → 工具执行', async () => {
    const probe = makeProbeTool('risky_tool');
    const approvals = createApprovalManager();
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'risky_tool', args: {} }]),
      tools: [probe],
      permissionPolicy: { async check() { return 'pending'; } },
      approvals,
    });

    const runPromise = runtime.run({ message: 'hi', type: 'message' });
    const approval = await nextApproval(approvals);
    assert.equal(approval.request.toolName, 'risky_tool');

    approvals.resolve(approval.id, true);
    const result = await runPromise;
    assert.equal(result.success, true);
    assert.equal(probe.calls(), 1, '批准后工具应执行');
    assert.equal(approvals.list().length, 0);
    await runtime.close();
  });

  it('pending 挂起 → 外部驳回 → 工具 blocked 不执行', async () => {
    const probe = makeProbeTool('risky_tool');
    const approvals = createApprovalManager();
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'risky_tool', args: {} }]),
      tools: [probe],
      permissionPolicy: { async check() { return 'pending'; } },
      approvals,
    });

    const runPromise = runtime.run({ message: 'hi', type: 'message' });
    const approval = await nextApproval(approvals);
    approvals.resolve(approval.id, false);
    const result = await runPromise;
    assert.equal(result.success, true, '驳回只是 blocked，不应让 run 失败');
    assert.equal(probe.calls(), 0, '驳回后工具不应执行');

    const msgs = runtime.getMessages();
    const blocked = msgs.find(m => m.role === 'toolResult');
    assert.ok(blocked, '应生成 toolResult（blocked）消息');
    await runtime.close();
  });

  it('审批等待超时 → 视为拒绝', async () => {
    const probe = makeProbeTool('slow_tool');
    const approvals = createApprovalManager();
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'slow_tool', args: {} }]),
      tools: [probe],
      permissionPolicy: { async check() { return 'pending'; } },
      approvals,
      approvalTimeoutMs: 30,
    });

    const result = await runtime.run({ message: 'hi', type: 'message' });
    assert.equal(result.success, true);
    assert.equal(probe.calls(), 0, '超时后工具不应执行');
    await runtime.close();
  });

  it('pending 但未配置 approvals → 保守拒绝（向后兼容）', async () => {
    const probe = makeProbeTool('x');
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'x', args: {} }]),
      tools: [probe],
      permissionPolicy: { async check() { return 'pending'; } },
      // 不配置 approvals
    });
    await runtime.run({ message: 'hi', type: 'message' });
    assert.equal(probe.calls(), 0, '未配置审批管理器时 pending 应视为 deny');
    await runtime.close();
  });

  it('run abort → 审批单取消收尾，工具不执行', async () => {
    const probe = makeProbeTool('x');
    const approvals = createApprovalManager();
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'x', args: {} }]),
      tools: [probe],
      permissionPolicy: { async check() { return 'pending'; } },
      approvals,
      approvalTimeoutMs: 60_000,
    });

    const runPromise = runtime.run({ message: 'hi', type: 'message' });
    await nextApproval(approvals);
    runtime.abort(); // 触发 run AbortSignal → 审批单 cancelled
    await runPromise.catch(() => undefined); // abort 后 run 可能成功或失败，均算收尾

    assert.equal(approvals.list().length, 0, 'abort 后未决审批单应被清理');
    assert.equal(probe.calls(), 0, 'abort 后工具不应执行');
    assert.equal(runtime.isBusy(), false);
    await runtime.close();
  });

  it('审批挂起与结算触发 onApprovalPending / onApprovalResolved / onPermissionDenied', async () => {
    const pending: string[] = [];
    const resolved: string[] = [];
    const denied: string[] = [];
    const approvals = createApprovalManager();
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'x', args: {} }]),
      tools: [makeProbeTool('x')],
      permissionPolicy: { async check() { return 'pending'; } },
      approvals,
      telemetry: {
        onApprovalPending(info) {
          pending.push(`${info.toolName}:${info.approvalId}`);
        },
        onApprovalResolved(info) {
          resolved.push(`${info.toolName}:${info.outcome}`);
        },
        onPermissionDenied(info) {
          denied.push(info.toolName);
        },
      },
    });

    const runPromise = runtime.run({ message: 'hi', type: 'message' });
    const approval = await nextApproval(approvals);
    approvals.resolve(approval.id, false);
    await runPromise;

    assert.equal(pending.length, 1, '挂起时应触发 onApprovalPending');
    assert.ok(pending[0].startsWith('x:'), '事件应含工具名与审批单 id');
    assert.deepEqual(resolved, ['x:denied'], '结算时应触发 onApprovalResolved');
    assert.deepEqual(denied, ['x'], '驳回后应触发 onPermissionDenied');
    await runtime.close();
  });
});
