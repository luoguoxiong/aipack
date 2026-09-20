import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkillMarkdown, loadSkills } from '../src/loader';

describe('parseSkillMarkdown', () => {
  test('完整 frontmatter 解析', () => {
    const text = [
      '---',
      'name: pdf-export',
      'description: "导出 PDF"',
      'disable-model-invocation: true',
      '---',
      '# PDF Export',
      'body here',
    ].join('\n');
    const { skill, errors } = parseSkillMarkdown(text);
    assert.deepEqual(errors, []);
    assert.equal(skill!.name, 'pdf-export');
    assert.equal(skill!.description, '导出 PDF');
    assert.equal(skill!.disableModelInvocation, true);
    assert.ok(skill!.content.startsWith('# PDF Export'));
  });

  test('name 缺省取 fallbackName；无 frontmatter 整体为正文（description 必填报错）', () => {
    const { skill, errors } = parseSkillMarkdown('# Just body', { fallbackName: 'my-skill' });
    assert.deepEqual(errors, ['description 缺失（frontmatter）']);
    assert.equal(skill!.name, 'my-skill');
    assert.equal(skill!.content, '# Just body');

    const ok = parseSkillMarkdown('---\ndescription: desc\n---\nbody', { fallbackName: 'x' });
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.skill!.name, 'x');
    assert.equal(ok.skill!.content, 'body');
  });

  test('description 缺失报错；未闭合 frontmatter 视为正文', () => {
    assert.ok(parseSkillMarkdown('---\nname: a\n---\nbody').errors.some(e => e.includes('description')));
    const open = parseSkillMarkdown('---\nname: a\n\nbody', { fallbackName: 'x' });
    // 无结束 --- → 整体视为正文，仅报 description 缺失
    assert.equal(open.errors.length, 1);
    assert.ok(open.errors[0].includes('description'));
  });
});

describe('loadSkills', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aipack-skills-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const writeSkill = (dir: string, name: string, description: string, body = `# ${name}`) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
  };

  test('多源加载：user → project → extraPaths，同名先注册者胜', () => {
    writeSkill(join(root, 'user', 'alpha'), 'alpha', 'user alpha', 'USER');
    writeSkill(join(root, 'project', '.aipack', 'skills', 'alpha'), 'alpha', 'project alpha', 'PROJECT');
    writeSkill(join(root, 'project', '.aipack', 'skills', 'beta'), 'beta', 'project beta');
    const nested = join(root, 'extra', 'nested', 'gamma');
    writeSkill(nested, 'gamma', 'nested gamma');

    const { skills, diagnostics } = loadSkills({
      includeDefaults: false,
      userDir: join(root, 'user'),
      extraPaths: [
        join(root, 'project', '.aipack', 'skills'),
        join(root, 'extra'),
      ],
    });

    const names = skills.map(s => s.name).sort();
    assert.deepEqual(names, ['alpha', 'beta', 'gamma']);
    const alpha = skills.find(s => s.name === 'alpha')!;
    assert.equal(alpha.source, 'user');
    assert.equal(alpha.content, 'USER');
    assert.ok(diagnostics.some(d => d.type === 'collision' && d.message.includes('alpha')));
  });

  test('SKILL.md 根目录不递归；普通目录递归发现 + 根 .md 文件', () => {
    // skill 根带一个“看起来像 skill”的子目录，不应被发现
    writeSkill(join(root, 'src', 'alpha'), 'alpha', 'alpha skill');
    mkdirSync(join(root, 'src', 'alpha', 'sub'));
    writeSkill(join(root, 'src', 'alpha', 'sub', 'inner'), 'inner', 'should be ignored');
    // 独立 .md 文件
    mkdirSync(join(root, 'loose'));
    writeFileSync(
      join(root, 'loose', 'loose-skill.md'),
      '---\ndescription: loose md\n---\nbody',
    );

    const { skills } = loadSkills({ includeDefaults: false, extraPaths: [join(root, 'src'), join(root, 'loose')] });
    const names = skills.map(s => s.name).sort();
    assert.deepEqual(names, ['alpha', 'loose-skill']);
  });

  test('跳过 . 开头目录与 node_modules；校验失败产诊断不中断', () => {
    writeSkill(join(root, '.hidden', 'h'), 'h', 'hidden');
    writeSkill(join(root, 'node_modules', 'm'), 'm', 'dep');
    writeSkill(join(root, 'ok', 'good'), 'good', 'good skill');
    mkdirSync(join(root, 'bad'), { recursive: true });
    writeFileSync(join(root, 'bad', 'SKILL.md'), '---\nname: bad\n---\nno description');

    const { skills, diagnostics } = loadSkills({ includeDefaults: false, extraPaths: [root] });
    assert.deepEqual(skills.map(s => s.name), ['good']);
    assert.ok(diagnostics.some(d => d.type === 'error' && d.path?.includes('bad')));
  });

  test('不存在的目录静默跳过；extraPath 缺失产 warning', () => {
    const { skills, diagnostics } = loadSkills({
      includeDefaults: false,
      userDir: join(root, 'nope'),
      extraPaths: [join(root, 'missing')],
    });
    assert.deepEqual(skills, []);
    assert.ok(diagnostics.some(d => d.type === 'warning'));
  });
});
