/**
 * 根目录示例：使用 aipack-memory 实现跨会话长期记忆
 *
 * 演示完整闭环：capture → compress → index → recall/inject → consolidate
 *   1. 用 createMemoryPlugin 装配记忆插件（FileMemoryStore 持久化 + BM25 检索）
 *   2. 会话 s1：用户告知偏好 → capture 自动落盘一条记忆
 *   3. 会话 s2：换一个会话提问 → injection 自动检索并注入相关记忆
 *   4. 直接调用记忆工具 save_memory / search_memory
 *   5. 展示手动 consolidate 合并相似记忆
 *
 * 模型配置统一来自 examples/model.config.ts（本地私有，不提交）：
 *   cp examples/model.config.example.ts examples/model.config.ts
 *
 * 运行：
 *   npx tsx examples/agent-memory.ts
 * 临时覆盖（优先于配置文件）：
 *   DEEPSEEK_MODEL=deepseek-chat npx tsx examples/agent-memory.ts
 */
import {
  createRuntime,
  createRequest,
  extractText,
  createFileSessionStorage,
} from '@aipack-ai/agent';
import type {
  StreamFn,
  Context,
  ContentBlock,
  TextContent,
  Tool,
} from '@aipack-ai/agent';
import { createMemoryPlugin, MEMORY_BLOCK_START } from '@aipack-ai/memory';
import { createLlm, formatModelConfig } from './model.config';

// ─── 辅助：取最新 user 消息纯文本 ────────────────────────────────────

function latestUserText(ctx: Context): string {
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    if (ctx.messages[i].role === 'user') {
      return extractText(ctx.messages[i].content as string | ContentBlock[]);
    }
  }
  return '';
}

// ─── 主流程 ──────────────────────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║   aipack-memory 跨会话记忆实例                   ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  // 1. 装配记忆插件（FileMemoryStore 持久化到 ./.aipack/memory）
  const mem = createMemoryPlugin({
    baseDir: './.aipack/memory',
    maxMemories: 3,          // 每轮注入 top-3
    consolidateEvery: 5,     // 每 5 次捕获自动合并一次
  });
  const installed = mem.install();

  // 2. 装配模型与 streamFn（统一来自 model.config.ts）
  const { model, streamFn } = createLlm();
  console.log(`✅ 模型: ${formatModelConfig()}\n`);

  // 3. 自定义工具：与记忆工具合并后一次性注入 createRuntime
  const getWeather: Tool = {
    name: 'get_weather',
    description: '查询指定城市的实时天气',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名，如"北京"' },
      },
      required: ['city'],
    },
    async execute(_toolCallId, args) {
      const { city } = (args ?? {}) as { city?: string };
      const temp = city === '北京' ? 26 : 22;
      return {
        content: [{ type: 'text', text: `${city}：晴 ${temp}°C` }],
        details: { city, temperature: temp },
      };
    },
  };

  // 4. 创建 Runtime 工厂：多会话通过多 Runtime 实例共享同一 memory store
  //    （也支持后续动态注册：runtime.registerTool(...) / registerTools([...])）
  function createMemoryRuntime(sFn: StreamFn) {
    return createRuntime({
      model,
      streamFn: sFn,
      systemPrompt: '你是一个简洁的 AI 助手，会参考注入的相关记忆回答用户。',
      extensions: installed.extensions,
      transformers: installed.transformers,
      tools: [...installed.tools, getWeather],
      sessionStorage: createFileSessionStorage({ baseDir: './.aipack/sessions' }),
    });
  }
  console.log(`🛠 已注入 ${installed.tools.length + 1} 个工具（${installed.tools.length} 记忆 + 1 自定义 get_weather）\n`);

  // 5. 会话 s1：捕获用户偏好 + 触发自定义工具
  console.log('▶ 会话 s1：捕获用户偏好 + 触发自定义工具');
  console.log('  用户: 我喜欢用 React + TypeScript 做项目，顺便查下北京天气');
  const runtime1 = createMemoryRuntime(streamFn);

  const r1 = await runtime1.run(
    createRequest('我喜欢用 React + TypeScript 做项目，顺便查下北京天气', { sessionKey: 's1' }),
  );
  console.log(`  助手: ${r1.content}`);
  console.log(`  🔧 使用的工具: ${r1.toolsUsed.length ? r1.toolsUsed.join(', ') : '（无）'}\n`);

  const memories = await mem.store.list();
  console.log(`  📝 已捕获 ${memories.length} 条记忆：`);
  for (const m of memories) {
    console.log(`     • [${m.source}] ${m.content.replace(/\s+/g, ' ').slice(0, 60)}...`);
  }
  console.log();

  // 6. 会话 s2：跨会话检索注入（换 Runtime 实例，共享 memory store）
  console.log('▶ 会话 s2：跨会话检索注入');
  console.log('  用户: 我之前说过用什么技术栈？');

  // 拦截 streamFn 收到的 context，观察注入效果
  const captured: Context[] = [];
  const observeStreamFn: StreamFn = (m, ctx) => {
    captured.push({
      systemPrompt: ctx.systemPrompt,
      messages: ctx.messages.map((mm) => ({ ...mm })),
      tools: ctx.tools,
    });
    return streamFn(m, ctx);
  };
  const runtime2 = createMemoryRuntime(observeStreamFn);

  const r2 = await runtime2.run(
    createRequest('我之前说过用什么技术栈？', { sessionKey: 's2' }),
  );
  console.log(`  助手: ${r2.content}\n`);

  const ctx2 = captured[0];
  if (ctx2) {
    const userText = latestUserText(ctx2);
    const hasInjection = userText.includes(MEMORY_BLOCK_START);
    console.log(`  ${hasInjection ? '✅' : '❌'} 注入状态：${hasInjection ? '已自动注入相关记忆' : '未注入'}`);
    if (hasInjection) {
      console.log(`  📌 注入片段（前 150 字）: ${userText.slice(0, 150)}...`);
    }
  }
  console.log();

  // 7. 工具调用：直接用 save_memory / search_memory
  console.log('▶ 工具调用：save_memory / search_memory');
  const tools = installed.tools;
  const saveTool = tools.find((t: Tool) => t.name === 'save_memory')!;
  const searchTool = tools.find((t: Tool) => t.name === 'search_memory')!;

  const saveRes = await saveTool.execute('call-save', {
    content: '用户每周五做代码评审',
    concepts: ['code-review', 'friday'],
  });
  const saveText = (saveRes.content as TextContent[]).map((c) => c.text).join('');
  console.log(`  save_memory → ${saveText}`);

  const searchRes = await searchTool.execute('call-search', { query: '代码评审', limit: 3 });
  const searchText = (searchRes.content as TextContent[]).map((c) => c.text).join('');
  console.log(`  search_memory → ${searchText.replace(/\s+/g, ' ').slice(0, 100)}...\n`);

  // 8. 手动合并相似记忆
  console.log('▶ 手动 consolidate 合并相似记忆');
  const before = await mem.store.count();
  const { merged, pruned } = await mem.store.consolidate({ similarityThreshold: 0.6 });
  const after = await mem.store.count();
  console.log(`  合并前 ${before} 条 → 合并 ${merged} 条 / 修剪 ${pruned} 条 → 合并后 ${after} 条\n`);

  // 8. 汇总
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║   ✅ 实例运行完成                                   ║');
  console.log(`║   记忆存储: ${mem.store.constructor.name}`);
  console.log(`║   记忆目录: ./.aipack/memory`);
  console.log('╚════════════════════════════════════════════════════╝');

  await runtime1.close();
  await runtime2.close();
}

main().catch((err) => {
  console.error('运行失败:', err);
  process.exit(1);
});
