import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MCP_PROTOCOL_VERSION,
  MCP_BASELINE_VERSION,
  negotiateProtocol,
  createInitializeRequest,
  buildInitializeParams,
  parseInitializeResult,
  createInitializedNotification,
  createListToolsRequest,
  parseToolListResponse,
  createCallToolRequest,
  parseToolCallResult,
  errorResponseToCallResult,
  createPingRequest,
  createCancelledNotification,
  isListChangedNotification,
  createSamplingRequest,
  parseCreateMessageParams,
  buildCreateMessageResult,
  parseCreateMessageResult,
} from '../src/client/protocol';

describe('negotiateProtocol', () => {
  test('版本一致 ok', () => {
    assert.deepEqual(negotiateProtocol(MCP_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION), { ok: true, version: MCP_PROTOCOL_VERSION });
  });
  test('server 降级到基线版本 ok', () => {
    const r = negotiateProtocol(MCP_PROTOCOL_VERSION, '2024-11-05');
    assert.equal(r.ok, true);
  });
  test('低于基线不兼容', () => {
    assert.equal(negotiateProtocol(MCP_PROTOCOL_VERSION, '2024-01-01').ok, false);
  });
  test('非字符串不兼容', () => {
    assert.equal(negotiateProtocol(MCP_PROTOCOL_VERSION, '').ok, false);
  });
});

describe('initialize', () => {
  test('构造请求带 protocolVersion / clientInfo / capabilities', () => {
    const r = createInitializeRequest(1, { name: 'c', version: '1.0.0' });
    const p = (r as { params: Record<string, unknown> }).params;
    assert.equal(p.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.deepEqual(p.clientInfo, { name: 'c', version: '1.0.0' });
  });
  test('parseInitializeResult 容错缺省字段', () => {
    const r = parseInitializeResult({});
    assert.equal(r.protocolVersion, '');
    assert.equal(r.serverInfo.name, 'unknown');
    assert.deepEqual(r.capabilities, {});
  });
  test('parseInitializeResult 正常解析', () => {
    const r = parseInitializeResult({
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { name: 'echo', version: '1.0.0' },
      capabilities: { tools: { listChanged: true } },
    });
    assert.equal(r.serverInfo.name, 'echo');
    assert.equal(r.capabilities?.tools?.listChanged, true);
  });
  test('initialized notification 无 id', () => {
    const n = createInitializedNotification();
    assert.equal('id' in n, false);
  });
});

describe('tools/list', () => {
  test('无 cursor 时 params 为 undefined', () => {
    const r = createListToolsRequest(2);
    assert.equal('params' in r, false);
  });
  test('有 cursor 时携带', () => {
    const r = createListToolsRequest(2, 'abc');
    assert.equal((r as { params?: { cursor?: string } }).params?.cursor, 'abc');
  });
  test('parseToolListResponse 跳过缺 name 的项', () => {
    const r = parseToolListResponse({
      tools: [
        { name: 'a', description: 'A' },
        { description: 'no name' },
        { name: 'b', inputSchema: { type: 'object' } },
      ],
      nextCursor: 'c1',
    });
    assert.equal(r.tools.length, 2);
    assert.equal(r.tools[0].name, 'a');
    assert.equal(r.nextCursor, 'c1');
  });
  test('parseToolListResponse 缺 tools 字段返回空', () => {
    const r = parseToolListResponse({});
    assert.deepEqual(r.tools, []);
    assert.equal(r.nextCursor, undefined);
  });
});

describe('tools/call', () => {
  test('构造请求带 name + arguments', () => {
    const r = createCallToolRequest(3, 'echo', { text: 'hi' });
    const p = (r as { params: { name: string; arguments: unknown } }).params;
    assert.equal(p.name, 'echo');
    assert.deepEqual(p.arguments, { text: 'hi' });
  });
  test('args 为 null 时 arguments 兜底为 {}', () => {
    const r = createCallToolRequest(3, 'echo', null);
    const p = (r as { params: { arguments: unknown } }).params;
    assert.deepEqual(p.arguments, {});
  });
  test('parseToolCallResult 正常 content', () => {
    const r = parseToolCallResult({
      content: [{ type: 'text', text: 'hello' }],
    });
    assert.equal(r.isError, undefined);
    assert.equal(r.content[0].text, 'hello');
  });
  test('parseToolCallResult isError', () => {
    const r = parseToolCallResult({ isError: true, content: [{ type: 'text', text: 'boom' }] });
    assert.equal(r.isError, true);
  });
  test('parseToolCallResult content 缺失补占位', () => {
    const r = parseToolCallResult({});
    assert.equal(r.content.length, 1);
    assert.equal(r.content[0].text, '[empty result]');
  });
  test('parseToolCallResult 未知 type 保留 + type 字段', () => {
    const r = parseToolCallResult({ content: [{ type: 'audio', data: 'x' }] });
    assert.equal(r.content[0].type, 'audio');
  });
  test('errorResponseToCallResult 生成 isError', () => {
    const r = errorResponseToCallResult('boom');
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text, 'boom');
  });
});

describe('ping / notifications', () => {
  test('ping 请求带 id', () => {
    const r = createPingRequest(4);
    assert.equal((r as { id: number }).id, 4);
    assert.equal(r.method, 'ping');
  });
  test('cancelled notification 带 requestId', () => {
    const n = createCancelledNotification(7, 'aborted');
    const p = (n as { params: { requestId: number; reason: string } }).params;
    assert.equal(p.requestId, 7);
    assert.equal(p.reason, 'aborted');
  });
  test('list_changed 识别', () => {
    assert.equal(isListChangedNotification({ method: 'notifications/tools/list_changed' }), true);
    assert.equal(isListChangedNotification({ method: 'ping' }), false);
  });
  test('baseline 常量存在', () => {
    assert.ok(MCP_BASELINE_VERSION);
  });
});

describe('sampling', () => {
  test('createSamplingRequest 带 method 与 params', () => {
    const r = createSamplingRequest(9, {
      messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
      maxTokens: 64,
    });
    assert.equal(r.method, 'sampling/createMessage');
    const p = (r as { params: { messages: unknown[]; maxTokens: number } }).params;
    assert.equal(p.maxTokens, 64);
    assert.equal(p.messages.length, 1);
  });
  test('parseCreateMessageParams 容错缺 messages', () => {
    const p = parseCreateMessageParams({});
    assert.deepEqual(p.messages, []);
    assert.equal(p.systemPrompt, undefined);
  });
  test('parseCreateMessageParams 透传可选字段', () => {
    const p = parseCreateMessageParams({
      messages: [{ role: 'user', content: { type: 'text', text: 'q' } }],
      systemPrompt: 'sys',
      includeContext: 'thisServer',
      maxTokens: 100,
      stopSequences: ['\n'],
      metadata: { x: 1 },
    });
    assert.equal(p.systemPrompt, 'sys');
    assert.equal(p.includeContext, 'thisServer');
    assert.equal(p.maxTokens, 100);
    assert.deepEqual(p.stopSequences, ['\n']);
    assert.deepEqual(p.metadata, { x: 1 });
  });
  test('buildCreateMessageResult 含 role/content/model + 可选字段', () => {
    const r = buildCreateMessageResult({
      role: 'assistant',
      content: { type: 'text', text: 'answer' },
      model: 'demo',
      stopReason: 'endTurn',
      usage: { inputTokens: 5, outputTokens: 3 },
    });
    const o = r as Record<string, unknown>;
    assert.equal(o.role, 'assistant');
    assert.equal(o.model, 'demo');
    assert.equal(o.stopReason, 'endTurn');
    assert.deepEqual(o.usage, { inputTokens: 5, outputTokens: 3 });
  });
  test('parseCreateMessageResult 容错缺省字段给默认', () => {
    const r = parseCreateMessageResult({ content: { type: 'text', text: 'a' } });
    assert.equal(r.role, 'assistant');
    assert.equal(r.model, 'unknown');
    assert.equal(r.content.text, 'a');
    assert.equal(r.stopReason, undefined);
  });
  test('parseCreateMessageResult 缺 content 兜底空文本', () => {
    const r = parseCreateMessageResult({});
    assert.equal(r.content.type, 'text');
    assert.equal(r.content.text, '');
  });
});

describe('initialize capabilities', () => {
  test('createInitializeRequest 默认 capabilities 为空对象', () => {
    const r = createInitializeRequest(1, { name: 'c', version: '1.0.0' });
    const p = (r as { params: { capabilities: Record<string, unknown> } }).params;
    assert.deepEqual(p.capabilities, {});
  });
  test('createInitializeRequest 传入 sampling 能力', () => {
    const r = createInitializeRequest(1, { name: 'c', version: '1.0.0' }, { sampling: {} });
    const p = (r as { params: { capabilities: { sampling?: unknown } } }).params;
    assert.ok(p.capabilities.sampling !== undefined);
  });
  test('buildInitializeParams 组合协议字段', () => {
    const p = buildInitializeParams({ name: 'c', version: '1.0.0' }, { sampling: {} });
    assert.equal(p.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.deepEqual(p.clientInfo, { name: 'c', version: '1.0.0' });
    assert.ok(p.capabilities.sampling !== undefined);
  });
});
