/**
 * 审批持久化（Phase 2）测试：
 * - FileApprovalStore / MemoryApprovalStore 单元：save / load / settle / 损坏隔离 / 审计
 * - createApprovalManager({ store }) 集成：create 落盘、结算清理 + 审计
 * - 重启恢复场景：restore() 恢复孤儿审批单、已过期立即结算、resolve 孤儿生效
 * - 未配置 store 时行为不变（restore 返回 0）
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createApprovalManager,
  FileApprovalStore,
  MemoryApprovalStore,
} from '../index.ts';
import type {
  ApprovalAuditRecord,
  PermissionRequest,
  StoredApproval,
} from '../core/index.ts';

function makePermReq(toolName: string): PermissionRequest {
  return {
    toolName,
    permissions: ['fs:write'],
    args: { path: '/tmp/x' },
    sessionKey: 's1',
    request: {} as PermissionRequest['request'],
    shared: new Map(),
  };
}

/** 轮询等待异步条件成立（fire-and-forget 持久化落盘时序） */
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.fail('waitFor timeout');
}

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipack-approval-'));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── FileApprovalStore 单元 ───────────────────────────────────────

describe('FileApprovalStore', () => {
  it('save → load 往返保持字段；settle 删除未决文件并追加审计', async () => {
    const dir = path.join(tmpDir, 'basic');
    const store = new FileApprovalStore({ baseDir: dir });
    const stored: StoredApproval = {
      id: 'apr_1',
      toolName: 'write_file',
      permissions: ['fs:write'],
      args: { path: '/tmp/a.txt' },
      sessionKey: 's1',
      createdAt: 12345,
      expiresAt: 99999,
    };

    await store.save(stored);
    const loaded = await store.load();
    assert.equal(loaded.length, 1);
    assert.deepEqual(loaded[0], stored);

    const record: ApprovalAuditRecord = {
      id: 'apr_1',
      toolName: 'write_file',
      status: 'approved',
      waitedMs: 100,
      reason: 'approved by human',
      settledAt: 100000,
    };
    await store.settle('apr_1', record);
    assert.equal((await store.load()).length, 0, 'settle 后未决列表应清空');

    const historyRaw = await fs.readFile(path.join(dir, 'history.jsonl'), 'utf8');
    const lines = historyRaw.trim().split('\n').map(l => JSON.parse(l) as ApprovalAuditRecord);
    assert.deepEqual(lines, [record]);

    // 幂等：重复 settle 不抛错
    await store.settle('apr_1', record);
  });

  it('损坏 JSON 隔离为 .corrupt，不阻塞其余审批单恢复', async () => {
    const dir = path.join(tmpDir, 'corrupt');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'apr_bad.json'), '{not json', 'utf8');
    const store = new FileApprovalStore({ baseDir: dir });
    await store.save({
      id: 'apr_good',
      toolName: 't',
      permissions: [],
      args: {},
      sessionKey: 's',
      createdAt: 1,
    });

    const loaded = await store.load();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, 'apr_good');
    await waitFor(async () =>
      (await fs.readdir(dir)).includes('apr_bad.json.corrupt'),
    );
  });

  it('load 按 createdAt 升序（恢复时结算顺序与创建顺序一致）', async () => {
    const store = new FileApprovalStore({ baseDir: path.join(tmpDir, 'order') });
    await store.save({
      id: 'apr_b', toolName: 't', permissions: [], args: {},
      sessionKey: 's', createdAt: 200,
    });
    await store.save({
      id: 'apr_a', toolName: 't', permissions: [], args: {},
      sessionKey: 's', createdAt: 100,
    });
    const loaded = await store.load();
    assert.deepEqual(loaded.map(a => a.id), ['apr_a', 'apr_b']);
  });
});

// ─── MemoryApprovalStore 单元 ─────────────────────────────────────

describe('MemoryApprovalStore', () => {
  it('save / load / settle / 审计记录', async () => {
    const store = new MemoryApprovalStore();
    await store.save({
      id: 'apr_m', toolName: 't', permissions: ['net:http'],
      args: { url: 'x' }, sessionKey: 's', createdAt: 1,
    });
    assert.equal((await store.load()).length, 1);
    await store.settle('apr_m', {
      id: 'apr_m', toolName: 't', status: 'denied',
      waitedMs: 5, reason: 'denied by human', settledAt: 2,
    });
    assert.equal((await store.load()).length, 0);
    assert.equal(store.auditRecords().length, 1);
    assert.equal(store.auditRecords()[0].status, 'denied');
  });
});

// ─── createApprovalManager({ store }) 集成 ────────────────────────

describe('createApprovalManager 持久化集成', () => {
  it('create 落盘（含权限请求核心字段）；resolve 结算清理 + 审计', async () => {
    const store = new MemoryApprovalStore();
    const mgr = createApprovalManager({ store });

    const approval = mgr.create(makePermReq('write_file'), { timeoutMs: 10_000 });
    await waitFor(async () => (await store.load()).length === 1);
    const persisted = (await store.load())[0];
    assert.equal(persisted.id, approval.id);
    assert.equal(persisted.toolName, 'write_file');
    assert.deepEqual(persisted.permissions, ['fs:write']);
    assert.deepEqual(persisted.args, { path: '/tmp/x' });
    assert.equal(persisted.sessionKey, 's1');
    assert.equal(persisted.createdAt, approval.createdAt);

    assert.equal(mgr.resolve(approval.id, true), true);
    await waitFor(async () => (await store.load()).length === 0);
    assert.equal(store.auditRecords().length, 1);
    assert.equal(store.auditRecords()[0].status, 'approved');
  });

  it('本地超时结算同样写回存储（timeout 审计）', async () => {
    const store = new MemoryApprovalStore();
    const mgr = createApprovalManager({ store });
    const approval = mgr.create(makePermReq('t'), { timeoutMs: 15 });
    await mgr.wait(approval);
    await waitFor(() => store.auditRecords().length === 1);
    assert.equal(store.auditRecords()[0].status, 'timeout');
    assert.equal((await store.load()).length, 0);
  });

  it('未配置 store：restore() 返回 0，行为与 Phase 1 一致', async () => {
    const mgr = createApprovalManager();
    assert.equal(await mgr.restore(), 0);
    const approval = mgr.create(makePermReq('t'));
    assert.equal(mgr.resolve(approval.id, true), true);
    assert.equal((await mgr.wait(approval)).status, 'approved');
  });
});

// ─── 重启恢复场景（核心）────────────────────────────────────────

describe('进程重启恢复', () => {
  it('restore() 恢复孤儿审批单：list 可见、restored 标记、可 resolve 且结算持久化', async () => {
    const store = new MemoryApprovalStore();

    // 进程 A：创建两条未决审批单后"崩溃"（不结算）
    const mgrA = createApprovalManager({ store });
    mgrA.create(makePermReq('deploy'), { timeoutMs: 60_000 });
    mgrA.create(makePermReq('write_file'), { timeoutMs: 60_000 });
    await waitFor(async () => (await store.load()).length === 2);

    // 进程 B：同 store 新建 manager，重启恢复
    const pendingSeen: string[] = [];
    const mgrB = createApprovalManager({ store });
    mgrB.onPending(a => pendingSeen.push(a.id));
    const restoredCount = await mgrB.restore();

    assert.equal(restoredCount, 2);
    const list = mgrB.list();
    assert.equal(list.length, 2);
    assert.ok(list.every(a => a.restored === true), '恢复的审批单应带 restored 标记');
    assert.equal(list[0].request.toolName, 'deploy', '恢复顺序按创建时间');
    assert.equal(pendingSeen.length, 2, '恢复时逐条触发 onPending（UI 启动感知）');

    // 批准孤儿审批单：生效并持久化结算（无等待方，但审计可查）
    const deploy = list[0];
    assert.equal(mgrB.resolve(deploy.id, true), true);
    await waitFor(async () => (await store.load()).length === 1);
    const audits = store.auditRecords();
    assert.equal(audits.length, 1);
    assert.equal(audits[0].status, 'approved');
    assert.equal(audits[0].toolName, 'deploy');

    // 未决审批单保留在存储中（模拟崩溃的 mgrA 与余下 pending 均不结算）
    mgrA.close();
    mgrB.close();
  });

  it('恢复时已过期的审批单立即以 timeout 结算，不进入 pending 列表', async () => {
    const store = new MemoryApprovalStore();
    // 模拟重启遗留：手工写入一条已过期审批单
    await store.save({
      id: 'apr_stale',
      toolName: 'old_tool',
      permissions: ['fs:write'],
      args: {},
      sessionKey: 's',
      createdAt: Date.now() - 120_000,
      expiresAt: Date.now() - 60_000, // 已过期 1 分钟
    });

    const mgr = createApprovalManager({ store });
    const settledSeen: string[] = [];
    mgr.onSettled(o => settledSeen.push(o.status));
    const restoredCount = await mgr.restore();

    assert.equal(restoredCount, 0, '已过期的不应恢复为 pending');
    assert.equal(mgr.list().length, 0);
    assert.deepEqual(settledSeen, ['timeout'], '立即以 timeout 结算');
    await waitFor(async () => (await store.load()).length === 0);
    assert.equal(store.auditRecords().length, 1);
    assert.equal(store.auditRecords()[0].status, 'timeout');
    assert.ok(store.auditRecords()[0].waitedMs >= 120_000, 'waitedMs 按真实等待时长计');
  });

  it('FileApprovalStore 端到端：落盘 → 模拟重启 → 恢复 → 驳回清理', async () => {
    const dir = path.join(tmpDir, 'e2e');
    const storeA = new FileApprovalStore({ baseDir: dir });
    const mgrA = createApprovalManager({ store: storeA });
    const approval = mgrA.create(makePermReq('shell_exec'), { timeoutMs: 60_000 });
    await waitFor(async () => (await storeA.load()).length === 1);

    // 模拟重启：全新 store + manager 实例（同目录）
    const storeB = new FileApprovalStore({ baseDir: dir });
    const mgrB = createApprovalManager({ store: storeB });
    assert.equal(await mgrB.restore(), 1);
    assert.equal(mgrB.list().length, 1);
    assert.equal(mgrB.list()[0].request.toolName, 'shell_exec');
    assert.deepEqual(mgrB.list()[0].request.args, { path: '/tmp/x' });

    assert.equal(mgrB.resolve(approval.id, false), true);
    await waitFor(async () => (await storeB.load()).length === 0);
    const historyRaw = await fs.readFile(path.join(dir, 'history.jsonl'), 'utf8');
    const records = historyRaw.trim().split('\n').map(l => JSON.parse(l) as ApprovalAuditRecord);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'denied');
    mgrA.close();
    mgrB.close();
  });

  it('重复 restore 幂等：内存已有的审批单不重复登记', async () => {
    const store = new MemoryApprovalStore();
    const mgrA = createApprovalManager({ store });
    mgrA.create(makePermReq('t'), { timeoutMs: 60_000 });
    await waitFor(async () => (await store.load()).length === 1);

    // 模拟重启后的进程：第一次恢复 1 条，重复 restore 不再登记
    const mgrB = createApprovalManager({ store });
    assert.equal(await mgrB.restore(), 1);
    assert.equal(await mgrB.restore(), 0, '第二次 restore 不重复登记');
    assert.equal(mgrB.list().length, 1);
    mgrA.close();
    mgrB.close();
  });
});
