/**
 * 用户 hooks 测试：Extension 组装、matcher、命令决策（stdout JSON / exit 2）、prompt 改写
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionManager } from '@aipack-ai/agent';
import type {
  ExtensionContext,
  BeforeToolCallDecision,
  AfterToolCallDecision,
  AfterToolCallContext,
  ToolCallContext,
  Tool,
  Request,
} from '@aipack-ai/agent';
import { createUserHooksExtension, hasUserHooks } from '../src/hooks.js';
import type { HookDefinition, UserHooksConfig } from '../src/hooks.js';

/** 创建 ExtensionManager → 注册 hooks 扩展 → 返回其钩子集合（tap 后即可触发） */
function setup(config: UserHooksConfig | undefined) {
  const ext = createUserHooksExtension(config);
  const manager = new ExtensionManager();
  const ctx: ExtensionContext = {
    config: {},
    workspace: process.cwd(),
    sessionKey: 'test',
    shared: new Map(),
  };
  if (ext) {
    manager.register(ext);
    manager.applyAll(ctx);
  }
  return { hooks: manager.getHooks(), registered: ext !== undefined };
}

function toolContext(toolName: string, args: unknown): ToolCallContext {
  const tool: Tool = {
    name: toolName,
    description: '',
    parameters: {},
    execute: async () => ({ content: [], details: {} }),
  };
  return {
    toolCall: { type: 'toolCall', id: 't1', name: toolName, arguments: args as Record<string, unknown> },
    tool,
    args,
    sessionKey: 'test',
    request: { message: 'hi', type: 'message', channel: 'cli' } as Request,
    shared: new Map(),
    signal: new AbortController().signal,
  } as unknown as ToolCallContext;
}

const BASE_DECISION: BeforeToolCallDecision = { block: false, terminate: false, args: { x: 1 } };

describe('hasUserHooks / createUserHooksExtension', () => {
  it('空配置返回 false / undefined', () => {
    assert.equal(hasUserHooks(undefined), false);
    assert.equal(hasUserHooks({}), false);
    assert.equal(hasUserHooks({ PreToolUse: [] }), false);
    assert.equal(createUserHooksExtension(undefined), undefined);
    assert.equal(createUserHooksExtension({}), undefined);
  });

  it('有配置时注册 Extension 并 tap 生效', () => {
    const { registered } = setup({ Stop: [{ command: 'true' }] });
    assert.equal(registered, true);
  });
});

describe('PreToolUse', () => {
  it('stdout JSON decision=block 时阻断', async () => {
    const { hooks } = setup({
      PreToolUse: [{ command: `echo '{"decision":"block","reason":"不允许删除"}'` }],
    });
    const decision = await hooks.beforeToolCall.promise(
      { ...BASE_DECISION, args: { cmd: 'rm -rf /' } },
      toolContext('bash', { cmd: 'rm -rf /' }),
    );
    assert.equal(decision.block, true);
    assert.equal(decision.reason, '不允许删除');
  });

  it('exit 2 视为阻断，stderr 作为 reason', async () => {
    const { hooks } = setup({
      PreToolUse: [{ command: `echo 钩子拒绝 >&2; exit 2` }],
    });
    const decision = await hooks.beforeToolCall.promise(BASE_DECISION, toolContext('bash', {}));
    assert.equal(decision.block, true);
    assert.equal(decision.reason, '钩子拒绝');
  });

  it('无决策输出时放行且不改参数', async () => {
    const { hooks } = setup({ PreToolUse: [{ command: 'true' }] });
    const decision = await hooks.beforeToolCall.promise(BASE_DECISION, toolContext('bash', {}));
    assert.equal(decision.block, false);
    assert.deepEqual(decision.args, { x: 1 });
  });

  it('stdout args 覆盖工具参数', async () => {
    const { hooks } = setup({
      PreToolUse: [{ command: `echo '{"args":{"cmd":"safe-cmd"}}'` }],
    });
    const decision = await hooks.beforeToolCall.promise(BASE_DECISION, toolContext('bash', {}));
    assert.deepEqual(decision.args, { cmd: 'safe-cmd' });
  });

  it('matcher 过滤：不匹配的工具不执行命令', async () => {
    const { hooks } = setup({
      PreToolUse: [{ matcher: 'write', command: `echo '{"decision":"block"}'` }],
    });
    const decision = await hooks.beforeToolCall.promise(BASE_DECISION, toolContext('bash', {}));
    assert.equal(decision.block, false);
  });

  it('命令失败（非 exit 2）不中断主流程', async () => {
    const { hooks } = setup({
      PreToolUse: [{ command: `exit 3` }, { command: `nonexistent-command-xyz 2>/dev/null` }],
    });
    const decision = await hooks.beforeToolCall.promise(BASE_DECISION, toolContext('bash', {}));
    assert.equal(decision.block, false);
  });
});

describe('PostToolUse', () => {
  it('stdout terminate 时终止 run', async () => {
    const { hooks } = setup({
      PostToolUse: [{ command: `echo '{"terminate":true,"reason":"检测到敏感输出"}'` }],
    });
    const ctx = toolContext('bash', {}) as AfterToolCallContext;
    (ctx as { result: unknown }).result = { content: [{ type: 'text', text: 'out' }], details: {} };
    (ctx as { isError: boolean }).isError = false;
    const decision = await hooks.afterToolCall.promise(
      { result: ctx.result, terminate: false } as AfterToolCallDecision,
      ctx,
    );
    assert.equal(decision.terminate, true);
  });
});

describe('UserPromptSubmit', () => {
  it('stdout prompt 替换用户输入', async () => {
    const { hooks } = setup({
      UserPromptSubmit: [{ command: `echo '{"prompt":"改写后的提示"}'` }],
    });
    const request: Request = { message: '原始输入', type: 'message', channel: 'cli', sessionKey: 'test' };
    const final = await hooks.beforeRun.promise(request);
    assert.equal(final.message, '改写后的提示');
  });

  it('exit 2 不中断请求（beforeRun 无阻断语义）', async () => {
    const { hooks } = setup({ UserPromptSubmit: [{ command: `exit 2` }] });
    const request: Request = { message: '原始输入', type: 'message', channel: 'cli', sessionKey: 'test' };
    const final = await hooks.beforeRun.promise(request);
    assert.equal(final.message, '原始输入');
  });
});

describe('Stop', () => {
  it('观察性钩子不阻塞（命令收到的 stdin 含事件名）', async () => {
    const { hooks } = setup({
      Stop: [{ command: `grep -q '"event":"Stop"' && exit 0 || exit 1` }],
    });
    await hooks.done.promise(
      { success: true, stopReason: 'stop' } as never,
      { message: 'hi', type: 'message', channel: 'cli', sessionKey: 'test' } as Request,
    );
  });
});

describe('HookDefinition', () => {
  it('类型冒烟：matcher/timeoutMs 字段可用', () => {
    const hook: HookDefinition = { matcher: 'bash', command: 'true', timeoutMs: 1000 };
    assert.equal(hook.matcher, 'bash');
  });
});
