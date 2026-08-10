/**
 * 真实 LLM 调用示例（需 API Key）。
 *
 * 用 createCodingAgent 创建带完整 coding 工具的 agent，流式输出。
 *
 * 运行：
 *   DEEPSEEK_API_KEY=sk-xxx pnpm --filter aipack-coding exec -- node --import tsx examples/real-llm.ts
 *   或：DEEPSEEK_API_KEY=sk-xxx aipack-coding chat
 */

import path from 'path';
import { createRequest } from '@aipack/agent';
import { createCodingAgent } from '../src/factory';

async function main(): Promise<void> {
  const sessionKey = `coding-demo-${Date.now().toString(36)}`;
  const agent = await createCodingAgent({
    provider: process.env.AIPACK_PROVIDER,
    model: process.env.AIPACK_MODEL,
    workspace: process.cwd(),
    sessionKey,
    sessionDir: path.join(process.cwd(), '.aipack', 'sessions'),
  });

  const message = process.argv[2] ?? '读 package.json 并总结有哪些 script';

  console.log(`提问：${message}\n---`);

  for await (const chunk of agent.runtime.stream(
    createRequest(message),
  )) {
    switch (chunk.type) {
      case 'text':
        process.stdout.write(chunk.content ?? '');
        break;
      case 'tool_start':
        console.log(`\n🔧 正在运行：${chunk.toolName}`);
        break;
      case 'tool_end':
        console.log(chunk.isError ? `\n❌ ${chunk.toolName} 失败` : `\n✅ ${chunk.toolName} 完成`);
        break;
      case 'error':
        console.log(`\n❌ 错误：${chunk.content}`);
        break;
    }
  }

  console.log('\n');
  await agent.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
