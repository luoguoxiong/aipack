import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateSkill, formatSkillsSection, createSkillTool, expandSkillCommand } from '../src/core';
import type { Skill } from '../src/types';

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'pdf-export',
    description: '导出 PDF 的专项指引',
    content: '# PDF Export\n1. do something',
    ...overrides,
  };
}

describe('validateSkill', () => {
  test('合法 skill 返回空错误列表', () => {
    assert.deepEqual(validateSkill(makeSkill()), []);
  });

  test('name 缺失 / 不合法 / 超长', () => {
    assert.ok(validateSkill(makeSkill({ name: '' })).some(e => e.includes('name')));
    assert.ok(validateSkill(makeSkill({ name: 'Pdf' })).some(e => e.includes('不合法')));
    assert.ok(validateSkill(makeSkill({ name: 'a--b' })).some(e => e.includes('不合法')));
    assert.ok(validateSkill(makeSkill({ name: '-a-' })).some(e => e.includes('不合法')));
    assert.ok(validateSkill(makeSkill({ name: 'a'.repeat(65) })).some(e => e.includes('64')));
  });

  test('description 缺失 / 超长', () => {
    assert.ok(validateSkill(makeSkill({ description: '' })).some(e => e.includes('description')));
    assert.ok(
      validateSkill(makeSkill({ description: 'x'.repeat(1025) })).some(e => e.includes('1024')),
    );
  });

  test('content 缺失', () => {
    assert.ok(validateSkill(makeSkill({ content: '' })).some(e => e.includes('content')));
  });
});

describe('formatSkillsSection', () => {
  test('无可见 skill 返回空串', () => {
    assert.equal(formatSkillsSection([]), '');
    assert.equal(formatSkillsSection([makeSkill({ disableModelInvocation: true })]), '');
  });

  test('渲染 name + description 目录，过滤 disableModelInvocation', () => {
    const section = formatSkillsSection([
      makeSkill(),
      makeSkill({ name: 'hidden', description: '仅人工触发', disableModelInvocation: true }),
    ]);
    assert.ok(section.includes('<available_skills>'));
    assert.ok(section.includes('<name>pdf-export</name>'));
    assert.ok(section.includes('导出 PDF 的专项指引'));
    assert.ok(!section.includes('hidden'));
  });
});

describe('createSkillTool', () => {
  test('命中返回 content + baseDir 提示', async () => {
    const tool = createSkillTool([
      makeSkill({ baseDir: '/tmp/skills/pdf-export' }),
    ]);
    assert.equal(tool.name, 'skill');
    const result = await tool.execute('tc1', { name: 'pdf-export' });
    const text = result.content.map(c => (c as { text?: string }).text ?? '').join('');
    assert.ok(text.includes('# PDF Export'));
    assert.ok(text.includes('/tmp/skills/pdf-export'));
  });

  test('未命中返回错误结果（含可用列表）', async () => {
    const tool = createSkillTool([makeSkill()]);
    const result = await tool.execute('tc1', { name: 'nope' });
    assert.ok(String((result.details as { error?: string }).error).includes('未找到'));
  });

  test('disableModelInvocation 拒绝模型调用', async () => {
    const tool = createSkillTool([makeSkill({ disableModelInvocation: true })]);
    const result = await tool.execute('tc1', { name: 'pdf-export' });
    assert.ok(String((result.details as { error?: string }).error).includes('禁止'));
  });

  test('缺少参数报错；数组注册表同名先注册者胜', async () => {
    const tool = createSkillTool([makeSkill({ content: 'first' }), makeSkill({ content: 'second' })]);
    const missing = await tool.execute('tc1', {});
    assert.ok((missing.details as { error?: string }).error);
    const result = await tool.execute('tc1', { name: 'pdf-export' });
    assert.ok(
      result.content.map(c => (c as { text?: string }).text ?? '').join('').includes('first'),
    );
  });
});

describe('expandSkillCommand', () => {
  test('命中展开为 XML 块，args 保留', () => {
    const out = expandSkillCommand('/skill:pdf-export page=3', [makeSkill({ filePath: '/a/SKILL.md' })]);
    assert.ok(out.startsWith('<skill name="pdf-export" location="/a/SKILL.md">'));
    assert.ok(out.includes('# PDF Export'));
    assert.ok(out.endsWith('</skill>\n\npage=3'));
  });

  test('未命中保持原样', () => {
    assert.equal(expandSkillCommand('/skill:nope args', [makeSkill()]), '/skill:nope args');
  });
});
