/**
 * 存储级锁（多进程安全）测试：
 * - FileSessionStorage 文件锁：并发互斥 / 陈旧锁回收 / 超时 / release 幂等
 * - MemorySessionStorage 进程内锁：并发互斥
 * - Runtime 集成：两个 Runtime（模拟两个进程）共享同一 baseDir 并发写同一会话，
 *   存储锁保证读-改-写原子，不丢消息
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileSessionStorage } from '../session/file.ts';
import { MemorySessionStorage } from '../session/memory.ts';
import { AgentRuntime } from '../runtime/index.ts';
import type {
  StreamFn,
  StreamEvent,
  AssistantMessage,
} from '../core/index.ts';

function assistantReply(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: { input: 1, output: 1, total: 2 },
    timestamp: Date.now(),
  };
}

function delayedStreamFn(delayMs: number): StreamFn {
  return async function* (): AsyncGenerator<StreamEvent> {
    await new Promise(r => setTimeout(r, delayMs));
    yield { type: 'done', message: assistantReply('reply') };
  };
}

function userTexts(messages: { role: string; content: string | unknown[] }[]): string[] {
  return messages
    .filter(m => m.role === 'user')
    .map(m => (typeof m.content === 'string' ? m.content : ''));
}

async function tmpBaseDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'agentpack-lock-test-'));
}

// ─── FileSessionStorage 文件锁 ────────────────────────────────────

describe('FileSessionStorage 文件锁', () => {
  it('两个存储实例（模拟两进程）并发持锁同一 key 时互斥', async () => {
    const dir = await tmpBaseDir();
    const a = new FileSessionStorage({ baseDir: dir, lockRetryMs: 5 });
    const b = new FileSessionStorage({ baseDir: dir, lockRetryMs: 5 });

    // 模拟两进程各自的"读-改-写"临界区：进入时记录，离开前校验无重叠
    const events: string[] = [];
    const critical = async (who: string, ms: number) => {
      await (who === 'a' ? a : b).withLock('k', async () => {
        events.push(`${who}-enter`);
        await new Promise(r => setTimeout(r, ms));
        events.push(`${who}-exit`);
      });
    };

    await Promise.all([critical('a', 40), critical('b', 40)]);

    // 互斥：同一 key 的 enter/exit 不能交错（谁先抢到锁由调度决定，顺序不固定）
    assert.equal(events.length, 4, '两个临界区都应执行');
    assert.equal(events[1], `${events[0].split('-')[0]}-exit`, '临界区不得交错');
    assert.equal(events[3], `${events[2].split('-')[0]}-exit`, '临界区不得交错');

    // 锁文件应已清理
    await assert.rejects(
      fs.access(path.join(dir, '.locks', 'k.lock')),
      { code: 'ENOENT' },
      'release 后锁文件应被删除',
    );

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('陈旧锁回收：崩溃遗留的锁文件可被接管', async () => {
    const dir = await tmpBaseDir();
    const a = new FileSessionStorage({ baseDir: dir, lockStaleMs: 5 });

    // 模拟进程崩溃：手动创建过期的锁文件
    const lockFile = path.join(dir, '.locks', 'stale.lock');
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.writeFile(lockFile, '99999\n0\n');

    // 等待锁文件超过 stale 阈值后应能获取
    await new Promise(r => setTimeout(r, 20));
    await a.withLock('stale', async () => { /* 临界区 */ });

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('锁超时：锁文件被他人持有时超过 lockWaitMs 抛错', async () => {
    const dir = await tmpBaseDir();
    const a = new FileSessionStorage({ baseDir: dir, lockWaitMs: 40, lockRetryMs: 5 });

    // 手动占用锁（模拟另一进程长期持锁）
    const lockFile = path.join(dir, '.locks', 'held.lock');
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.writeFile(lockFile, '12345\n0\n');

    await assert.rejects(
      a.withLock('held', async () => {}),
      /获取会话锁超时/,
    );

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('release 幂等：重复调用不报错', async () => {
    const dir = await tmpBaseDir();
    const a = new FileSessionStorage({ baseDir: dir });

    const lock = await a.acquireLock('k');
    await lock.release();
    await lock.release(); // 第二次调用应为 no-op
    await a.withLock('k', async () => {}); // 锁已释放，可再次获取

    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ─── MemorySessionStorage 进程内锁 ────────────────────────────────

describe('MemorySessionStorage 进程内锁', () => {
  it('withLock 按 key 互斥', async () => {
    const store = new MemorySessionStorage();
    const events: string[] = [];

    const critical = async (who: string, ms: number) => {
      await store.withLock('k', async () => {
        events.push(`${who}-enter`);
        await new Promise(r => setTimeout(r, 30));
        events.push(`${who}-exit`);
      });
    };

    await Promise.all([critical('a', 0), critical('b', 0)]);
    assert.deepEqual(events, ['a-enter', 'a-exit', 'b-enter', 'b-exit']);
  });

  it('不同 key 互不阻塞', async () => {
    const store = new MemorySessionStorage();
    const started = Date.now();
    await Promise.all([
      store.withLock('k1', () => new Promise(r => setTimeout(r, 40))),
      store.withLock('k2', () => new Promise(r => setTimeout(r, 40))),
    ]);
    assert.ok(Date.now() - started < 70, '不同 key 应并行执行');
  });
});

// ─── Runtime 集成：跨实例共享存储 ──────────────────────────────────

describe('Runtime 存储锁集成', () => {
  it('两个 Runtime（模拟两进程）并发写同一会话不丢消息', async () => {
    const dir = await tmpBaseDir();
    // 各自独立的存储实例 + 各自独立的 Runtime = 模拟两个进程
    const r1 = AgentRuntime.create({
      streamFn: delayedStreamFn(50),
      sessionStorage: new FileSessionStorage({ baseDir: dir, lockRetryMs: 5 }),
    });
    const r2 = AgentRuntime.create({
      streamFn: delayedStreamFn(50),
      sessionStorage: new FileSessionStorage({ baseDir: dir, lockRetryMs: 5 }),
    });

    const p1 = r1.run({ message: 'turn-a', type: 'message', sessionKey: 'shared' });
    // 等 r1 进入流式阶段（持锁），此时 r2 发起写同一会话
    await new Promise(r => setTimeout(r, 20));
    const p2 = r2.run({ message: 'turn-b', type: 'message', sessionKey: 'shared' });

    const [res1, res2] = await Promise.all([p1, p2]);
    assert.equal(res1.success, true);
    assert.equal(res2.success, true);

    // 存储锁保证读-改-写原子：最终持久化包含两个 turn（不丢消息）
    const probe = new FileSessionStorage({ baseDir: dir });
    const stored = await probe.load('shared');
    assert.ok(stored, '会话应已持久化');
    assert.deepEqual(userTexts(stored.messages), ['turn-a', 'turn-b']);

    await Promise.all([r1.close(), r2.close()]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('流式请求同样持锁', async () => {
    const dir = await tmpBaseDir();
    const r = AgentRuntime.create({
      streamFn: delayedStreamFn(10),
      sessionStorage: new FileSessionStorage({ baseDir: dir }),
    });

    const chunks: string[] = [];
    for await (const chunk of r.stream({ message: 's', type: 'message', sessionKey: 'k' })) {
      chunks.push(chunk.type);
    }
    assert.ok(chunks.includes('done'));

    const stored = await new FileSessionStorage({ baseDir: dir }).load('k');
    assert.ok(stored && userTexts(stored.messages).includes('s'));

    await r.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('ephemeral 请求不加锁但正常完成', async () => {
    const dir = await tmpBaseDir();
    const r = AgentRuntime.create({
      streamFn: delayedStreamFn(10),
      sessionStorage: new FileSessionStorage({ baseDir: dir }),
    });

    const res = await r.run({
      message: 'ep',
      type: 'message',
      sessionKey: 'k',
      ephemeral: true,
    });
    assert.equal(res.success, true);
    // ephemeral 不落盘
    const stored = await new FileSessionStorage({ baseDir: dir }).load('k');
    assert.equal(stored, null);

    await r.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
