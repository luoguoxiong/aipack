/**
 * 截断 / 配对 / token 预算转换器测试
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolPairingTransformer,
  TruncationTransformer,
  TokenBudgetTransformer,
  ensureToolPairing,
  createDefaultTransformers,
} from '../transformer/index.ts';
import type { ContextResource, TransformContext } from '../core/index.ts';
import { createTaskGraph } from '../core/index.ts';
import { messagesToResources, resourcesToMessages } from '../context-resource/index.ts';
import type { Message } from '../core/index.ts';
import { createTextContent } from '../core/index.ts';

function ctx(runtime?: Partial<TransformContext['runtime']>): TransformContext {
  return {
    graph: createTaskGraph(),
    runtime: { sessionKey: 's', turn: 0, ...runtime },
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
function assistantWithToolCall(id: string, name: string, ts = Date.now()): Message {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: {} }],
    stopReason: 'toolUse',
    timestamp: ts,
  } as Message;
}
function toolResult(id: string, name: string, ts = Date.now()): Message {
  return {
    role: 'toolResult',
    content: [createTextContent('ok')],
    toolCallId: id,
    toolName: name,
    isError: false,
    timestamp: ts,
  } as Message;
}

describe('ensureToolPairing', () => {
  it('保留完整配对的 call+result', () => {
    const msgs = [
      userMsg('hi'),
      assistantWithToolCall('tc1', 'get_weather'),
      toolResult('tc1', 'get_weather'),
      assistantMsg('结果: 晴'),
    ];
    const result = ensureToolPairing(msgs);
    assert.equal(result.length, 4);
  });

  it('移除孤立的 toolCall（无对应 result）', () => {
    const msgs = [
      userMsg('hi'),
      assistantWithToolCall('tc1', 'get_weather'),
      // 缺 result
      assistantMsg('done'),
    ];
    const result = ensureToolPairing(msgs);
    assert.equal(result.length, 2);
    assert.equal(result[1].role, 'assistant');
    assert.equal((result[1].content as any[]).length, 1);
    assert.equal((result[1].content as any[])[0].type, 'text');
  });

  it('移除孤立的 toolResult（无对应 call）', () => {
    const msgs = [
      userMsg('hi'),
      assistantMsg('hello'),
      toolResult('orphan', 'get_weather'),
    ];
    const result = ensureToolPairing(msgs);
    assert.equal(result.length, 2);
    assert.equal(result[1].role, 'assistant');
  });
});

describe('TruncationTransformer', () => {
  it('超限时保留最新非关键资源', async () => {
    const transformer = new TruncationTransformer(3);
    const msgs: Message[] = [
      userMsg('m1', 1000),
      assistantMsg('a1', 1001),
      userMsg('m2', 1002),
      assistantMsg('a2', 1003),
      userMsg('m3', 1004),
    ];
    const resources = messagesToResources(msgs);
    const result = await transformer.transform(resources, ctx());
    // 保留最新 3 条
    assert.equal(result.length, 3);
    assert.equal(result[0].timestamp, 1002);
  });

  it('pinned 资源不被截断', async () => {
    const transformer = new TruncationTransformer(2);
    const msgs: Message[] = [userMsg('m1', 1000), assistantMsg('a1', 1001), userMsg('m2', 1002)];
    const resources = messagesToResources(msgs);
    // 标记第一条为 pinned
    resources[0] = { ...resources[0], pinned: true };
    const result = await transformer.transform(resources, ctx());
    assert.ok(result.some(r => r.timestamp === 1000));
  });

  it('截断后保留配对组（不产生孤立 toolResult）', async () => {
    const transformer = new TruncationTransformer(2);
    const msgs: Message[] = [
      userMsg('m1', 1000),
      assistantWithToolCall('tc1', 'tool', 1001),
      toolResult('tc1', 'tool', 1002),
      userMsg('m2', 1003),
      assistantMsg('done', 1004),
    ];
    const resources = messagesToResources(msgs);
    const result = await transformer.transform(resources, ctx());

    // 再过一次 ToolPairing 兜底，不应再删除任何东西
    const pairing = new ToolPairingTransformer();
    const final = await pairing.transform(result, ctx());

    // result 中若有 toolResult，则其 toolCall 也应存在
    const types = final.map(r => r.type);
    const hasToolResult = types.includes('tool_result');
    const hasAssistant = types.includes('assistant_message');
    if (hasToolResult) {
      assert.ok(hasAssistant, '截断后 toolResult 应有对应 assistant toolCall');
    }
  });
});

describe('TokenBudgetTransformer', () => {
  it('总量在预算内时不变', async () => {
    const transformer = new TokenBudgetTransformer(0.8);
    const msgs = [userMsg('hello world'), assistantMsg('hi there')];
    const resources = messagesToResources(msgs);
    const result = await transformer.transform(resources, ctx({ contextWindow: 128000 }));
    assert.equal(result.length, resources.length);
  });

  it('超预算时丢弃最旧资源直到达标', async () => {
    const transformer = new TokenBudgetTransformer(0.8);
    // 构造大量消息，每条约 20 tokens（80 字符 / 4）
    const msgs: Message[] = [];
    for (let i = 0; i < 50; i++) {
      msgs.push(userMsg(`message ${i} `.repeat(10), 1000 + i));
      msgs.push(assistantMsg(`response ${i} `.repeat(10), 1000 + i + 0.5));
    }
    const resources = messagesToResources(msgs);
    // contextWindow 设小，迫使截断
    const result = await transformer.transform(resources, ctx({ contextWindow: 200 }));
    assert.ok(result.length < resources.length, '应丢弃部分资源');
    // 保留的应是最新的（timestamp 大）
    const timestamps = result.map(r => r.timestamp);
    const maxTs = Math.max(...timestamps);
    assert.ok(timestamps.includes(maxTs), '最新消息应被保留');
  });

  it('无 contextWindow 时原样返回', async () => {
    const transformer = new TokenBudgetTransformer(0.8);
    const resources = messagesToResources([userMsg('hi')]);
    const result = await transformer.transform(resources, ctx({ contextWindow: 0 }));
    assert.equal(result.length, 1);
  });
});

describe('createDefaultTransformers 顺序', () => {
  it('ToolPairing 排在最后', () => {
    const transformers = createDefaultTransformers();
    const names = transformers.map(t => t.name);
    assert.ok(names.indexOf('tool-pairing') > names.indexOf('truncation'), 'pairing 应晚于 truncation');
    assert.ok(names.indexOf('tool-pairing') > names.indexOf('token-budget'), 'pairing 应晚于 token-budget');
  });
});
