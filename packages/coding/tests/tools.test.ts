/**
 * coding 工具单元测试：各工具的边界场景 + run_command 权限联动。
 *
 * 在临时 workspace 内验证 read_file / write_file / edit_file / list_directory
 * / grep / glob / run_command 的行为与错误处理。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import type { ToolResult, TextContent } from '@aipack/agent';
import { createCodingTools } from '../src/tools';
import { PermissionManager } from '../src/permission';
import type { ConfirmContext, ConfirmResult } from '../src/permission';

/** 在 cwd 中初始化 git 仓库并创建初始提交（run_command git 测试依赖） */
function gitInit(cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['init', '-q'],
      { cwd },
      (err) => {
        if (err) return resolve(); // git 不可用则跳过（对应测试会失败）
        execFile('git', ['config', 'user.email', 'test@test'], { cwd }, (e1) => {
          if (e1) return reject(e1);
          execFile('git', ['config', 'user.name', 'test'], { cwd }, (e2) => {
            if (e2) return reject(e2);
            execFile('git', ['add', '-A'], { cwd }, (e3) => {
              if (e3) return reject(e3);
              execFile('git', ['commit', '-qm', 'init'], { cwd }, (e4) =>
                e4 ? reject(e4) : resolve(),
              );
            });
          });
        });
      },
    );
  });
}

let tmpDir: string;
// 工具实例（在 before 中创建，因为依赖 tmpDir）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tools: ReturnType<typeof createCodingTools>;

function textOf(result: ToolResult): string {
  return result.content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

describe('coding tools', () => {
  before(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tools-test-'));
    // 初始文件
    await fs.promises.writeFile(
      path.join(tmpDir, 'foo.ts'),
      'import { x } from "y";\n\nconsole.log(x);\n',
    );
    await fs.promises.mkdir(path.join(tmpDir, 'sub'), { recursive: true });
    await fs.promises.writeFile(path.join(tmpDir, 'sub/bar.ts'), 'export const y = 1;\n');

    // run_command 的 git 测试依赖已初始化的临时仓库
    await gitInit(tmpDir);

    tools = createCodingTools({ workspace: tmpDir, permission: new PermissionManager() });
  });

  after(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  const byName = (name: string) => tools.find((t) => t.name === name)!;

  // ─── read_file ───────────────────────────────────────────────────

  describe('read_file', () => {
    it('读取文件返回带行号内容', async () => {
      const r = await byName('read_file').execute('t1', { path: 'foo.ts' });
      const text = textOf(r);
      assert.match(text, /1\timport/);
      assert.match(text, /console\.log/);
    });

    it('不存在的文件返回错误', async () => {
      const r = await byName('read_file').execute('t2', { path: 'nope.ts' });
      assert.match(textOf(r), /失败/);
      assert.match(textOf(r), /不存在/);
    });

    it('目录返回错误（提示用 list_directory）', async () => {
      const r = await byName('read_file').execute('t3', { path: 'sub' });
      assert.match(textOf(r), /目录/);
      assert.match(textOf(r), /list_directory/);
    });

    it('offset 分页生效', async () => {
      const r = await byName('read_file').execute('t4', { path: 'foo.ts', offset: 3 });
      const text = textOf(r);
      // 第 3 行是 console.log
      assert.match(text, /3\tconsole\.log/);
      assert.ok(!text.includes('1\timport'));
    });
  });

  // ─── write_file ──────────────────────────────────────────────────

  describe('write_file', () => {
    it('写入新文件', async () => {
      const r = await byName('write_file').execute('t5', {
        path: 'new.ts',
        content: 'hello\n',
      });
      assert.match(textOf(r), /已写入/);
      assert.ok(fs.existsSync(path.join(tmpDir, 'new.ts')));
    });

    it('自动创建父目录', async () => {
      const r = await byName('write_file').execute('t6', {
        path: 'deep/nested/file.ts',
        content: 'x\n',
      });
      assert.match(textOf(r), /已写入/);
      assert.ok(fs.existsSync(path.join(tmpDir, 'deep/nested/file.ts')));
    });

    it('覆盖已有文件', async () => {
      await byName('write_file').execute('t7', { path: 'over.ts', content: 'old\n' });
      await byName('write_file').execute('t8', { path: 'over.ts', content: 'new\n' });
      const content = await fs.promises.readFile(path.join(tmpDir, 'over.ts'), 'utf-8');
      assert.equal(content, 'new\n');
    });
  });

  // ─── edit_file ───────────────────────────────────────────────────

  describe('edit_file', () => {
    it('唯一匹配替换成功', async () => {
      const r = await byName('edit_file').execute('t9', {
        path: 'foo.ts',
        old_string: 'console.log(x);',
        new_string: 'console.log(x, "debug");',
      });
      assert.match(textOf(r), /已修改/);
      const content = await fs.promises.readFile(path.join(tmpDir, 'foo.ts'), 'utf-8');
      assert.ok(content.includes('debug'));
    });

    it('未匹配返回错误', async () => {
      const r = await byName('edit_file').execute('t10', {
        path: 'foo.ts',
        old_string: '不存在的内容',
        new_string: 'x',
      });
      assert.match(textOf(r), /失败/);
      assert.match(textOf(r), /未找到/);
    });

    it('多重匹配且未设 replace_all 返回错误', async () => {
      await byName('write_file').execute('t11', {
        path: 'dup.ts',
        content: 'foo\nfoo\nfoo\n',
      });
      const r = await byName('edit_file').execute('t12', {
        path: 'dup.ts',
        old_string: 'foo',
        new_string: 'bar',
      });
      assert.match(textOf(r), /失败/);
      assert.match(textOf(r), /3 次/);
    });

    it('replace_all 替换所有匹配', async () => {
      const r = await byName('edit_file').execute('t13', {
        path: 'dup.ts',
        old_string: 'foo',
        new_string: 'bar',
        replace_all: true,
      });
      assert.match(textOf(r), /已修改/);
      assert.match(textOf(r), /3 处/);
      const content = await fs.promises.readFile(path.join(tmpDir, 'dup.ts'), 'utf-8');
      assert.equal(content, 'bar\nbar\nbar\n');
    });

    it('文件不存在返回错误（提示用 write_file）', async () => {
      const r = await byName('edit_file').execute('t14', {
        path: 'missing.ts',
        old_string: 'a',
        new_string: 'b',
      });
      assert.match(textOf(r), /失败/);
      assert.match(textOf(r), /write_file/);
    });
  });

  // ─── list_directory ──────────────────────────────────────────────

  describe('list_directory', () => {
    it('列出目录内容', async () => {
      const r = await byName('list_directory').execute('t15', { path: '.' });
      const text = textOf(r);
      assert.ok(text.includes('foo.ts'));
      assert.ok(text.includes('📁 sub/'));
    });

    it('空目录返回空目录提示', async () => {
      await fs.promises.mkdir(path.join(tmpDir, 'emptydir'), { recursive: true });
      const r = await byName('list_directory').execute('t16', { path: 'emptydir' });
      assert.match(textOf(r), /空目录/);
    });

    it('默认隐藏 dotfiles', async () => {
      await byName('write_file').execute('t17', { path: '.hidden', content: 'x' });
      const r = await byName('list_directory').execute('t18', { path: '.' });
      assert.ok(!textOf(r).includes('.hidden'));
    });
  });

  // ─── grep ────────────────────────────────────────────────────────

  describe('grep', () => {
    it('正则搜索命中', async () => {
      const r = await byName('grep').execute('t19', { pattern: 'console', path: '.' });
      const text = textOf(r);
      assert.ok(text.includes('foo.ts'));
      assert.ok(text.includes('console'));
    });

    it('glob 过滤文件类型', async () => {
      const r = await byName('grep').execute('t20', {
        pattern: 'export',
        glob: '*.ts',
      });
      assert.ok(textOf(r).includes('bar.ts'));
    });

    it('ignore_case 忽略大小写', async () => {
      await byName('write_file').execute('t21', {
        path: 'case.ts',
        content: 'const FOO = 1;\nconst foo = 2;\n',
      });
      const r = await byName('grep').execute('t22', {
        pattern: 'foo',
        path: 'case.ts',
        ignore_case: true,
      });
      const text = textOf(r);
      assert.ok(text.includes('FOO'));
      assert.ok(text.includes('foo'));
    });

    it('无匹配返回提示', async () => {
      const r = await byName('grep').execute('t23', {
        pattern: 'zzznotfound',
        path: '.',
      });
      assert.match(textOf(r), /未找到/);
    });

    it('无效正则返回错误', async () => {
      const r = await byName('grep').execute('t24', {
        pattern: '[invalid',
        path: '.',
      });
      assert.match(textOf(r), /失败/);
    });
  });

  // ─── glob ────────────────────────────────────────────────────────

  describe('glob', () => {
    it('**/*.ts 递归匹配所有 ts 文件', async () => {
      const r = await byName('glob').execute('t25', { pattern: '**/*.ts' });
      const text = textOf(r);
      assert.ok(text.includes('foo.ts'));
      assert.ok(text.includes('sub/bar.ts'));
    });

    it('无匹配返回提示', async () => {
      const r = await byName('glob').execute('t26', { pattern: '**/*.xyz' });
      assert.match(textOf(r), /未找到/);
    });

    it('指定子目录搜索', async () => {
      const r = await byName('glob').execute('t27', { pattern: '*.ts', path: 'sub' });
      assert.ok(textOf(r).includes('bar.ts'));
      assert.ok(!textOf(r).includes('foo.ts'));
    });
  });

  // ─── run_command（权限联动）──────────────────────────────────────

  describe('run_command', () => {
    it('allow：ls 放行并返回 exit 0', async () => {
      const r = await byName('run_command').execute('t28', { command: 'ls' });
      const text = textOf(r);
      assert.match(text, /exit 0/);
      assert.ok(!text.includes('失败'));
    });

    it('deny：rm 被权限策略拒绝', async () => {
      const r = await byName('run_command').execute('t29', { command: 'rm -rf foo' });
      assert.match(textOf(r), /拒绝/);
    });

    it('deny：sudo 被拒绝', async () => {
      const r = await byName('run_command').execute('t30', { command: 'sudo ls' });
      assert.match(textOf(r), /拒绝/);
    });

    it('confirm 无 confirmFn 时被拒绝', async () => {
      const r = await byName('run_command').execute('t31', { command: 'mkdir testdir' });
      assert.match(textOf(r), /拒绝/);
    });

    it('cwd 越界被拒绝', async () => {
      const r = await byName('run_command').execute('t32', {
        command: 'ls',
        cwd: '../../../etc',
      });
      assert.match(textOf(r), /失败/);
      assert.match(textOf(r), /边界/);
    });

    it('confirm + confirmFn=true 放行', async () => {
      const pm = new PermissionManager({
        confirmFn: async (_ctx: ConfirmContext): Promise<ConfirmResult> => true,
      });
      const localTools = createCodingTools({ workspace: tmpDir, permission: pm });
      const runCmd = localTools.find((t) => t.name === 'run_command')!;
      const r = await runCmd.execute('t33', { command: 'mkdir approved-dir' });
      assert.ok(!textOf(r).includes('拒绝'));
      assert.ok(fs.existsSync(path.join(tmpDir, 'approved-dir')));
    });

    // ─── 无 shell 执行（Phase 3-3）──────────────────────────────

    it('无 shell：引号参数保持单个 argv', async () => {
      // git show "HEAD" → argv = [git, show, HEAD]（引号被解析器剥除）
      const r = await byName('run_command').execute('t34', {
        command: 'git show "HEAD"',
        cwd: tmpDir,
      });
      const text = textOf(r);
      assert.match(text, /exit 0/, `应执行成功: ${text}`);
    });

    it('无 shell：env 前缀传给子进程', async () => {
      const r = await byName('run_command').execute('t35', {
        command: 'GIT_PAGER=cat git log -n 1',
        cwd: tmpDir,
      });
      assert.match(textOf(r), /exit 0/);
    });

    it('多语句串联（;）被拒绝', async () => {
      const r = await byName('run_command').execute('t36', {
        command: 'git status; rm -rf ~',
      });
      const text = textOf(r);
      assert.match(text, /多语句|串联/, `应拒绝多语句: ${text}`);
      assert.match(text, /失败/);
    });

    it('多语句串联（&&）被拒绝', async () => {
      const r = await byName('run_command').execute('t37', {
        command: 'ls && git status',
      });
      assert.match(textOf(r), /多语句|串联/);
    });

    it('管道 | 被拒绝（无 shell 执行）', async () => {
      // git status 命中只读 allow，但管道语法被无 shell 解析器拒绝
      const r = await byName('run_command').execute('t38', {
        command: 'git status | grep foo',
      });
      assert.match(textOf(r), /管道/);
    });

    it('通配符被拒绝（提示 glob 工具）', async () => {
      // ls 命中只读 allow，但未引用通配符被拒绝
      const r = await byName('run_command').execute('t39', { command: 'ls *.ts' });
      assert.match(textOf(r), /glob/);
    });

    it('重定向被拒绝（confirmFn 放行权限后由解析器拦截）', async () => {
      const pm = new PermissionManager({ confirmFn: async () => true });
      const localTools = createCodingTools({ workspace: tmpDir, permission: pm });
      const runCmd = localTools.find((t) => t.name === 'run_command')!;
      const r = await runCmd.execute('t40', { command: 'git diff > patch.txt' });
      assert.match(textOf(r), /重定向/);
      // 且不应真实写出文件
      assert.ok(!fs.existsSync(path.join(tmpDir, 'patch.txt')), '重定向不应写出文件');
    });
  });

  // ─── 沙箱边界（跨工具）──────────────────────────────────────────

  describe('沙箱边界', () => {
    it('read_file 越界路径被拒绝', async () => {
      const r = await byName('read_file').execute('t34', { path: '../../../etc/passwd' });
      assert.match(textOf(r), /失败/);
      assert.match(textOf(r), /边界/);
    });

    it('write_file 越界路径被拒绝', async () => {
      const r = await byName('write_file').execute('t35', {
        path: '../../../tmp/evil',
        content: 'x',
      });
      assert.match(textOf(r), /失败/);
      assert.match(textOf(r), /边界/);
    });

    it('read_file 经 symlink 指向 workspace 外被拒绝', async () => {
      // 外部目录 + workspace 内 symlink
      const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'outside-'));
      await fs.promises.writeFile(path.join(outside, 'secret.txt'), 'top secret');
      const link = path.join(tmpDir, 'evil-link');
      await fs.promises.symlink(outside, link, 'dir');

      try {
        const r = await byName('read_file').execute('t41', {
          path: 'evil-link/secret.txt',
        });
        const text = textOf(r);
        assert.match(text, /符号链接|边界/, `应拒绝 symlink 逃逸: ${text}`);
      } finally {
        await fs.promises.rm(outside, { recursive: true, force: true });
        await fs.promises.unlink(link).catch(() => {});
      }
    });

    it('write_file 经 symlink 指向 workspace 外被拒绝', async () => {
      const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'outside-'));
      const link = path.join(tmpDir, 'evil-write-link');
      await fs.promises.symlink(outside, link, 'dir');

      try {
        const r = await byName('write_file').execute('t42', {
          path: 'evil-write-link/pwned.txt',
          content: 'pwned',
        });
        const text = textOf(r);
        assert.match(text, /符号链接|边界/, `应拒绝 symlink 逃逸: ${text}`);
        // 外部目录不应被写入
        assert.ok(
          !fs.existsSync(path.join(outside, 'pwned.txt')),
          '外部目录不应被写入',
        );
      } finally {
        await fs.promises.rm(outside, { recursive: true, force: true });
        await fs.promises.unlink(link).catch(() => {});
      }
    });
  });
});
