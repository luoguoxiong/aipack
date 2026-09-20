/**
 * examples/mcp-client.ts - MCP 客户端方向示例
 *
 * 离线可运行：拉起本地 echo-server 夹具作为外部 MCP Server，
 * 演示握手 → 工具注册 → 远端调用 全流程。
 *
 * 接真实 MCP Server 时，把 servers 换成下面注释里的配置即可
 * （需要对应环境变量 / 网络可达）：
 *
 *   servers: [
 *     {
 *       name: 'github',
 *       transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
 *     },
 *   ],
 *
 * 运行：pnpm example:mcp
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRuntime } from '@aipack-ai/agent';
import { createMcpPlugin } from '@aipack-ai/mcp';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(here, '../packages/mcp/tests/fixtures/echo-server.mjs');

async function main() {
  const mcp = createMcpPlugin({
    servers: [
      {
        name: 'echo',
        transport: { type: 'stdio', command: process.execPath, args: [fixturePath] },
        timeoutMs: 10_000,
      },
    ],
  });

  // 把 MCP 工具挂进 Runtime：模型即可调用 echo__echo / echo__add / mcp_status
  createRuntime({ extensions: [...mcp.extensions] });

  // 预热连接（也可不调用，首次 run 时 beforeRun 懒连接）
  const diagnostics = await mcp.ready();
  if (diagnostics.length > 0) {
    console.error('MCP diagnostics:', diagnostics);
  }

  // 直接经 registry 调用远端工具（模型调用走同一通道：权限/超时/钩子由 runtime 统一处理）
  const echo = await mcp.registry.callTool('echo', 'echo', { text: 'hello from mcp' });
  console.log('echo →', echo.content[0]?.text);

  const add = await mcp.registry.callTool('echo', 'add', { a: 40, b: 2 });
  console.log('add  →', add.content[0]?.text);

  // mcp_status 内部工具查看连接状态
  console.log('mcp servers:', mcp.registry.getStatus());

  await mcp.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
