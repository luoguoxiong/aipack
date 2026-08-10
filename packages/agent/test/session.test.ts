/**
 * session 模块扩展测试：FileSessionStorage 的 maxStoredMessages / list 过滤 /
 * encode-decode key / baseDir 解析；MemorySessionStorage 边界
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  FileSessionStorage,
  createFileSessionStorage,
} from '../session/file.ts';
import {
  MemorySessionStorage,
  createMemorySessionStorage,
} from '../session/memory.ts';
import type { StoredSession } from '../core/index.ts';

// ─── 辅助工厂 ─────────────────────────────────────────────────────

function makeSession(key: string, messageCount = 0): StoredSession {
  const messages = Array.from({ length: messageCount }, (_, i) => ({
    role: 'user' as const,
    content: `msg ${i}`,
    timestamp: Date.now() + i,
  }));
  return {
    key,
    version: 1,
    messages,
    model: null,
    usage: { input: 0, output: 0, total: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ─── FileSessionStorage: maxStoredMessages ─────────────────────────

describe('FileSessionStorage maxStoredMessages', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = `/tmp/aipack-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });

  afterEach(async () => {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('保存时截断消息到上限', async () => {
    const store = new FileSessionStorage({ baseDir: tmpDir, maxStoredMessages: 3 });
    await store.save('s1', makeSession('s1', 10));
    const loaded = await store.load('s1');
    assert.ok(loaded);
    assert.equal(loaded!.messages.length, 3);
    // 保留最新 3 条（尾部）
    assert.equal(loaded!.messages[0].content, 'msg 7');
    assert.equal(loaded!.messages[2].content, 'msg 9');
  });

  it('maxStoredMessages=0 不截断', async () => {
    const store = new FileSessionStorage({ baseDir: tmpDir, maxStoredMessages: 0 });
    await store.save('s1', makeSession('s1', 5));
    const loaded = await store.load('s1');
    assert.equal(loaded!.messages.length, 5);
  });

  it('消息数未超上限时不截断', async () => {
    const store = new FileSessionStorage({ baseDir: tmpDir, maxStoredMessages: 10 });
    await store.save('s1', makeSession('s1', 3));
    const loaded = await store.load('s1');
    assert.equal(loaded!.messages.length, 3);
  });
});

// ─── FileSessionStorage: list 过滤 ─────────────────────────────────

describe('FileSessionStorage list', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = `/tmp/aipack-test-list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });

  afterEach(async () => {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('列出所有未过期的会话 key', async () => {
    const store = new FileSessionStorage({ baseDir: tmpDir });
    await store.save('key-a', makeSession('key-a'));
    await store.save('key-b', makeSession('key-b'));
    const keys = await store.list();
    assert.ok(keys.includes('key-a'));
    assert.ok(keys.includes('key-b'));
  });

  it('list 时清理过期会话', async () => {
    const store = new FileSessionStorage({ baseDir: tmpDir, maxAge: 50 });
    await store.save('expired', {
      ...makeSession('expired'),
      createdAt: new Date(Date.now() - 1000).toISOString(),
      updatedAt: new Date(Date.now() - 1000).toISOString(),
    });
    await new Promise(r => setTimeout(r, 80));
    // 等待后再保存 fresh，确保它未过期
    await store.save('fresh', makeSession('fresh'));
    const keys = await store.list();
    assert.ok(!keys.includes('expired'), '过期会话不应出现在 list');
    assert.ok(keys.includes('fresh'));
  });

  it('list 忽略 .tmp 文件', async () => {
    const store = new FileSessionStorage({ baseDir: tmpDir });
    await store.save('keep', makeSession('keep'));
    // 创建临时文件
    await fs.writeFile(path.join(tmpDir, 'temp.tmp'), 'temp');
    const keys = await store.list();
    assert.ok(keys.includes('keep'));
    assert.ok(!keys.some(k => k.includes('temp')));
  });

  it('list 目录不存在时返回空数组', async () => {
    const store = new FileSessionStorage({ baseDir: '/tmp/nonexistent-dir-xyz' });
    const keys = await store.list();
    assert.deepEqual(keys, []);
  });
});

// ─── FileSessionStorage: key 编码解码 ──────────────────────────────

describe('FileSessionStorage key 编码', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = `/tmp/aipack-test-enc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });

  afterEach(async () => {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('特殊字符的 sessionKey 正确保存和加载', async () => {
    const store = new FileSessionStorage({ baseDir: tmpDir });
    const specialKey = 'webhook:channel/user?id=123&token=abc';
    await store.save(specialKey, makeSession(specialKey));
    const loaded = await store.load(specialKey);
    assert.ok(loaded);
    assert.equal(loaded!.key, specialKey);
  });

  it('中文 sessionKey 正确保存和加载', async () => {
    const store = new FileSessionStorage({ baseDir: tmpDir });
    const cnKey = '会话/测试/键';
    await store.save(cnKey, makeSession(cnKey));
    const loaded = await store.load(cnKey);
    assert.ok(loaded);
    assert.equal(loaded!.key, cnKey);
  });

  it('list 返回解码后的原始 key', async () => {
    const store = new FileSessionStorage({ baseDir: tmpDir });
    await store.save('path/to/session', makeSession('path/to/session'));
    const keys = await store.list();
    assert.ok(keys.includes('path/to/session'));
  });
});

// ─── FileSessionStorage: baseDir 解析 ──────────────────────────────

describe('FileSessionStorage baseDir', () => {
  it('绝对路径直接使用', () => {
    const store = new FileSessionStorage({ baseDir: '/tmp/abs-test' });
    assert.equal(store.dir, '/tmp/abs-test');
  });

  it('相对路径基于 cwd', () => {
    const store = new FileSessionStorage({ baseDir: 'relative/path' });
    assert.equal(store.dir, path.join(process.cwd(), 'relative/path'));
  });

  it('~ 展开为 home 目录', () => {
    const store = new FileSessionStorage({ baseDir: '~/sessions' });
    assert.ok(store.dir.startsWith(os.homedir()));
  });

  it('未指定时使用默认路径', () => {
    const store = new FileSessionStorage({});
    assert.equal(store.dir, path.join(process.cwd(), '.aipack', 'sessions'));
  });
});

// ─── FileSessionStorage: 原子写入 ──────────────────────────────────

describe('FileSessionStorage 原子写入', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = `/tmp/aipack-test-atomic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });

  afterEach(async () => {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('保存后不残留 .tmp 文件', async () => {
    const store = new FileSessionStorage({ baseDir: tmpDir });
    await store.save('s1', makeSession('s1'));
    const files = await fs.readdir(tmpDir);
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    assert.equal(tmpFiles.length, 0);
  });

  it('覆盖保存同一 key', async () => {
    const store = new FileSessionStorage({ baseDir: tmpDir });
    await store.save('s1', makeSession('s1', 1));
    await store.save('s1', makeSession('s1', 5));
    const loaded = await store.load('s1');
    assert.equal(loaded!.messages.length, 5);
  });
});

// ─── FileSessionStorage: delete ────────────────────────────────────

describe('FileSessionStorage delete', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = `/tmp/aipack-test-del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });

  afterEach(async () => {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('删除存在的会话返回 true', async () => {
    const store = new FileSessionStorage({ baseDir: tmpDir });
    await store.save('s1', makeSession('s1'));
    assert.equal(await store.delete('s1'), true);
    assert.equal(await store.load('s1'), null);
  });

  it('删除不存在的会话返回 false', async () => {
    const store = new FileSessionStorage({ baseDir: tmpDir });
    assert.equal(await store.delete('not-exist'), false);
  });
});

// ─── FileSessionStorage: 损坏文件 ──────────────────────────────────

describe('FileSessionStorage 容错', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = `/tmp/aipack-test-corrupt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });

  afterEach(async () => {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('load 损坏文件返回 null', async () => {
    const store = new FileSessionStorage({ baseDir: tmpDir });
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'bad.json'), 'not json');
    const loaded = await store.load('bad');
    assert.equal(loaded, null);
  });

  it('list 跳过损坏文件（maxAge 启用时）', async () => {
    const store = new FileSessionStorage({ baseDir: tmpDir, maxAge: 60000 });
    await store.save('good', makeSession('good'));
    await fs.writeFile(path.join(tmpDir, 'broken.json'), 'corrupted');
    const keys = await store.list();
    assert.ok(keys.includes('good'));
    assert.ok(!keys.some(k => k.includes('broken')));
  });
});

// ─── MemorySessionStorage 扩展 ─────────────────────────────────────

describe('MemorySessionStorage 扩展', () => {
  it('save 覆盖旧数据', async () => {
    const store = new MemorySessionStorage();
    await store.save('s1', makeSession('s1', 1));
    await store.save('s1', makeSession('s1', 5));
    const loaded = await store.load('s1');
    assert.equal(loaded!.messages.length, 5);
  });

  it('delete 不存在的 key 返回 false', async () => {
    const store = new MemorySessionStorage();
    assert.equal(await store.delete('not-exist'), false);
  });

  it('delete 存在的 key 返回 true', async () => {
    const store = new MemorySessionStorage();
    await store.save('s1', makeSession('s1'));
    assert.equal(await store.delete('s1'), true);
    assert.equal(await store.load('s1'), null);
  });

  it('list 清理过期会话', async () => {
    const store = new MemorySessionStorage({ maxAge: 50 });
    await store.save('expired', {
      ...makeSession('expired'),
      createdAt: new Date(Date.now() - 1000).toISOString(),
      updatedAt: new Date(Date.now() - 1000).toISOString(),
    });
    await new Promise(r => setTimeout(r, 80));
    // 等待后再保存 fresh，确保它未过期
    await store.save('fresh', makeSession('fresh'));
    const keys = await store.list();
    assert.ok(!keys.includes('expired'));
    assert.ok(keys.includes('fresh'));
  });

  it('load 过期会话返回 null 并删除', async () => {
    const store = new MemorySessionStorage({ maxAge: 50 });
    await store.save('s1', {
      ...makeSession('s1'),
      createdAt: new Date(Date.now() - 1000).toISOString(),
      updatedAt: new Date(Date.now() - 1000).toISOString(),
    });
    await new Promise(r => setTimeout(r, 80));
    assert.equal(await store.load('s1'), null);
    // 第二次 load 也应返回 null（已删除）
    assert.equal(await store.load('s1'), null);
  });

  it('无 maxAge 时永不过期', async () => {
    const store = new MemorySessionStorage();
    await store.save('s1', {
      ...makeSession('s1'),
      createdAt: new Date(Date.now() - 100000).toISOString(),
      updatedAt: new Date(Date.now() - 100000).toISOString(),
    });
    const loaded = await store.load('s1');
    assert.ok(loaded);
  });

  it('createMemorySessionStorage 工厂返回实例', () => {
    const store = createMemorySessionStorage();
    assert.ok(store instanceof MemorySessionStorage);
  });

  it('createFileSessionStorage 工厂返回实例', () => {
    const store = createFileSessionStorage({ baseDir: '/tmp/factory-test' });
    assert.ok(store instanceof FileSessionStorage);
  });
});
