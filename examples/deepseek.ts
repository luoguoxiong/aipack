/**
 * 根目录示例：使用 aipack + DeepSeek 模型
 *
 * 演示：
 *   1. 从 aipack/ai 内置目录拿 DeepSeek 标准化模型（deepseek-chat）
 *   2. 通过 adapters/ai 适配器零手写 streamFn 接入框架
 *   3. 注册工具，观察 aipack 的 tool_call / tool_result 循环
 *   4. 流式输出最终回复
 *
 * 模型配置统一来自 examples/model.config.ts（本地私有，不提交）：
 *   cp examples/model.config.example.ts examples/model.config.ts
 *
 * 运行: npx tsx examples/deepseek.ts
 * 换用推理模型: DEEPSEEK_MODEL=deepseek-reasoner npx tsx examples/deepseek.ts
 */
import {
  createRuntime,
  createRequest,
  LoggingExtension,
  createFileSessionStorage,
  createDefaultTransformers,
} from '@aipack-ai/agent';
import { createLlm, formatModelConfig } from './model.config';

async function main() {
  // ── 1. 从统一配置装配模型 + streamFn ──────────────────────────
  const { model, streamFn } = createLlm();
  console.log(`✅ 模型: ${formatModelConfig()}\n`);

  // ── 2. 零手写 streamFn 创建 Runtime ────────────────────────────
  const runtime = await createRuntime({
    // 模型与流式函数（必需）
    model,
    streamFn,
    // 基础配置
    systemPrompt: '你是一个简洁的 AI 助手。',
    config: {                                 // 运行时配置，可通过 runtime.config 读取
      locale: 'zh-CN',
      maxTurns: 20,
    },
    workspace: process.cwd(),                 // 工作区路径，供扩展/转换器使用

    // 初始工具列表（也可后续用 runtime.registerTool() 动态注册）
    tools: [{
      name: 'get_weather',
      description: '查询指定城市的天气',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: '城市名' } },
        required: ['city'],
      },
      execute: async (_id, args) => {
        const { city } = args as { city: string };
        return {
          content: [{ type: 'text', text: `${city}：晴天 25°C` }],
          details: { city, temperature: 25 },
        };
      },
    }],

    // 上下文转换器（可选；按数组顺序链式执行，上一个输出作为下一个输入）
    transformers: createDefaultTransformers({ maxResources: 200 }),
    sessionStorage: createFileSessionStorage(), //
    // 扩展
    extensions: [new LoggingExtension(true)],
  });

  // ── 3. 动态注册工具（可选，等价于上面的 tools 选项） ──────────
  runtime.registerTool({
    name: 'get_time',
    description: '查询当前时间',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const now = new Date();
      return {
        content: [{ type: 'text', text: `当前时间：${now.toLocaleString('zh-CN')}` }],
        details: { time: now.toISOString() },
      };
    },
  });

  // ── 4. 流式运行 ─────────────────────────────────────────────────
  const request = createRequest(
    '北京和上海的天气怎么样？分别说一下。',
    { sessionKey: 'deepseek-demo' },
  );

  console.log('\nAI:');
  for await (const chunk of runtime.stream(request)) {
    if (chunk.type === 'text' && chunk.content) process.stdout.write(chunk.content);
    if (chunk.type === 'tool_start') console.log(`\n[调用工具] ${chunk.toolName}`);
    if (chunk.type === 'tool_end') console.log(`\n[工具完成] ${chunk.toolName}`);
    if (chunk.type === 'error') console.error('\n[错误]', chunk.content);
  }
  console.log();

  await runtime.close();
}

main().catch((err) => {
  console.error('运行失败:', err);
  process.exit(1);
});
