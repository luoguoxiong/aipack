/**
 * CLI 审批集成测试：
 * - setupApprovals：未启用返回 undefined；启用后便捷 policy 的命中规则
 *   （工具名精确 / 能力声明粒度互换 / 粗粒度声明涵盖危险能力）
 * - settleApproval / listPendingApprovals：文件存储端到端（孤儿审批单处理链路）
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { PermissionRequest } from '@aipack-ai/agent';
import { setupApprovals, settleApproval, listPendingApprovals } from '../src/approvals';
import type { AipackConfig } from '../src/config';

function makeConfig(baseDir: string, enabled = true, tools?: string[]): AipackConfig {
  return {
    provider: 'openai',
    model: 'gpt-4o-mini',
    systemPrompt: '',
    workspace: process.cwd(),
    sessionKey: 'test',
    sessions: { enabled: false, baseDir },
    approvals: {
      enabled,
      tools: tools ?? ['shell', 'fs:write', 'fs:delete', 'net'],
      baseDir,
      timeoutMs: 300_000,
    },
  };
}

function makePermReq(toolName: string, permissions: string[]): PermissionRequest {
  return {
    toolName,
    permissions,
    args: {},
    sessionKey: 's',
    request: {} as PermissionRequest['request'],
    shared: new Map(),
  };
}

let tmpDir: string;

before(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cli-approvals-'));
});

after(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe('setupApprovals', () => {
  it('未启用时返回 undefined', () => {
    assert.equal(setupApprovals(makeConfig(tmpDir, false)), undefined);
  });

  it('便捷 policy：工具名精确命中 → pending', async () => {
    const setup = setupApprovals(makeConfig(path.join(tmpDir, 'a1')))!;
    assert.ok(setup, '启用时应返回 setup');
    assert.equal(await setup.policy!.check(makePermReq('shell', [])), 'pending');
    assert.equal(await setup.policy!.check(makePermReq('read_file', ['fs:read'])), 'allow');
    setup.approvals.close();
  });

  it('便捷 policy：能力声明粒度互换命中（声明 fs:write:tmp / 粗粒度 fs）', async () => {
    const setup = setupApprovals(makeConfig(path.join(tmpDir, 'a2')))!;
    // 工具声明更细粒度：fs:write:tmp 命中规则 fs:write
    assert.equal(await setup.policy!.check(makePermReq('x', ['fs:write:tmp'])), 'pending');
    // 工具粗粒度声明 fs 涵盖危险能力 fs:write → 命中
    assert.equal(await setup.policy!.check(makePermReq('y', ['fs'])), 'pending');
    // 无关能力不命中
    assert.equal(await setup.policy!.check(makePermReq('z', ['fs:read', 'web:search'])), 'allow');
    setup.approvals.close();
  });

  it('用户已显式配置 permissionPolicy 时不注入便捷策略（仅提供 manager）', () => {
    const config = makeConfig(path.join(tmpDir, 'a3'));
    config.runtime = {
      permissionPolicy: { async check() { return 'allow'; } },
    };
    const setup = setupApprovals(config)!;
    assert.equal(setup.policy, undefined, '不应覆盖用户显式配置的 policy');
    assert.ok(setup.approvals, 'manager 仍应提供（policy 可自行返回 pending）');
    setup.approvals.close();
  });
});

describe('approvals 子命令端到端', () => {
  it('list 为空 → 人工落盘一条 → approve 生效并清理', async () => {
    const baseDir = path.join(tmpDir, 'cmd');
    const config = makeConfig(baseDir);

    // 初始为空
    assert.deepEqual(await listPendingApprovals(config), []);

    // 人工写入一条未决审批单（模拟 CLI 进程崩溃遗留）
    const stored = {
      id: 'apr_manual_1',
      toolName: 'shell',
      permissions: ['shell'],
      args: { cmd: 'rm -rf /tmp/x' },
      sessionKey: 's',
      createdAt: Date.now() - 1000,
    };
    await fs.promises.mkdir(baseDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(baseDir, `${stored.id}.json`),
      JSON.stringify(stored),
    );

    // list 可见
    const pendingList = await listPendingApprovals(config);
    assert.equal(pendingList.length, 1);
    assert.equal(pendingList[0].toolName, 'shell');

    // 批准生效（结算 + 审计）
    assert.equal(await settleApproval(config, 'apr_manual_1', true), 'settled');
    assert.deepEqual(await listPendingApprovals(config), [], '结算后未决清空');
    const history = await fs.promises.readFile(
      path.join(baseDir, 'history.jsonl'),
      'utf8',
    );
    assert.ok(history.includes('"status":"approved"'), '审计应记录 approved');

    // 重复处理 → not-found
    assert.equal(await settleApproval(config, 'apr_manual_1', true), 'not-found');
    assert.equal(await settleApproval(config, 'apr_unknown', false), 'not-found');
  });
});
