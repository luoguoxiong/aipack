/**
 * 项目记忆文件加载测试：优先级、@import 展开、循环去重、空场景
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadMemoryFiles, findProjectMemoryFile, INIT_COMMAND_PROMPT } from '../src/memory.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'aipack-memory-'));
}

describe('findProjectMemoryFile', () => {
  it('按 AIPACK.md > AGENTS.md > CLAUDE.md 优先级取第一个存在的', async () => {
    const dir = await makeTempDir();
    assert.equal(await findProjectMemoryFile(dir), undefined);

    await fs.writeFile(path.join(dir, 'CLAUDE.md'), 'claude');
    const claude = await findProjectMemoryFile(dir);
    assert.equal(path.basename(claude ?? ''), 'CLAUDE.md');

    await fs.writeFile(path.join(dir, 'AGENTS.md'), 'agents');
    const agents = await findProjectMemoryFile(dir);
    assert.equal(path.basename(agents ?? ''), 'AGENTS.md');

    await fs.writeFile(path.join(dir, 'AIPACK.md'), 'aipack');
    const aipack = await findProjectMemoryFile(dir);
    assert.equal(path.basename(aipack ?? ''), 'AIPACK.md');
  });
});

describe('loadMemoryFiles', () => {
  it('无任何记忆文件时返回空（零改动向后兼容）', async () => {
    const dir = await makeTempDir();
    const loaded = await loadMemoryFiles(dir);
    assert.deepEqual(loaded.files, []);
    assert.equal(loaded.content, '');
  });

  it('项目级记忆注入内容并标注来源', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'AIPACK.md'), '项目约定：使用 pnpm');
    const loaded = await loadMemoryFiles(dir);
    assert.equal(loaded.files.length, 1);
    assert.ok(loaded.content.includes('项目约定：使用 pnpm'));
    assert.ok(loaded.content.includes('<memory source='));
    assert.ok(loaded.content.includes('scope="项目级'));
  });

  it('@import 行级展开（相对导入文件目录）', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, 'docs'));
    await fs.writeFile(path.join(dir, 'docs', 'style.md'), '缩进 2 空格');
    await fs.writeFile(
      path.join(dir, 'AIPACK.md'),
      '# 项目\n@docs/style.md\n构建: pnpm build',
    );
    const loaded = await loadMemoryFiles(dir);
    assert.equal(loaded.files.length, 2);
    assert.ok(loaded.content.includes('缩进 2 空格'));
    assert.ok(loaded.content.includes('构建: pnpm build'));
  });

  it('循环导入去重（不挂起）', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'a.md'), 'A 内容\n@b.md');
    await fs.writeFile(path.join(dir, 'b.md'), 'B 内容\n@a.md');
    await fs.writeFile(path.join(dir, 'AIPACK.md'), '入口\n@a.md');
    const loaded = await loadMemoryFiles(dir);
    // a.md 与 b.md 各加载一次，循环被 visited 去重
    assert.equal(loaded.files.length, 3);
    const aCount = loaded.content.split('A 内容').length - 1;
    assert.equal(aCount, 1);
  });
});

describe('INIT_COMMAND_PROMPT', () => {
  it('指向 AIPACK.md 且要求使用 write 工具', () => {
    assert.ok(INIT_COMMAND_PROMPT.includes('AIPACK.md'));
    assert.ok(INIT_COMMAND_PROMPT.includes('write'));
  });
});
