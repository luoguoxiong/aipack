/**
 * PermissionPolicy 框架级权限层测试：
 * - 内置策略单元：createPermissionPolicy / createAllowListPolicy / denyAll / allowAll / hasPermission
 * - Runtime 集成：deny → blocked 结果、confirm 批准/拒绝、未配置放行、流式同样生效、
 *   telemetry onPermissionDenied 上报、工具 permissions 声明传递
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPermissionPolicy,
  createAllowListPolicy,
  createDenyAllPolicy,
  createAllowAllPolicy,
  hasPermission,
  createRuntime,
} from '../index.ts';
import type {
  StreamFn,
  StreamEvent,
  AssistantMessage,
  Tool,
} from '../core/index.ts';

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
