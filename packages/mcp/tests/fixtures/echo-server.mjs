// 最小 MCP echo server 测试夹具（纯 ESM，无需 tsx）。
// 实现：initialize / notifications/initialized / tools/list / tools/call /
//       ping（请求） + 周期性发送 ping 请求 + 一次 tools/list_changed 通知。
// 行分隔 JSON-RPC over stdio。

import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
let initialized = false;
let serverReqId = 1000;

const tools = [
  {
    name: 'echo',
    description: 'Echoes back the input text',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'text to echo' } },
      required: ['text'],
    },
  },
  {
    name: 'add',
    description: 'Add two numbers',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'slow',
    description: 'Delays 2s before responding (for timeout/cancel tests)',
    inputSchema: { type: 'object', properties: {} },
  },
];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handleRequest(msg) {
  if (msg.method === 'initialize') {
    initialized = true;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'echo', version: '1.0.0' },
        capabilities: { tools: { listChanged: true } },
      },
    });
    return;
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
    return;
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params ?? {};
    if (name === 'echo') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(args?.text ?? '') }] } });
    } else if (name === 'add') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(Number(args?.a) + Number(args?.b)) }] } });
    } else if (name === 'slow') {
      setTimeout(() => {
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'slow-done' }] } });
      }, 2000);
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: `unknown tool: ${name}` }] } });
    }
    return;
  }
  if (msg.method === 'ping') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
}

function startPings() {
  setInterval(() => {
    serverReqId += 1;
    send({ jsonrpc: '2.0', id: serverReqId, method: 'ping', params: {} });
  }, 1000);
}

function notifyListChanged() {
  setTimeout(() => {
    send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }, 300);
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.jsonrpc !== '2.0') return;
  if (typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null) {
    handleRequest(msg);
  } else if (typeof msg.method === 'string') {
    // notification
    if (msg.method === 'notifications/initialized') {
      startPings();
      notifyListChanged();
    }
    // notifications/cancelled: 协作型 server 此处可停止计算；本夹具忽略
  }
});

// 父进程 stdin 关闭则退出
rl.on('close', () => {
  process.exit(0);
});
