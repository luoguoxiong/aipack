/**
 * tools.ts 单测：工作区路径防护（前缀绕过 / ../ 逃逸 / 符号链接逃逸）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveInWorkspace, workspaceRoot, selectTools, BUILTIN_TOOLS } from '../src/tools.js';

const escapeLink = path.join(workspaceRoot, 'test', '.tmp-escape-link');

before(async () => {
  // 工作区内符号链接指向外部（os.tmpdir），用于验证 realpath 防逃逸
  await fs.symlink(os.tmpdir(), escapeLink, 'dir');
});

after(async () => {
  await fs.rm(escapeLink, { force: true });
});

test('工作区内路径正常解析', async () => {
  const abs = await resolveInWorkspace('package.json');
  assert.equal(abs, path.resolve(workspaceRoot, 'package.json'));
});

test('../ 逃逸被拒绝', async () => {
  await assert.rejects(() => resolveInWorkspace('../outside.txt'), /路径越界/);
});

test('前缀相似的兄弟目录不被误判为工作区内', async () => {
  // workspaceRoot 形如 .../aipack/packages/cli，兄弟目录 packages/agent 不应通过
  await assert.rejects(() => resolveInWorkspace('../agent'), /路径越界/);
  await assert.rejects(() => resolveInWorkspace(path.join(workspaceRoot + '-evil', 'x')), /路径越界/);
});

test('绝对路径越界被拒绝', async () => {
  await assert.rejects(() => resolveInWorkspace('/etc/hosts'), /路径越界/);
});

test('符号链接指向外部被拒绝', async () => {
  await assert.rejects(() => resolveInWorkspace('test/.tmp-escape-link'), /路径越界（符号链接）/);
});

test('selectTools：白名单/黑名单/未知工具名', () => {
  const all = selectTools({});
  assert.equal(all.tools.length, BUILTIN_TOOLS.length);
  assert.deepEqual(all.unknown, []);

  const wl = selectTools({ tools: ['read', 'writ'] }); // "writ" 拼写错误
  assert.deepEqual(wl.tools.map(t => t.name), ['read']);
  assert.deepEqual(wl.unknown, ['writ']);

  const bl = selectTools({ excludeTools: ['bahs'] }); // "bahs" 拼写错误
  assert.equal(bl.tools.length, BUILTIN_TOOLS.length); // 黑名单未命中任何工具
  assert.deepEqual(bl.unknown, ['bahs']);

  const nt = selectTools({ noTools: true });
  assert.deepEqual(nt.tools, []);
});
