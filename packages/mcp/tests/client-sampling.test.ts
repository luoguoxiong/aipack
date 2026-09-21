import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { McpClient } from '../src/client/mcp-client';
import type { McpTransport } from '../src/client/stdio-transport';
import type { JsonRpcMessage } from '../src/client/jsonrpc';
import * as jsonrpc from '../src/client/jsonrpc';
import {
  createSuccessResponse,
  createRequest,
  parseMessage,
} from '../src/client/jsonrpc';
import type { McpCreateMessageParams, McpCreateMessageResult } from '../src/client/protocol';

// ─── Mock 传输层 ───────────────────────────────────────────────
// 模拟外部 MCP Server：send() 记录出站消息；emit() 注入入站消息。

class MockTransport implements McpTransport {
  sent: JsonRpcMessage[] = [];
  private onMsg?: (m: JsonRpcMessage) => void;
  closed = false;

  send(m: JsonRpcMessage): void {
    this.sent.push(m);
  }
  onMessage(h: (m: JsonRpcMessage) => void): void {
    this.onMsg = h;
  }
  onError(_h: (err: Error) => void): void {
    // no-op
  }
  isClosed(): boolean {
    return this.closed;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  /** 模拟 server 入站一条消息 */
  emit(raw: string): void {
    const m = parseMessage(raw);
    if (m) this.onMsg?.(m);
  }
  /** 取最后一条出站消息（已解析对象） */
  lastSent(): JsonRpcMessage | undefined {
    return this.sent[this.sent.length - 1];
  }
}

function makeClient(opts: { onSampling?: (p: McpCreateMessageParams) => Promise<McpCreateMessageResult> } = {}) {
  const transport = new MockTransport();
  const client = new McpClient({
    transport,
    clientInfo: { name: 'test', version: '0.1.0' },
    requestTimeoutMs: 1000,
    onSampling: opts.onSampling,
  });
  return { transport, client };
}

describe('McpClient sampling（客户端方向，处理 server 发起）', () => {
  test('connect 时配置 onSampling → initialize 请求宣告 sampling 能力', async () => {
    const { transport, client } = makeClient({
      onSampling: async () => ({ role: 'assistant', content: { type: 'text', text: '' }, model: 'm' }),
    });
    // 拦截 initialize 响应：模拟 server 回包
    transport.send = ((m: JsonRpcMessage) => {
      transport.sent.push(m);
      if ((m as { method?: string }).method === 'initialize') {
        transport.emit(JSON.stringify(createSuccessResponse((m as { id: number }).id, {
          protocolVersion: '2025-06-18',
          serverInfo: { name: 'srv', version: '1.0.0' },
          capabilities: { tools: {} },
        })));
      }
    }) as typeof transport.send;
    await client.connect();
    const initReq = transport.sent[0] as { method: string; params: { capabilities: { sampling?: unknown } } };
    assert.equal(initReq.method, 'initialize');
    assert.ok(initReq.params.capabilities.sampling !== undefined, '应宣告 sampling 能力');
  });

  test('未配置 onSampling → initialize 不宣告 sampling', async () => {
    const { transport, client } = makeClient();
    transport.send = ((m: JsonRpcMessage) => {
      transport.sent.push(m);
      if ((m as { method?: string }).method === 'initialize') {
        transport.emit(JSON.stringify(createSuccessResponse((m as { id: number }).id, {
          protocolVersion: '2025-06-18',
          serverInfo: { name: 'srv', version: '1.0.0' },
          capabilities: {},
        })));
      }
    }) as typeof transport.send;
    await client.connect();
    const initReq = transport.sent[0] as { params: { capabilities: { sampling?: unknown } } };
    assert.equal(initReq.params.capabilities.sampling, undefined);
  });

  test('收到 sampling/createMessage → 调用 onSampling 并回 result', async () => {
    const { transport, client } = makeClient({
      onSampling: async (p) => {
        const userText = (p.messages[0].content as { text?: string }).text ?? '';
        return {
          role: 'assistant',
          content: { type: 'text', text: `echo:${userText}` },
          model: 'mock-llm',
          stopReason: 'endTurn',
        };
      },
    });
    // 发起 sampling/createMessage 请求（id=42）
    transport.emit(JSON.stringify(createRequest(42, 'sampling/createMessage', {
      messages: [{ role: 'user', content: { type: 'text', text: 'ping' } }],
      maxTokens: 32,
    })));
    // 等待异步应答
    await new Promise((r) => setImmediate(r));
    const resp = transport.lastSent() as { id: number; result: { role: string; content: { text: string }; model: string } };
    assert.ok(resp);
    assert.equal(resp.id, 42);
    assert.equal(resp.result.role, 'assistant');
    assert.equal(resp.result.content.text, 'echo:ping');
    assert.equal(resp.result.model, 'mock-llm');
  });

  test('未配置 onSampling 收到 sampling/createMessage → 回 -32601', async () => {
    const { transport, client } = makeClient();
    transport.emit(JSON.stringify(createRequest(7, 'sampling/createMessage', {
      messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
    })));
    await new Promise((r) => setImmediate(r));
    const resp = transport.lastSent() as { id: number; error: { code: number; message: string } };
    assert.ok(resp.error);
    assert.equal(resp.error.code, jsonrpc.METHOD_NOT_FOUND);
    assert.match(resp.error.message, /sampling/);
  });

  test('onSampling 抛错 → 回 -32603', async () => {
    const { transport, client } = makeClient({
      onSampling: async () => { throw new Error('boom'); },
    });
    transport.emit(JSON.stringify(createRequest(9, 'sampling/createMessage', {
      messages: [{ role: 'user', content: { type: 'text', text: 'x' } }],
    })));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const resp = transport.lastSent() as { id: number; error: { code: number; message: string } };
    assert.equal(resp.error.code, jsonrpc.INTERNAL_ERROR);
    assert.match(resp.error.message, /boom/);
  });

  test('ping 仍正常应答（不回归）', async () => {
    const { transport, client } = makeClient();
    transport.emit(JSON.stringify(createRequest(1, 'ping')));
    await new Promise((r) => setImmediate(r));
    const resp = transport.lastSent() as { id: number; result: unknown };
    assert.deepEqual(resp.result, {});
  });

  test('未知方法仍回 -32601（不回归）', async () => {
    const { transport, client } = makeClient();
    transport.emit(JSON.stringify(createRequest(2, 'resources/subscribe')));
    await new Promise((r) => setImmediate(r));
    const resp = transport.lastSent() as { error: { code: number } };
    assert.equal(resp.error.code, jsonrpc.METHOD_NOT_FOUND);
  });
});
