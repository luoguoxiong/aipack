/**
 * 工具函数单元测试：路径沙箱校验 + 文本工具。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { resolveWithin, expandHome } from '../src/utils/path';
import {
  formatLineNumbers,
  isBinary,
  countOccurrences,
  globToRegex,
  walkDir,
} from '../src/utils/text';

// ─── resolveWithin（沙箱边界校验）──────────────────────────────────

describe('resolveWithin', () => {
  const ws = '/tmp/workspace';

  it('正常相对路径解析', () => {
    const r = resolveWithin(ws, 'src/foo.ts');
    assert.equal(r.ok, true);
    assert.equal(r.abs, '/tmp/workspace/src/foo.ts');
    assert.equal(r.rel, 'src/foo.ts');
  });

  it('根目录（.）', () => {
    const r = resolveWithin(ws, '.');
    assert.equal(r.ok, true);
    assert.equal(r.abs, '/tmp/workspace');
    assert.equal(r.rel, '.');
  });

  it('多层子目录路径', () => {
    const r = resolveWithin(ws, 'a/b/c.ts');
    assert.equal(r.ok, true);
    assert.equal(r.rel, 'a/b/c.ts');
  });

  it('越界路径（../../../etc/passwd）应失败', () => {
    const r = resolveWithin(ws, '../../../etc/passwd');
    assert.equal(r.ok, false);
    assert.ok(r.error);
    assert.match(r.error!, /超出 workspace 边界/);
  });

  it('空路径应失败', () => {
    const r = resolveWithin(ws, '');
    assert.equal(r.ok, false);
    assert.ok(r.error);
  });

  it('纯空白路径应失败', () => {
    const r = resolveWithin(ws, '   ');
    assert.equal(r.ok, false);
  });
});

// ─── expandHome ────────────────────────────────────────────────────

describe('expandHome', () => {
  it('~ 展开为家目录', () => {
    process.env.HOME = '/Users/test';
    assert.equal(expandHome('~'), '/Users/test');
  });

  it('~/ 展开为家目录拼接', () => {
    process.env.HOME = '/Users/test';
    assert.equal(expandHome('~/foo/bar'), '/Users/test/foo/bar');
  });

  it('普通绝对路径不展开', () => {
    assert.equal(expandHome('/abs/path'), '/abs/path');
  });

  it('相对路径不展开', () => {
    assert.equal(expandHome('rel/path'), 'rel/path');
  });
});

// ─── formatLineNumbers ─────────────────────────────────────────────

describe('formatLineNumbers', () => {
  it('基本行号格式化（含 tab 分隔）', () => {
    const result = formatLineNumbers('hello\nworld');
    assert.match(result, /1\thello/);
    assert.match(result, /2\tworld/);
  });

  it('空内容返回空串', () => {
    assert.equal(formatLineNumbers(''), '');
  });

  it('startLine 偏移生效', () => {
    const result = formatLineNumbers('foo\nbar', 10);
    assert.match(result, /10\tfoo/);
    assert.match(result, /11\tbar/);
  });

  it('末尾换行不多算行', () => {
    // 'a\n' split → ['a', '']，移除末尾空串 → 仅 1 行
    const result = formatLineNumbers('a\n');
    assert.match(result, /1\ta/);
    assert.doesNotMatch(result, /2\t/);
  });

  it('行号至少 6 位宽', () => {
    const result = formatLineNumbers('x');
    // 行号 1 应被 padStart 到至少 6 位
    assert.match(result, /^\s{5}1\tx$/);
  });
});

// ─── isBinary ──────────────────────────────────────────────────────

describe('isBinary', () => {
  it('纯文本非二进制', () => {
    assert.equal(isBinary(Buffer.from('hello world')), false);
  });

  it('含 NUL 字节为二进制', () => {
    assert.equal(isBinary(Buffer.from([0x68, 0x00, 0x69])), true);
  });

  it('空 buffer 非二进制', () => {
    assert.equal(isBinary(Buffer.alloc(0)), false);
  });

  it('NUL 在 8KB 之外不判定为二进制', () => {
    // 8KB 文本 + 末尾 NUL
    const buf = Buffer.alloc(8193, 0x61);
    buf[8192] = 0;
    assert.equal(isBinary(buf), false);
  });
});

// ─── countOccurrences ──────────────────────────────────────────────

describe('countOccurrences', () => {
  it('基本计数', () => {
    assert.equal(countOccurrences('foo foo foo', 'foo'), 3);
  });

  it('无匹配返回 0', () => {
    assert.equal(countOccurrences('hello', 'world'), 0);
  });

  it('空 needle 返回 0', () => {
    assert.equal(countOccurrences('hello', ''), 0);
  });

  it('重叠不计数（非重叠匹配）', () => {
    // 'aaa' 中 'aa' 非重叠：索引 0 匹配一次，跳到索引 2，剩余 'a' 不匹配
    assert.equal(countOccurrences('aaa', 'aa'), 1);
  });

  it('子串长度等于 haystack', () => {
    assert.equal(countOccurrences('abc', 'abc'), 1);
  });
});

// ─── globToRegex ───────────────────────────────────────────────────

describe('globToRegex', () => {
  it('* 单层通配（不含 /）', () => {
    const re = globToRegex('*.ts');
    assert.ok(re.test('foo.ts'));
    assert.ok(!re.test('foo.js'));
    assert.ok(!re.test('a/b.ts')); // * 不跨目录
  });

  it('** 多层通配（含 /）', () => {
    const re = globToRegex('**/*.ts');
    assert.ok(re.test('foo.ts'));
    assert.ok(re.test('a/b.ts'));
    assert.ok(re.test('src/deep/nested/file.ts'));
  });

  it('? 单字符通配', () => {
    const re = globToRegex('?.ts');
    assert.ok(re.test('a.ts'));
    assert.ok(!re.test('ab.ts'));
  });

  it('{a,b} 分支', () => {
    const re = globToRegex('*.{ts,js}');
    assert.ok(re.test('foo.ts'));
    assert.ok(re.test('foo.js'));
    assert.ok(!re.test('foo.css'));
  });

  it('点号被转义（不匹配任意字符）', () => {
    const re = globToRegex('foo.txt');
    assert.ok(re.test('foo.txt'));
    assert.ok(!re.test('foottxt')); // 若点号未转义则会匹配
  });

  it('精确文件名匹配', () => {
    const re = globToRegex('package.json');
    assert.ok(re.test('package.json'));
    assert.ok(!re.test('package-json'));
  });
});

// ─── walkDir ───────────────────────────────────────────────────────

describe('walkDir', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'walk-test-'));
    // 结构：
    //   tmpDir/a.ts
    //   tmpDir/b.js
    //   tmpDir/sub/c.ts
    //   tmpDir/node_modules/d.ts  ← 应被跳过
    await fs.promises.writeFile(path.join(tmpDir, 'a.ts'), '');
    await fs.promises.writeFile(path.join(tmpDir, 'b.js'), '');
    await fs.promises.mkdir(path.join(tmpDir, 'sub'), { recursive: true });
    await fs.promises.writeFile(path.join(tmpDir, 'sub/c.ts'), '');
    await fs.promises.mkdir(path.join(tmpDir, 'node_modules'), { recursive: true });
    await fs.promises.writeFile(path.join(tmpDir, 'node_modules/d.ts'), '');
  });

  after(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('递归遍历所有文件', async () => {
    const files = await walkDir(tmpDir);
    const names = files.map((f) => path.relative(tmpDir, f)).sort();
    assert.ok(names.includes('a.ts'));
    assert.ok(names.includes('b.js'));
    assert.ok(names.includes('sub/c.ts'));
  });

  it('默认跳过 node_modules', async () => {
    const files = await walkDir(tmpDir);
    const names = files.map((f) => path.relative(tmpDir, f));
    assert.ok(!names.some((n) => n.includes('node_modules')));
  });

  it('maxFiles 限制生效', async () => {
    const files = await walkDir(tmpDir, { maxFiles: 1 });
    assert.ok(files.length <= 1);
  });
});
