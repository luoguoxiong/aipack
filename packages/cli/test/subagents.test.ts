/**
 * 子 agent / task 工具测试：
 * - 定义加载校验（内置 general-purpose、字段校验、tools 白名单、同名覆盖）
 * - task 工具执行（隔离 runtime、防递归、模型覆盖、abort 传播、报告截断）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createResult } from '@aipack-ai/agent';
import type {
  AiModel,
  PermissionPolicy,
  Result,
  Runtime,
  RuntimeOptions,
  Tool,
  ToolResult,
} from '@aipack-ai/agent';
import {
  loadSubagentConfigs,
  createTaskTool,
  GENERAL_PURPOSE_AGENT,
  DEFAULT_SUBAGENT_MAX_TURNS,
  MAX_TASK_RESULT_CHARS,
} from '../src/subagents.js';
import type { SubagentDefinition, TaskToolDeps } from '../src/subagents.js';

const BUILTIN_TOOL_NAMES = ['read', 'write', 'edit', 'bash', 'find', 'grep', 'ls'];

const MAIN_MODEL: AiModel = {
  id: 'main-model',
  name: 'main-model',
  provider: 'deepseek',
  api: 'openai-completions',
  reasoning: false,
  input: ['text'],
  contextWindow: 128000,
  maxTokens: 16384,
} as AiModel;

const OVERRIDE_MODEL: AiModel = {
  ...MAIN_MODEL,
  id: 'gpt-4o-mini',
  provider: 'openai',
} as AiModel;

function makeTool(name: string): Tool {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: name }], details: {} }),
  };
}

function textOf(result: ToolResult): string {
  const block = result.content[0];
  return block && block.type === 'text' ? block.text : '';
}

interface FakeCapture {
  runtimeOptions?: RuntimeOptions;
  request?: { message: string; sessionKey?: string; ephemeral?: boolean };
  abortedSessionKeys: string[];
  closed: boolean;
}

interface HarnessOpts {
  result?: Partial<Result>;
  deps?: Partial<TaskToolDeps>;
  runDelayMs?: number;
}

function createHarness(opts?: HarnessOpts): { tool: Tool; capture: FakeCapture } {
  const capture: FakeCapture = { abortedSessionKeys: [], closed: false };
  const fakeRuntime: Runtime = {
    run: async request => {
      capture.request = request as FakeCapture['request'];
      if (opts?.runDelayMs) await new Promise(r => setTimeout(r, opts.runDelayMs));
      const base = createResult('子 agent 最终报告', opts?.result);
      // createResult 忽略 options.content（首参优先），内容覆盖需显式回填
      return opts?.result?.content !== undefined ? { ...base, content: opts.result.content } : base;
    },
    abort: (sessionKey?: string) => {
      capture.abortedSessionKeys.push(sessionKey ?? 'default');
    },
    close: async () => {
      capture.closed = true;
    },
  } as unknown as Runtime;

  const createRuntimeFn = async (runtimeOptions: RuntimeOptions): Promise<Runtime> => {
    capture.runtimeOptions = runtimeOptions;
    return fakeRuntime;
  };

  const deps: TaskToolDeps = {
    getModel: () => MAIN_MODEL,
    apiKey: 'test-key',
    cwd: '/tmp/aipack-subagents-test',
    // 混入 task 自身，验证子 agent 工具集恒排除它（防递归）
    tools: [makeTool('read'), makeTool('bash'), makeTool('task')],
    definitions: loadSubagentConfigs(undefined, BUILTIN_TOOL_NAMES).definitions,
    memoryContent: '项目约定：使用 pnpm',
    thinkingLevel: 'off',
    createRuntimeFn,
    ...opts?.deps,
  };
  return { tool: createTaskTool(deps), capture };
}

// ─── loadSubagentConfigs ─────────────────────────────────────────

describe('loadSubagentConfigs', () => {
  it('无配置时仅含内置 general-purpose', () => {
    const { definitions, warnings } = loadSubagentConfigs(undefined, BUILTIN_TOOL_NAMES);
    assert.equal(warnings.length, 0);
    const def = definitions.get(GENERAL_PURPOSE_AGENT);
    assert.ok(def);
    assert.ok(def.description.length > 0);
    assert.ok(def.prompt.length > 0);
    assert.equal(def.tools, undefined); // 缺省继承主 agent 工具集
  });

  it('合法定义被解析（tools/model/maxTurns）', () => {
    const config: Record<string, SubagentDefinition> = {
      searcher: {
        description: '只读检索',
        prompt: '你是检索专员',
        tools: ['read', 'grep', 'find'],
        model: 'openai/gpt-4o-mini',
        maxTurns: 10,
      },
    };
    const { definitions, warnings } = loadSubagentConfigs(config, BUILTIN_TOOL_NAMES);
    assert.equal(warnings.length, 0);
    assert.deepEqual(definitions.get('searcher'), {
      description: '只读检索',
      prompt: '你是检索专员',
      tools: ['read', 'grep', 'find'],
      model: 'openai/gpt-4o-mini',
      maxTurns: 10,
    });
  });

  it('缺 description / prompt 的定义告警并跳过', () => {
    const { definitions, warnings } = loadSubagentConfigs(
      {
        broken1: { prompt: '只有 prompt' } as SubagentDefinition,
        broken2: { description: '只有 description' } as SubagentDefinition,
      },
      BUILTIN_TOOL_NAMES,
    );
    assert.equal(definitions.size, 1); // 仅剩内置
    assert.equal(warnings.length, 2);
    assert.ok(warnings[0].includes('broken1'));
    assert.ok(warnings[1].includes('broken2'));
  });

  it('tools 白名单过滤未知工具名并告警；全未知时告警空工具集', () => {
    const { definitions, warnings } = loadSubagentConfigs(
      {
        a: { description: 'a', prompt: 'a', tools: ['read', 'grep', 'nonexistent'] },
        b: { description: 'b', prompt: 'b', tools: ['nope'] },
      },
      BUILTIN_TOOL_NAMES,
    );
    assert.deepEqual(definitions.get('a')?.tools, ['read', 'grep']);
    assert.ok(warnings.some(w => w.includes('a') && w.includes('nonexistent')));
    assert.deepEqual(definitions.get('b')?.tools, []);
    assert.ok(warnings.some(w => w.includes('b') && w.includes('没有任何工具')));
  });

  it('同名定义覆盖内置 general-purpose', () => {
    const { definitions } = loadSubagentConfigs(
      { [GENERAL_PURPOSE_AGENT]: { description: '自定义', prompt: '自定义提示词' } },
      BUILTIN_TOOL_NAMES,
    );
    assert.equal(definitions.get(GENERAL_PURPOSE_AGENT)?.prompt, '自定义提示词');
  });

  it('非法结构与非法字段值告警不阻塞', () => {
    const arrayResult = loadSubagentConfigs(
      ['bad'] as unknown as Record<string, SubagentDefinition>,
      BUILTIN_TOOL_NAMES,
    );
    assert.ok(arrayResult.warnings[0].includes('agents 配置必须是对象'));

    const { definitions, warnings } = loadSubagentConfigs(
      {
        'bad name!': { description: 'x', prompt: 'y' },
        'm1': { description: 'x', prompt: 'y', model: '  ' },
        't1': { description: 'x', prompt: 'y', maxTurns: -3 },
      },
      BUILTIN_TOOL_NAMES,
    );
    assert.equal(definitions.has('bad name!'), false);
    assert.equal(definitions.get('m1')?.model, undefined);
    assert.equal(definitions.get('t1')?.maxTurns, undefined);
    assert.equal(warnings.length, 3);
  });
});

// ─── createTaskTool ──────────────────────────────────────────────

describe('createTaskTool', () => {
  it('描述列出全部可用子 agent', () => {
    const { tool } = createHarness({
      deps: {
        definitions: loadSubagentConfigs(
          { reviewer: { description: '审查代码', prompt: '你是审查员' } },
          BUILTIN_TOOL_NAMES,
        ).definitions,
      },
    });
    assert.ok(tool.description.includes(GENERAL_PURPOSE_AGENT));
    assert.ok(tool.description.includes('reviewer'));
    assert.ok(tool.description.includes('审查代码'));
  });

  it('未知 agent / 缺参数返回错误结果', async () => {
    const { tool } = createHarness();
    const unknown = await tool.execute('c1', { agent: 'nope', prompt: 'x' });
    assert.ok(unknown.details && (unknown.details as { error?: string }).error);
    assert.ok(textOf(unknown).includes('可用: '));

    const noAgent = await tool.execute('c2', { prompt: 'x' });
    assert.ok((noAgent.details as { error?: string }).error);

    const noPrompt = await tool.execute('c3', { agent: GENERAL_PURPOSE_AGENT });
    assert.ok((noPrompt.details as { error?: string }).error);
  });

  it('正常执行：报告文本 + details 元数据 + 资源释放', async () => {
    const { tool, capture } = createHarness({
      result: { stopReason: 'completed', toolsUsed: ['read'] },
    });
    const result = await tool.execute('c1', {
      agent: GENERAL_PURPOSE_AGENT,
      prompt: '统计 src 下的文件数',
    });
    assert.equal(textOf(result), '子 agent 最终报告');
    const details = result.details as { agent?: string; stopReason?: string; truncated?: boolean };
    assert.equal(details.agent, GENERAL_PURPOSE_AGENT);
    assert.equal(details.stopReason, 'completed');
    assert.equal(details.truncated, false);
    assert.equal(capture.closed, true);
    // ephemeral 请求 + task- 前缀会话 key
    assert.equal(capture.request?.ephemeral, true);
    assert.ok(capture.request?.sessionKey?.startsWith(`task-${GENERAL_PURPOSE_AGENT}-`));
    assert.equal(capture.request?.message, '统计 src 下的文件数');
  });

  it('运行失败（result.error）返回错误结果', async () => {
    const { tool } = createHarness({ result: { error: '模型调用失败' } });
    const result = await tool.execute('c1', { agent: GENERAL_PURPOSE_AGENT, prompt: 'x' });
    assert.ok((result.details as { error?: string }).error?.includes('模型调用失败'));
  });

  it('max_turns 停止时提示报告可能不完整', async () => {
    const { tool } = createHarness({ result: { stopReason: 'max_turns' } });
    const result = await tool.execute('c1', { agent: GENERAL_PURPOSE_AGENT, prompt: 'x' });
    assert.ok(textOf(result).includes('回合数上限'));
  });

  it('超长报告截断到上限', async () => {
    const long = 'x'.repeat(MAX_TASK_RESULT_CHARS + 5000);
    const { tool } = createHarness({ result: { content: long } });
    const result = await tool.execute('c1', { agent: GENERAL_PURPOSE_AGENT, prompt: 'x' });
    assert.equal((result.details as { truncated?: boolean }).truncated, true);
    assert.ok(textOf(result).includes('已截断'));
    assert.ok(textOf(result).length < MAX_TASK_RESULT_CHARS + 200);
  });

  it('子 agent 工具集排除 task 自身（防递归）', async () => {
    const { tool, capture } = createHarness();
    await tool.execute('c1', { agent: GENERAL_PURPOSE_AGENT, prompt: 'x' });
    const names = (capture.runtimeOptions?.tools ?? []).map(t => t.name);
    assert.ok(names.includes('read'));
    assert.ok(names.includes('bash'));
    assert.equal(names.includes('task'), false);
  });

  it('definition.tools 过滤子 agent 工具集', async () => {
    const { tool, capture } = createHarness({
      deps: {
        definitions: loadSubagentConfigs(
          { reader: { description: '只读', prompt: '只读专员', tools: ['read', 'bash'] } },
          BUILTIN_TOOL_NAMES,
        ).definitions,
      },
    });
    await tool.execute('c1', { agent: 'reader', prompt: 'x' });
    const names = (capture.runtimeOptions?.tools ?? []).map(t => t.name);
    assert.deepEqual(names.sort(), ['bash', 'read']);
  });

  it('definition.model 覆盖主模型', async () => {
    const { tool, capture } = createHarness({
      deps: {
        definitions: loadSubagentConfigs(
          { cheap: { description: '廉价', prompt: '廉价专员', model: 'openai/gpt-4o-mini' } },
          BUILTIN_TOOL_NAMES,
        ).definitions,
        resolveModelSpec: spec => (spec === 'openai/gpt-4o-mini' ? OVERRIDE_MODEL : undefined),
      },
    });
    await tool.execute('c1', { agent: 'cheap', prompt: 'x' });
    assert.equal(capture.runtimeOptions?.model?.id, 'gpt-4o-mini');
  });

  it('无覆盖时子 agent 跟随主模型当前值', async () => {
    const { tool, capture } = createHarness();
    await tool.execute('c1', { agent: GENERAL_PURPOSE_AGENT, prompt: 'x' });
    assert.equal(capture.runtimeOptions?.model?.id, 'main-model');
  });

  it('maxTurns：定义值优先，缺省用内置默认', async () => {
    const { tool, capture } = createHarness({
      deps: {
        definitions: loadSubagentConfigs(
          { quick: { description: '快', prompt: '快专员', maxTurns: 7 } },
          BUILTIN_TOOL_NAMES,
        ).definitions,
      },
    });
    await tool.execute('c1', { agent: 'quick', prompt: 'x' });
    assert.equal(capture.runtimeOptions?.maxTurns, 7);

    const second = createHarness();
    await second.tool.execute('c2', { agent: GENERAL_PURPOSE_AGENT, prompt: 'x' });
    assert.equal(second.capture.runtimeOptions?.maxTurns, DEFAULT_SUBAGENT_MAX_TURNS);
  });

  it('系统提示词包含定义 prompt 与项目记忆；压缩关闭；权限策略透传', async () => {
    const policy = { check: async () => 'allow' } as unknown as PermissionPolicy;
    const { tool, capture } = createHarness({
      deps: {
        definitions: loadSubagentConfigs(
          { worker: { description: '工人', prompt: '你是文件整理专员' } },
          BUILTIN_TOOL_NAMES,
        ).definitions,
        permissionPolicy: policy,
      },
    });
    await tool.execute('c1', { agent: 'worker', prompt: 'x' });
    assert.ok(capture.runtimeOptions?.systemPrompt?.includes('你是文件整理专员'));
    assert.ok(capture.runtimeOptions?.systemPrompt?.includes('使用 pnpm'));
    assert.deepEqual(capture.runtimeOptions?.compaction, { enabled: false });
    assert.equal(capture.runtimeOptions?.permissionPolicy, policy);
  });

  it('abort 信号传播到子 runtime 且按会话 key 中止', async () => {
    const { tool, capture } = createHarness({ runDelayMs: 300 });
    const controller = new AbortController();
    const pending = tool.execute(
      'c1',
      { agent: GENERAL_PURPOSE_AGENT, prompt: 'x' },
      controller.signal,
    );
    await new Promise(r => setTimeout(r, 30));
    controller.abort();
    await pending;
    assert.equal(capture.abortedSessionKeys.length, 1);
    assert.equal(capture.abortedSessionKeys[0], capture.request?.sessionKey);
  });

  it('子 runtime 关闭失败不影响结果返回', async () => {
    const capture: FakeCapture = { abortedSessionKeys: [], closed: false };
    const fakeRuntime = {
      run: async () => createResult('报告'),
      abort: () => {},
      close: async () => {
        capture.closed = true;
        throw new Error('close failed');
      },
    } as unknown as Runtime;
    const tool = createTaskTool({
      getModel: () => MAIN_MODEL,
      cwd: '/tmp',
      tools: [makeTool('read')],
      definitions: loadSubagentConfigs(undefined, BUILTIN_TOOL_NAMES).definitions,
      createRuntimeFn: async () => fakeRuntime,
    });
    const result = await tool.execute('c1', { agent: GENERAL_PURPOSE_AGENT, prompt: 'x' });
    assert.equal(textOf(result), '报告');
    assert.equal(capture.closed, true);
  });
});
