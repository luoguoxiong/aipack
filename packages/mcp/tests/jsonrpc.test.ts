import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRequest,
  createNotification,
  createSuccessResponse,
  createErrorResponse,
  serialize,
  parseMessage,
  classify,
  isResponse,
  isRequest,
  isNotification,
  isErrorResponse,
  METHOD_NOT_FOUND,
} from '../src/client/jsonrpc';

describe('createRequest / createNotification', () => {
  test('request 带 id，params 省略时无该字段', () => {
    const r = createRequest(1, 'tools/list');
    assert.deepEqual(r, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  });
  test('request params 非空时携带', () => {
    const r = createRequest(2, 'tools/call', { name: 'x', arguments: {} });
    assert.equal((r as { params?: unknown }).params?.name, 'x');
  });
  test('notification 无 id', () => {
    const n = createNotification('notifications/initialized');
    assert.equal('id' in n, false);
  });
});

describe('serialize / parseMessage 往返', () => {
  test('request 往返', () => {
    const r = createRequest(5, 'ping');
    const back = parseMessage(serialize(r));
    assert.ok(back && isRequest(back));
    if (back && isRequest(back)) assert.equal(back.id, 5);
  });
  test('notification 往返', () => {
    const n = createNotification('notifications/cancelled', { requestId: 9 });
    const back = parseMessage(serialize(n));
    assert.ok(back && isNotification(back));
  });
  test('success response 往返', () => {
    const s = createSuccessResponse(7, { ok: true });
    const back = parseMessage(serialize(s));
    assert.ok(back && isResponse(back) && !isErrorResponse(back));
  });
  test('error response 往返', () => {
    const e = createErrorResponse(7, METHOD_NOT_FOUND, 'nope');
    const back = parseMessage(serialize(e));
    assert.ok(back && isErrorResponse(back));
    if (back && isErrorResponse(back)) assert.equal(back.error.code, METHOD_NOT_FOUND);
  });
  test('非法 JSON 返回 null', () => {
    assert.equal(parseMessage('{not json'), null);
  });
  test('非 JSON-RPC 2.0 返回 null', () => {
    assert.equal(parseMessage(JSON.stringify({ foo: 1 })), null);
    assert.equal(parseMessage(JSON.stringify({ jsonrpc: '1.0', method: 'x' })), null);
  });
  test('合法 response 非空（parseMessage 容错）', () => {
    const back = parseMessage(JSON.stringify({ jsonrpc: '2.0', result: 1, id: 1 }));
    assert.notEqual(back, null);
  });
});

describe('classify 边界', () => {
  test('method + id=null 视为 notification', () => {
    const m = classify({ jsonrpc: '2.0', method: 'x', id: null });
    assert.ok(m && isNotification(m));
  });
  test('有 result 即响应', () => {
    const m = classify({ jsonrpc: '2.0', id: 1, result: null });
    assert.ok(m && isResponse(m));
  });
  test('只有 method 无 id/notification 二义 → notification', () => {
    const m = classify({ jsonrpc: '2.0', method: 'ping' });
    assert.ok(m && isNotification(m));
  });
  test('非对象返回 null', () => {
    assert.equal(classify(null), null);
    assert.equal(classify(42), null);
  });
});
