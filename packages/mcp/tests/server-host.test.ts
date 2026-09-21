import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Tool, ToolResult, ContentBlock } from '@aipack-ai/agent';
import * as jsonrpc from '../src/client/jsonrpc';
import { createMcpServerHost } from '../src/server/host';
import {
  mapAgentContentToMcp,
  toolResultToMcpCallResult,
} from '../src/server/host';
import {
  createInitializeResult,
  buildToolsListResult,
  buildToolCallResult,
  buildResourcesListResult,
  buildResourceReadResult,
  buildPromptsListResult,
  buildPromptGetResult,
  parseToolCallParams,
  parseResourceReadParams,
  parsePromptGetParams,
  type McpResource,
  type McpPrompt,
} from '../src/client/protocol';

// ─── 辅助工具 ─────────────────────────────────────────────────

function req(id: number | string, method: string, params?: unknown): jsonrpc.JsonRpcRequest {
  return jsonrpc.createRequest(id, method, params);
}

function echoTool(over: Partial<Tool> = {}): Tool {
  return {
    name: 'echo',
    description: 'echo back',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    permissions: [],
    async execute(_id: string, args: unknown): Promise<ToolResult> {
      const text = String((args as { text?: string } | null)?.text ?? '');
      return { content: [{ type: 'text', text }], details: undefined };
    },
    ...over,
  };
}

function successResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], details: undefined };
}

function errorResult(msg: string): ToolResult {
  return {
    content: [{ type: 'text', text: msg }],
    details: { error: msg },
  };
}

function asSuccess(resp: unknown): { result: unknown } {
  assert.ok(resp && typeof resp === 'object' && 'result' in resp, 'expected success response');
  return { result: (resp as { result: unknown }).result };
}

function asError(resp: unknown): { code: number; message: string } {
  assert.ok(resp && typeof resp === 'object' && 'error' in resp, 'expected error response');
  return (resp as { error: { code: number; message: string } }).error;
}

// ─── 反向 content 映射 ────────────────────────────────────────

describe('mapAgentContentToMcp', () => {
  test('text → {type:text,text}', () => {
    const out = mapAgentContentToMcp([{ type: 'text', text: 'hi' } as ContentBlock]);
    assert.deepEqual(out, [{ type: 'text', text: 'hi' }]);
  });
  test('image 完整 → {type:image,data,mimeType}', () => {
    const out = mapAgentContentToMcp([
      { type: 'image', data: 'b64', mimeType: 'image/png' } as ContentBlock,
    ]);
    assert.deepEqual(out, [{ type: 'image', data: 'b64', mimeType: 'image/png' }]);
  });
  test('thinking/toolCall 降级为文本', () => {
    const out = mapAgentContentToMcp([{ type: 'thinking', text: 'hmm' } as ContentBlock]);
    assert.equal(out[0].type, 'text');
    assert.match(out[0].text ?? '', /hmm/);
  });
  test('空 content 补占位', () => {
    const out = mapAgentContentToMcp([]);
    assert.equal(out.length, 1);
    assert.equal(out[0].text, '[empty result]');
  });
});

describe('toolResultToMcpCallResult', () => {
  test('成功结果无 isError', () => {
    const r = toolResultToMcpCallResult(successResult('ok'));
    assert.equal(r.isError, undefined);
    assert.equal(r.content[0].text, 'ok');
  });
  test('details.error 存在 → isError', () => {
    const r = toolResultToMcpCallResult(errorResult('boom'));
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text, 'boom');
  });
  test('details.error 空串仍视为成功（无 error 字段则成功）', () => {
    const r = toolResultToMcpCallResult({ content: [], details: { other: 1 } });
    assert.equal(r.isError, undefined);
  });
});

// ─── 协议构造器（服务端纯函数）──────────────────────────────

describe('server protocol builders', () => {
  test('createInitializeResult 带 protocolVersion / serverInfo / capabilities', () => {
    const r = createInitializeResult({ name: 's', version: '1.0.0' }, { tools: {} });
    const o = r as Record<string, unknown>;
    assert.equal(o.protocolVersion, '2025-06-18');
    assert.deepEqual(o.serverInfo, { name: 's', version: '1.0.0' });
  });
  test('buildToolsListResult 默认 inputSchema', () => {
    const r = buildToolsListResult([{ name: 't' }]) as { tools: Array<{ name: string; inputSchema: unknown }> };
    assert.deepEqual(r.tools[0].inputSchema, { type: 'object', properties: {} });
  });
  test('buildToolCallResult 空 content 补占位 + isError', () => {
    const r = buildToolCallResult([], true) as { content: unknown[]; isError: boolean };
    assert.equal(r.content.length, 1);
    assert.equal(r.isError, true);
  });
  test('buildResourcesListResult / buildResourceReadResult', () => {
    const res: McpResource = { uri: 'file://x', name: 'x', text: 'T', mimeType: 'text/plain' };
    const list = buildResourcesListResult([res]) as { resources: McpResource[] };
    assert.equal(list.resources[0].uri, 'file://x');
    const read = buildResourceReadResult(res) as { contents: Array<Record<string, unknown>> };
    assert.equal(read.contents[0].text, 'T');
    assert.equal(read.contents[0].mimeType, 'text/plain');
  });
  test('buildPromptsListResult / buildPromptGetResult', () => {
    const p: McpPrompt = { name: 'p', description: 'd', messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] };
    const list = buildPromptsListResult([p]) as { prompts: McpPrompt[] };
    assert.equal(list.prompts[0].name, 'p');
    const get = buildPromptGetResult(p.messages!) as { messages: unknown[] };
    assert.equal(get.messages.length, 1);
  });
  test('parseToolCallParams 容错缺字段', () => {
    assert.equal(parseToolCallParams(undefined).name, undefined);
    assert.equal(parseToolCallParams(undefined).arguments, undefined);
    const p = parseToolCallParams({ name: 'echo', arguments: { a: 1 } });
    assert.equal(p.name, 'echo');
    assert.deepEqual(p.arguments, { a: 1 });
  });
  test('parseResourceReadParams / parsePromptGetParams', () => {
    assert.equal(parseResourceReadParams({ uri: 'u' }).uri, 'u');
    assert.equal(parseResourceReadParams({}).uri, undefined);
    assert.equal(parsePromptGetParams({ name: 'p' }).name, 'p');
    assert.equal(parsePromptGetParams({}).name, undefined);
  });
});

// ─── McpServerHost.handleRequest ─────────────────────────────

describe('McpServerHost.handleRequest', () => {
  test('initialize 返回 protocolVersion + capabilities(仅 tools)', async () => {
    const host = createMcpServerHost({ name: 'h', version: '1.0.0', tools: [echoTool()] });
    const resp = await host.handleRequest(req(1, 'initialize', { protocolVersion: '2025-06-18' }));
    const { result } = asSuccess(resp);
    const r = result as { protocolVersion: string; capabilities: { tools?: unknown }; serverInfo: { name: string } };
    assert.equal(r.protocolVersion, '2025-06-18');
    assert.equal(r.serverInfo.name, 'h');
    assert.ok(r.capabilities.tools !== undefined);
    assert.equal(r.capabilities.resources, undefined);
    assert.equal(r.capabilities.prompts, undefined);
  });

  test('capabilities 含 resources/prompts 当提供时', async () => {
    const host = createMcpServerHost({
      name: 'h',
      tools: [echoTool()],
      resources: [{ uri: 'u' }],
      prompts: [{ name: 'p' }],
    });
    const resp = await host.handleRequest(req(1, 'initialize'));
    const r = asSuccess(resp).result as { capabilities: { resources?: unknown; prompts?: unknown } };
    assert.ok(r.capabilities.resources !== undefined);
    assert.ok(r.capabilities.prompts !== undefined);
  });

  test('tools/list 返回工具列表', async () => {
    const host = createMcpServerHost({ name: 'h', tools: [echoTool(), echoTool({ name: 'add' })] });
    const resp = await host.handleRequest(req(2, 'tools/list'));
    const r = asSuccess(resp).result as { tools: Array<{ name: string; description: string }> };
    assert.equal(r.tools.length, 2);
    assert.equal(r.tools[0].name, 'echo');
  });

  test('tools/call 成功返回 content', async () => {
    const host = createMcpServerHost({ name: 'h', tools: [echoTool()] });
    const resp = await host.handleRequest(req(3, 'tools/call', { name: 'echo', arguments: { text: 'hi' } }));
    const r = asSuccess(resp).result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert.equal(r.content[0].text, 'hi');
    assert.equal(r.isError, undefined);
  });

  test('tools/call 未知工具 → isError', async () => {
    const host = createMcpServerHost({ name: 'h', tools: [echoTool()] });
    const resp = await host.handleRequest(req(4, 'tools/call', { name: 'nope', arguments: {} }));
    const r = asSuccess(resp).result as { content: Array<{ text: string }>; isError?: boolean };
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /unknown tool/);
  });

  test('tools/call 工具抛错 → isError + 错误文本', async () => {
    const boom: Tool = {
      name: 'boom',
      description: 'throws',
      parameters: { type: 'object' },
      permissions: [],
      async execute() { throw new Error('kaboom'); },
    };
    const host = createMcpServerHost({ name: 'h', tools: [boom] });
    const resp = await host.handleRequest(req(5, 'tools/call', { name: 'boom', arguments: {} }));
    const r = asSuccess(resp).result as { content: Array<{ text: string }>; isError?: boolean };
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /kaboom/);
  });

  test('tools/call details.error 存在 → isError', async () => {
    const failer: Tool = {
      name: 'fail',
      description: 'returns error result',
      parameters: { type: 'object' },
      permissions: [],
      async execute() { return errorResult('denied by policy'); },
    };
    const host = createMcpServerHost({ name: 'h', tools: [failer] });
    const resp = await host.handleRequest(req(6, 'tools/call', { name: 'fail', arguments: {} }));
    const r = asSuccess(resp).result as { content: Array<{ text: string }>; isError?: boolean };
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /denied by policy/);
  });

  test('tools/call 经 authorize 拒绝 → isError permission denied', async () => {
    const host = createMcpServerHost({
      name: 'h',
      tools: [echoTool()],
      authorize: async () => false,
    });
    const resp = await host.handleRequest(req(7, 'tools/call', { name: 'echo', arguments: { text: 'x' } }));
    const r = asSuccess(resp).result as { content: Array<{ text: string }>; isError?: boolean };
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /permission denied/);
  });

  test('tools/call 缺 name → isError', async () => {
    const host = createMcpServerHost({ name: 'h', tools: [echoTool()] });
    const resp = await host.handleRequest(req(8, 'tools/call', { arguments: {} }));
    const r = asSuccess(resp).result as { isError?: boolean };
    assert.equal(r.isError, true);
  });

  test('ping 返回 {} ', async () => {
    const host = createMcpServerHost({ name: 'h', tools: [] });
    const resp = await host.handleRequest(req(9, 'ping'));
    assert.deepEqual(asSuccess(resp).result, {});
  });

  test('未知方法 → -32601', async () => {
    const host = createMcpServerHost({ name: 'h', tools: [] });
    const resp = await host.handleRequest(req(10, 'resources/subscribe', {}));
    const e = asError(resp);
    assert.equal(e.code, jsonrpc.METHOD_NOT_FOUND);
  });

  test('通知 → null（不回写）', async () => {
    const host = createMcpServerHost({ name: 'h', tools: [] });
    const notif = jsonrpc.createNotification('notifications/initialized');
    const resp = await host.handleRequest(notif);
    assert.equal(resp, null);
  });

  test('响应消息 → null（不应收到）', async () => {
    const host = createMcpServerHost({ name: 'h', tools: [] });
    const resp = await host.handleRequest(jsonrpc.createSuccessResponse(1, {}));
    assert.equal(resp, null);
  });

  test('非法消息 → null', async () => {
    const host = createMcpServerHost({ name: 'h', tools: [] });
    assert.equal(await host.handleRequest(null), null);
    assert.equal(await host.handleRequest({ foo: 'bar' }), null);
  });

  test('动态 tools 解析器（函数）', async () => {
    let calls = 0;
    const host = createMcpServerHost({
      name: 'h',
      tools: () => { calls++; return [echoTool()]; },
    });
    await host.handleRequest(req(1, 'tools/list'));
    await host.handleRequest(req(2, 'tools/list'));
    assert.equal(calls, 2, 'resolver 每次调用');
  });

  test('toolTimeoutMs 触发超时 → isError', async () => {
    const slow: Tool = {
      name: 'slow',
      description: 'delays',
      parameters: { type: 'object' },
      permissions: [],
      async execute() {
        await new Promise((r) => setTimeout(r, 200));
        return successResult('late');
      },
    };
    const host = createMcpServerHost({ name: 'h', tools: [slow], toolTimeoutMs: 50 });
    const resp = await host.handleRequest(req(11, 'tools/call', { name: 'slow', arguments: {} }));
    const r = asSuccess(resp).result as { content: Array<{ text: string }>; isError?: boolean };
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /timeout/);
  });

  test('resources/* 与 prompts/* 在提供时可用', async () => {
    const host = createMcpServerHost({
      name: 'h',
      tools: [],
      resources: [{ uri: 'file://a', text: 'A', mimeType: 'text/plain' }],
      prompts: [{ name: 'greet', messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] }],
    });
    const list = await host.handleRequest(req(1, 'resources/list'));
    assert.equal((asSuccess(list).result as { resources: McpResource[] }).resources[0].uri, 'file://a');
    const read = await host.handleRequest(req(2, 'resources/read', { uri: 'file://a' }));
    assert.equal((asSuccess(read).result as { contents: Array<{ text: string }> }).contents[0].text, 'A');
    const plist = await host.handleRequest(req(3, 'prompts/list'));
    assert.equal((asSuccess(plist).result as { prompts: McpPrompt[] }).prompts[0].name, 'greet');
    const pget = await host.handleRequest(req(4, 'prompts/get', { name: 'greet' }));
    assert.equal((asSuccess(pget).result as { messages: unknown[] }).messages.length, 1);
  });

  test('resources/read 未提供 resources → -32601', async () => {
    const host = createMcpServerHost({ name: 'h', tools: [] });
    const resp = await host.handleRequest(req(1, 'resources/read', { uri: 'x' }));
    assert.equal(asError(resp).code, jsonrpc.METHOD_NOT_FOUND);
  });

  test('resources/read uri 不存在 → -32602', async () => {
    const host = createMcpServerHost({ name: 'h', tools: [], resources: [{ uri: 'u' }] });
    const resp = await host.handleRequest(req(1, 'resources/read', { uri: 'nope' }));
    assert.equal(asError(resp).code, jsonrpc.INVALID_PARAMS);
  });

  test('notifyToolsListChanged 经 onNotification 发出', () => {
    const got: jsonrpc.JsonRpcNotification[] = [];
    const host = createMcpServerHost({ name: 'h', tools: [], onNotification: (n) => got.push(n) });
    host.notifyToolsListChanged();
    assert.equal(got.length, 1);
    assert.equal(got[0].method, 'notifications/tools/list_changed');
  });
});

describe('McpServerHost sampling（服务端方向）', () => {
  test('sampling: true → capabilities 含 sampling', async () => {
    const host = createMcpServerHost({ name: 'h', tools: [], sampling: true });
    const resp = await host.handleRequest(req(1, 'initialize'));
    const r = asSuccess(resp).result as { capabilities: { sampling?: unknown } };
    assert.ok(r.capabilities.sampling !== undefined);
  });

  test('未启用 sampling → capabilities 无 sampling', async () => {
    const host = createMcpServerHost({ name: 'h', tools: [] });
    const resp = await host.handleRequest(req(1, 'initialize'));
    const r = asSuccess(resp).result as { capabilities: { sampling?: unknown } };
    assert.equal(r.capabilities.sampling, undefined);
  });

  test('setOutboundRequest 后追加 sampling 能力', async () => {
    const host = createMcpServerHost({ name: 'h', tools: [] });
    assert.equal(host.getCapabilities().sampling, undefined);
    host.setOutboundRequest(async () => ({}));
    assert.ok(host.getCapabilities().sampling !== undefined);
  });

  test('sampleLLM 经出站通道请求并解析响应', async () => {
    let captured: { method: string; params: unknown } | undefined;
    const host = createMcpServerHost({ name: 'h', tools: [] });
    host.setOutboundRequest(async (method, params) => {
      captured = { method, params };
      return {
        role: 'assistant',
        content: { type: 'text', text: 'hello from client llm' },
        model: 'client-model',
        stopReason: 'endTurn',
      };
    });
    const res = await host.sampleLLM({
      messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
    });
    assert.equal(captured?.method, 'sampling/createMessage');
    assert.equal(res.role, 'assistant');
    assert.equal(res.content.text, 'hello from client llm');
    assert.equal(res.model, 'client-model');
    assert.equal(res.stopReason, 'endTurn');
  });

  test('sampleLLM 出站通道 reject → 错误透传', async () => {
    const host = createMcpServerHost({ name: 'h', tools: [] });
    host.setOutboundRequest(async () => { throw new Error('client refused'); });
    await assert.rejects(() => host.sampleLLM({ messages: [] }), /client refused/);
  });

  test('sampleLLM 未注入出站通道 → 抛错', async () => {
    const host = createMcpServerHost({ name: 'h', tools: [], sampling: true });
    await assert.rejects(() => host.sampleLLM({ messages: [] }), /outbound request channel not attached/);
  });
});
