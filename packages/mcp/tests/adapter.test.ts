import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Tool } from '@aipack-ai/agent';
import {
  wrapMcpTool,
  buildToolName,
  mapContentBlocks,
  extractText,
  toSuccessResult,
  toErrorResult,
} from '../src/adapter';
import type { McpServerConfig } from '../src/types';
import type { McpToolInfo, McpToolCallResult } from '../src/client/protocol';

const server: McpServerConfig = {
  name: 'echo',
  transport: { type: 'stdio', command: 'node' },
};

function makeTool(over: Partial<McpToolInfo> = {}): McpToolInfo {
  return { name: 'echo', description: 'echo back', inputSchema: { type: 'object' }, ...over };
}

describe('buildToolName', () => {
  test('默认 prefix__rawName', () => {
    assert.equal(buildToolName('echo', 'say'), 'echo__say');
  });
  test('prefix 为空不加前缀', () => {
    assert.equal(buildToolName('', 'say'), 'say');
  });
});

describe('mapContentBlocks', () => {
  test('text → TextContent', () => {
    const out = mapContentBlocks([{ type: 'text', text: 'hi' }]);
    assert.deepEqual(out, [{ type: 'text', text: 'hi' }]);
  });
  test('image 缺 mimeType 降级文本', () => {
    const out = mapContentBlocks([{ type: 'image', data: 'xxx' }]);
    assert.equal(out[0].type, 'text');
  });
  test('image 完整 → ImageContent', () => {
    const out = mapContentBlocks([{ type: 'image', data: 'b64', mimeType: 'image/png' }]);
    assert.equal(out[0].type, 'image');
  });
  test('resource 块降级为文本摘要', () => {
    const out = mapContentBlocks([{ type: 'resource', resource: { uri: 'file://x' } }]);
    assert.equal(out[0].type, 'text');
    assert.match((out[0] as { text: string }).text, /file:\/\/x/);
  });
  test('resource 块有 text 时优先返回 text', () => {
    const out = mapContentBlocks([{ type: 'resource', resource: { uri: 'u', text: 'T' } }]);
    assert.equal((out[0] as { text: string }).text, 'T');
  });
  test('未知 type 降级文本', () => {
    const out = mapContentBlocks([{ type: 'audio', data: 'x' }]);
    assert.match((out[0] as { text: string }).text, /unsupported/);
  });
  test('空 content 补占位', () => {
    const out = mapContentBlocks([]);
    assert.equal(out.length, 1);
    assert.equal((out[0] as { text: string }).text, '[empty result]');
  });
});

describe('extractText / toSuccessResult / toErrorResult', () => {
  test('extractText 取首段文本', () => {
    assert.equal(extractText({ content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] }), 'A');
  });
  test('extractText 无文本时兜底', () => {
    assert.equal(extractText({ content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] }), 'MCP tool error');
  });
  test('toSuccessResult details 无 error', () => {
    const r = toSuccessResult({ content: [{ type: 'text', text: 'ok' }] });
    assert.equal(r.details, undefined);
    assert.equal(r.content[0].type, 'text');
  });
  test('toErrorResult details.error 存在', () => {
    const r = toErrorResult({ isError: true, content: [{ type: 'text', text: 'boom' }] }, 'echo');
    assert.equal((r.details as { error: string }).error, '[mcp:echo] boom');
  });
});

describe('wrapMcpTool', () => {
  test('生成正确 name / permissions / description 标注来源', () => {
    const t = wrapMcpTool(server, makeTool(), async () => ({ content: [] }));
    assert.equal(t.name, 'echo__echo');
    assert.deepEqual(t.permissions, ['mcp:echo']);
    assert.match(t.description, /\[mcp:echo\]/);
  });
  test('toolPrefix 空串禁用前缀', () => {
    const t = wrapMcpTool({ ...server, toolPrefix: '' }, makeTool(), async () => ({ content: [] }));
    assert.equal(t.name, 'echo');
  });
  test('permissions 覆盖', () => {
    const t = wrapMcpTool({ ...server, permissions: ['custom'] }, makeTool(), async () => ({ content: [] }));
    assert.deepEqual(t.permissions, ['custom']);
  });
  test('inputSchema 缺失给默认 object schema', () => {
    const t = wrapMcpTool(server, { name: 'x' }, async () => ({ content: [] }));
    assert.deepEqual(t.parameters, { type: 'object', properties: {} });
  });
  test('execute 成功返回 successResult', async () => {
    const t = wrapMcpTool(server, makeTool(), async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }));
    const r = await t.execute('id1', {});
    assert.equal(r.details, undefined);
    assert.equal((r.content[0] as { text: string }).text, 'pong');
  });
  test('execute isError 返回 details.error', async () => {
    const t = wrapMcpTool(server, makeTool(), async () => ({
      isError: true,
      content: [{ type: 'text', text: 'denied' }],
    }));
    const r = await t.execute('id2', {});
    assert.equal((r.details as { error: string }).error, '[mcp:echo] denied');
  });
  test('execute 调用抛错返回 details.error + 友好文本', async () => {
    const t = wrapMcpTool(server, makeTool(), async () => {
      throw new Error('network down');
    });
    const r = await t.execute('id3', {});
    assert.match((r.details as { error: string }).error, /network down/);
    assert.match((r.content[0] as { text: string }).text, /MCP call failed/);
  });
});
