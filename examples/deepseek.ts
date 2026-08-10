/**
 * 根目录示例：使用 aipack + DeepSeek 模型
 *
 * 演示：
 *   1. 从 aipack/ai 内置目录拿 DeepSeek 标准化模型（deepseek-chat）
 *   2. 通过 adapters/ai 适配器零手写 streamFn 接入框架
 *   3. 注册工具，观察 aipack 的 tool_call / tool_result 循环
 *   4. 流式输出最终回复
 *
 * 运行: DEEPSEEK_API_KEY=sk-xxx npx tsx examples/deepseek.ts
 * 换用推理模型: DEEPSEEK_MODEL=deepseek-reasoner npx tsx examples/deepseek.ts
 */
import {
  createRuntime,
  createRequest,
  LoggingExtension,
  createFileSessionStorage,
  createDefaultTransformers,
  createDefaultPipeline,
  adaptAiModel,
  createStreamFnFromAi,
  getBuiltinModel,
  hasProviderConfigured,
} from '@aipack/agent';

async function main() {
  // ── 1. 从 aipack/ai 内置目录获取 DeepSeek 模型 ──────────────
  const modelId = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const aiModel = getBuiltinModel('deepseek', modelId);
  if (!aiModel) {
    console.error(`找不到内置模型 deepseek/${modelId}`);
    console.error('可选: deepseek-chat / deepseek-reasoner / deepseek-v4-flash');
    process.exit(1);
  }

  // ── 2. 启动前检查 API Key ───────────────────────────────────────
  if (!hasProviderConfigured('deepseek')) {
    console.warn('⚠️  未检测到 DEEPSEEK_API_KEY，真实调用会失败。');
    console.warn('   设置环境变量后重试，例如: DEEPSEEK_API_KEY=sk-xxx');
  }

  // ── 3. 零手写 streamFn 创建 Runtime ────────────────────────────
  const runtime = await createRuntime({
    // 模型与流式函数（必需）
    model: adaptAiModel(aiModel),             // DeepSeek Model -> 框架 Model
    streamFn: createStreamFnFromAi(aiModel),  // 自动生成 streamFn（按 model.api 分派，API Key 读 DEEPSEEK_API_KEY 环境变量）
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

    // 转换流水线（可选，不传则用框架默认实现）
    transformers: createDefaultTransformers({ maxResources: 200 }),
    pipeline: createDefaultPipeline({ maxResources: 200 }),
    sessionStorage: createFileSessionStorage(), //
    // 扩展
    extensions: [new LoggingExtension(true)],
  });

  // ── 4. 动态注册工具（可选，等价于上面的 tools 选项） ──────────
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

  // ── 5. 流式运行 ─────────────────────────────────────────────────
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
