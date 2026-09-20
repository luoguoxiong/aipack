import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '@aipack-ai/agent';
import type { StreamFn, StreamEvent, Context, Model, ToolResultMessage } from '@aipack-ai/agent';
import { SkillsExtension, createSkillsPlugin } from '../src/extension';
import type { Skill } from '../src/types';

const TEST_MODEL: Model = {
  id: 'test-model',
  name: 'Test Model',
  provider: 'test',
  contextWindow: 100_000,
  maxTokens: 4096,
  reasoning: false,
};

const SKILL: Skill = {
  name: 'pdf-export',
  description: '导出 PDF 的专项指引',
  content: '# PDF Export\n1. use library x',
  baseDir: '/tmp/skills/pdf-export',
};

function assistant(text: string): StreamEvent {
  return {
    type: 'done',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      stopReason: 'stop',
      usage: { input: 1, output: 1, total: 2 },
      model: TEST_MODEL.id,
      provider: TEST_MODEL.provider,
      timestamp: Date.now(),
    },
  };
}

function toolCallAssistant(name: string, args: unknown): StreamEvent {
  return {
    type: 'done',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'tc1', name, arguments: args }],
      stopReason: 'toolUse',
      usage: { input: 1, output: 1, total: 2 },
      model: TEST_MODEL.id,
      provider: TEST_MODEL.provider,
      timestamp: Date.now(),
    },
  };
}

describe('SkillsExtension', () => {
  test('beforeModelCall 注入目录段 + skill 工具进入模型上下文', async () => {
    const contexts: Context[] = [];
    const streamFn: StreamFn = async function* (_model, context) {
      contexts.push(context);
      yield assistant('ok');
    };

    const runtime = createRuntime({
      model: TEST_MODEL,
      streamFn,
      systemPrompt: 'BASE PROMPT',
      extensions: [new SkillsExtension([SKILL])],
    });

    await runtime.run({ message: 'hi', type: 'message' });

    assert.equal(contexts.length, 1);
    assert.ok(contexts[0].systemPrompt.startsWith('BASE PROMPT'));
    assert.ok(contexts[0].systemPrompt.includes('<available_skills>'));
    assert.ok(contexts[0].systemPrompt.includes('<name>pdf-export</name>'));
    // 目录注入每次基于基准 prompt 重建，不累积
    await runtime.run({ message: 'again', type: 'message' });
    assert.equal(contexts[1].systemPrompt.split('<available_skills>').length - 1, 1);
    // 工具已注册（ExtensionContext.runtime 通道）
    assert.ok(contexts[0].tools?.some(t => t.name === 'skill'));
  });

  test('端到端：模型调用 skill 工具返回全文（零 fs 依赖）', async () => {
    let call = 0;
    const streamFn: StreamFn = async function* () {
      call += 1;
      if (call === 1) yield toolCallAssistant('skill', { name: 'pdf-export' });
      else yield assistant('done');
    };

    const runtime = createRuntime({
      model: TEST_MODEL,
      streamFn,
      extensions: [new SkillsExtension([SKILL])],
    });

    const result = await runtime.run({ message: 'load the pdf skill', type: 'message' });
    assert.equal(result.success, true);

    const toolResult = runtime
      .getMessages()
      .find((m): m is ToolResultMessage => (m as { role: string }).role === 'toolResult');
    assert.ok(toolResult);
    assert.equal(toolResult.toolName, 'skill');
    const text = toolResult.content
      .map(c => (c as { text?: string }).text ?? '')
      .join('');
    assert.ok(text.includes('# PDF Export'));
    assert.ok(text.includes('/tmp/skills/pdf-export'));
  });

  test('未知名调用返回错误结果；disableModelInvocation 不进目录', async () => {
    let call = 0;
    const streamFn: StreamFn = async function* () {
      call += 1;
      if (call === 1) yield toolCallAssistant('skill', { name: 'nope' });
      else yield assistant('done');
    };

    const hidden: Skill = { ...SKILL, name: 'manual-only', disableModelInvocation: true };
    const runtime = createRuntime({
      model: TEST_MODEL,
      streamFn,
      extensions: [new SkillsExtension([SKILL, hidden])],
    });

    await runtime.run({ message: 'hi', type: 'message' });
    const toolResult = runtime
      .getMessages()
      .find((m): m is ToolResultMessage => (m as { role: string }).role === 'toolResult');
    assert.ok(toolResult?.isError);
  });
});

describe('createSkillsPlugin', () => {
  test('一站式装配：extensions 非空，skills 合并', async () => {
    const plugin = createSkillsPlugin({ skills: [SKILL] });
    assert.equal(plugin.extensions.length, 1);
    assert.deepEqual(plugin.skills.map(s => s.name), ['pdf-export']);
  });

  test('无 skill 时零开销（extensions 为空）', () => {
    const plugin = createSkillsPlugin();
    assert.deepEqual(plugin.extensions, []);
  });
});
