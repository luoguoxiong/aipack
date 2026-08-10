/**
 * transformer 扩展测试：StateSnapshotTransformer / SystemMessageCleanerTransformer
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  StateSnapshotTransformer,
  SystemMessageCleanerTransformer,
} from '../transformer/index.ts';
import type { ContextResource, TransformContext, Message } from '../core/index.ts';
import { createTaskGraph, createTextContent } from '../core/index.ts';
import { messagesToResources } from '../context-resource/index.ts';

function ctx(): TransformContext {
  return {
    graph: createTaskGraph(),
    runtime: { sessionKey: 's', turn: 0 },
  };
}

function userMsg(text: string, ts = Date.now()): Message {
  return { role: 'user', content: text, timestamp: ts };
}

function assistantMsg(text: string, ts = Date.now()): Message {
  return {
    role: 'assistant',
    content: text ? [createTextContent(text)] : [],
    stopReason: 'stop',
    timestamp: ts,
  } as Message;
}

function systemMsg(text: string, ts = Date.now()): Message {
  return { role: 'system', content: text, timestamp: ts } as Message;
}

// ─── StateSnapshotTransformer ──────────────────────────────────────

describe('StateSnapshotTransformer', () => {
  it('注入状态快照到资源列表开头', async () => {
    const transformer = new StateSnapshotTransformer(() => 'current state');
    const resources = messagesToResources([userMsg('hi')]);
    const result = await transformer.transform(resources, ctx());
    assert.equal(result.length, 2);
    assert.equal(result[0].type, 'state_snapshot');
    assert.equal(result[0].content, 'current state');
    assert.equal(result[0].role, 'system');
    assert.equal(result[0].pinned, true);
  });

  it('快照为 null 时不注入', async () => {
    const transformer = new StateSnapshotTransformer(() => null);
    const resources = messagesToResources([userMsg('hi')]);
    const result = await transformer.transform(resources, ctx());
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'user_message');
  });

  it('快照为空字符串时不注入（falsy 检查）', async () => {
    const transformer = new StateSnapshotTransformer(() => '');
    const resources = messagesToResources([userMsg('hi')]);
    const result = await transformer.transform(resources, ctx());
    // 空字符串是 falsy，不会注入
    assert.equal(result.length, 1);
  });

  it('空资源列表时只返回快照', async () => {
    const transformer = new StateSnapshotTransformer(() => 'snap');
    const result = await transformer.transform([], ctx());
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'state_snapshot');
  });

  it('快照内容每次调用动态获取', async () => {
    let count = 0;
    const transformer = new StateSnapshotTransformer(() => `state-${++count}`);
    const resources = messagesToResources([userMsg('hi')]);
    const r1 = await transformer.transform(resources, ctx());
    const r2 = await transformer.transform(resources, ctx());
    assert.equal(r1[0].content, 'state-1');
    assert.equal(r2[0].content, 'state-2');
  });
});

// ─── SystemMessageCleanerTransformer ───────────────────────────────

describe('SystemMessageCleanerTransformer', () => {
  it('保留单条系统消息', async () => {
    const transformer = new SystemMessageCleanerTransformer();
    const resources = messagesToResources([
      systemMsg('only one'),
      userMsg('hi'),
    ]);
    const result = await transformer.transform(resources, ctx());
    const systemCount = result.filter(r => r.type === 'system_message').length;
    assert.equal(systemCount, 1);
  });

  it('多条系统消息只保留最后一条', async () => {
    const transformer = new SystemMessageCleanerTransformer();
    const resources = messagesToResources([
      systemMsg('first'),
      userMsg('hi'),
      systemMsg('second'),
      systemMsg('third'),
    ]);
    const result = await transformer.transform(resources, ctx());
    const systemMessages = result.filter(r => r.type === 'system_message');
    assert.equal(systemMessages.length, 1);
    assert.equal(systemMessages[0].content, 'third');
  });

  it('无系统消息时原样返回', async () => {
    const transformer = new SystemMessageCleanerTransformer();
    const resources = messagesToResources([
      userMsg('hi'),
      assistantMsg('hello'),
    ]);
    const result = await transformer.transform(resources, ctx());
    assert.equal(result.length, 2);
  });

  it('非系统消息不受影响', async () => {
    const transformer = new SystemMessageCleanerTransformer();
    const resources = messagesToResources([
      systemMsg('sys1'),
      systemMsg('sys2'),
      userMsg('user1'),
      assistantMsg('asst1'),
    ]);
    const result = await transformer.transform(resources, ctx());
    assert.equal(result.length, 3); // 2 sys -> 1 sys, user + asst 不变
    const types = result.map(r => r.type);
    assert.ok(types.includes('user_message'));
    assert.ok(types.includes('assistant_message'));
  });

  it('空资源列表原样返回', async () => {
    const transformer = new SystemMessageCleanerTransformer();
    const result = await transformer.transform([], ctx());
    assert.equal(result.length, 0);
  });
});
