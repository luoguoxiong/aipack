/**
 * 往返验证脚本 —— 不依赖真实 LLM / API Key。
 *
 * 直接调用各工具的 execute，在临时 workspace 内验证完整闭环：
 *   write_file → read_file → edit_file → list_directory → grep → glob → run_command（权限）→ 沙箱边界
 *
 * 运行：pnpm --filter aipack-coding example
 *   或：node --import tsx examples/round-trip.ts
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ToolResult, TextContent } from '@aipack/agent';
import { createCodingTools } from '../src/tools';
import { PermissionManager } from '../src/permission';
import type { ConfirmContext, ConfirmResult } from '../src/permission';

// ─── 断言工具 ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

function textOf(result: ToolResult): string {
  return result.content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

// ─── 主流程 ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n=== aipack-coding 往返验证 ===\n');

  // 临时 workspace
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coding-test-'));
  console.log(`workspace: ${tmpDir}\n`);

  const permission = new PermissionManager({});
  const tools = createCodingTools({ workspace: tmpDir, permission });
  const byName = (name: string) => tools.find((t) => t.name === name)!;

  // ─── 测试 1：write_file ──────────────────────────────────────────
  console.log('▶ 测试 1：write_file');
  const writeFile = byName('write_file');
  const w1 = await writeFile.execute('c1', {
    path: 'foo.ts',
    content: 'import { x } from "y";\n\nconsole.log(x);\n',
  });
  assert(textOf(w1).includes('已写入'), `write_file 成功: ${textOf(w1)}`);
  assert(fs.existsSync(path.join(tmpDir, 'foo.ts')), '文件已创建');
  console.log();

  // ─── 测试 2：read_file ───────────────────────────────────────────
  console.log('▶ 测试 2：read_file（带行号）');
  const readFile = byName('read_file');
  const r1 = await readFile.execute('c2', { path: 'foo.ts' });
  const r1text = textOf(r1);
  assert(r1text.includes('1\timport'), 'read_file 返回带行号内容');
  assert(r1text.includes('console.log'), 'read_file 包含文件内容');
  console.log();

  // ─── 测试 3：edit_file（成功 + 未匹配错误）──────────────────────
  console.log('▶ 测试 3：edit_file');
  const editFile = byName('edit_file');
  const e1 = await editFile.execute('c3', {
    path: 'foo.ts',
    old_string: 'console.log(x);',
    new_string: 'console.log(x, "debug");',
  });
  assert(textOf(e1).includes('已修改'), `edit_file 成功: ${textOf(e1)}`);
  const r2 = await readFile.execute('c4', { path: 'foo.ts' });
  assert(textOf(r2).includes('debug'), 'edit_file 修改已生效');

  const e2 = await editFile.execute('c5', {
    path: 'foo.ts',
    old_string: '不存在的内容',
    new_string: 'x',
  });
  assert(textOf(e2).includes('失败'), 'edit_file 未匹配时返回错误');
  console.log();

  // ─── 测试 4：list_directory ─────────────────────────────────────
  console.log('▶ 测试 4：list_directory');
  const listDir = byName('list_directory');
  await writeFile.execute('c6', { path: 'bar.ts', content: 'export const y = 1;' });
  await fs.promises.mkdir(path.join(tmpDir, 'sub'), { recursive: true });
  await writeFile.execute('c7', { path: 'sub/baz.ts', content: 'export const z = 2;' });
  const l1 = await listDir.execute('c8', { path: '.' });
  const l1text = textOf(l1);
  assert(l1text.includes('foo.ts'), 'list_directory 含 foo.ts');
  assert(l1text.includes('bar.ts'), 'list_directory 含 bar.ts');
  assert(l1text.includes('📁'), 'list_directory 区分目录（含 📁）');
  console.log();

  // ─── 测试 5：grep ───────────────────────────────────────────────
  console.log('▶ 测试 5：grep');
  const grep = byName('grep');
  const g1 = await grep.execute('c9', { pattern: 'console', path: '.' });
  const g1text = textOf(g1);
  assert(g1text.includes('foo.ts'), 'grep 命中 foo.ts');
  assert(g1text.includes('console'), 'grep 返回匹配内容');
  const g2 = await grep.execute('c10', { pattern: 'export', glob: '*.ts' });
  assert(textOf(g2).includes('bar.ts'), 'grep + glob 过滤命中 bar.ts');
  console.log();

  // ─── 测试 6：glob ───────────────────────────────────────────────
  console.log('▶ 测试 6：glob（递归）');
  const glob = byName('glob');
  const gl1 = await glob.execute('c11', { pattern: '**/*.ts' });
  const gl1text = textOf(gl1);
  assert(gl1text.includes('foo.ts'), 'glob 命中 foo.ts');
  assert(gl1text.includes('sub/baz.ts'), 'glob 递归命中 sub/baz.ts');
  console.log();

  // ─── 测试 7：run_command 权限 ───────────────────────────────────
  console.log('▶ 测试 7：run_command 权限策略');
  const runCmd = byName('run_command');

  // allow：ls（fs-readonly）
  const rc1 = await runCmd.execute('c12', { command: 'ls' });
  assert(!textOf(rc1).includes('失败') && !textOf(rc1).includes('拒绝'), `ls 放行: ${textOf(rc1).slice(0, 60)}`);

  // confirm 无 fn → deny：rm（confirm-rm 无确认回调时兜底拒绝）
  const rc2 = await runCmd.execute('c13', { command: 'rm -rf foo' });
  assert(textOf(rc2).includes('拒绝'), `rm 被拒绝: ${textOf(rc2).slice(0, 60)}`);

  // confirm 无 fn → deny：mkdir（fs-mutating）
  const rc3 = await runCmd.execute('c14', { command: 'mkdir testdir' });
  assert(textOf(rc3).includes('拒绝'), 'mkdir 无 confirmFn 时被拒绝');

  // confirm fn=true → allow
  const permission2 = new PermissionManager({
    confirmFn: async (_ctx: ConfirmContext): Promise<ConfirmResult> => true,
  });
  const tools2 = createCodingTools({ workspace: tmpDir, permission: permission2 });
  const runCmd2 = tools2.find((t) => t.name === 'run_command')!;
  const rc4 = await runCmd2.execute('c15', { command: 'mkdir testdir2' });
  assert(!textOf(rc4).includes('拒绝'), `mkdir 有 confirmFn 放行: ${textOf(rc4).slice(0, 60)}`);
  console.log();

  // ─── 测试 8：沙箱边界 ───────────────────────────────────────────
  console.log('▶ 测试 8：沙箱边界（路径逃逸防护）');
  const rc5 = await readFile.execute('c16', { path: '../../../etc/passwd' });
  assert(textOf(rc5).includes('失败'), '越界路径被拒绝');
  console.log();

  // ─── 清理 ───────────────────────────────────────────────────────
  await fs.promises.rm(tmpDir, { recursive: true, force: true });

  // ─── 汇总 ───────────────────────────────────────────────────────
  console.log('════════════════════════════════════════');
  console.log(`  通过: ${passed}  失败: ${failed}`);
  console.log('════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('验证脚本异常:', err);
  process.exit(1);
});
