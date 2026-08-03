/**
 * 根目录示例：使用 agentpack-memory 实现跨会话长期记忆
 *
 * 演示完整闭环：capture → compress → index → recall/inject → consolidate
 *   1. 用 createMemoryPlugin 装配记忆插件（FileMemoryStore 持久化 + BM25 检索）
 *   2. 会话 s1：用户告知偏好 → capture 自动落盘一条记忆
 *   3. 会话 s2：换一个会话提问 → injection 自动检索并注入相关记忆
 *   4. 直接调用记忆工具 save_memory / search_memory
 *   5. 展示手动 consolidate 合并相似记忆
 *
 * 运行（默认零依赖、零 API Key，用假 streamFn）：
 *   npx tsx examples/agent-memory.ts
 *
 * 接入真实 LLM（可选）：
 *   DEEPSEEK_API_KEY=sk-xxx npx tsx examples/agent-memory.ts
 *   或：USE_REAL_LLM=1 DEEPSEEK_API_KEY=sk-xxx npx tsx examples/agent-memory.ts
 */
import {
  createRuntime,
  createRequest,
  extractText,
  createEmptyUsage,
  createFileSessionStorage,
} from 'agentpack';
import type {
  StreamFn,
  Context,
  Model,
  AssistantMessage,
  ContentBlock,
  TextContent,
  Tool,
} from 'agentpack';
import { createMemoryPlugin, MEMORY_BLOCK_START } from 'agentpack-memory';

// ─── 假 streamFn：无 API Key 时降级使用，返回固定中文回复 ─────────────

function makeFakeStreamFn(reply: string): StreamFn {
  return (model: Model, _context: Context) => {
    return (async function* () {
      yield {
        type: 'start' as const,
        partial: { content: [{ type: 'text' as const, text: '' }] as ContentBlock[] },
      };
      yield { type: 'text_delta' as const, delta: reply };
      yield {
        type: 'done' as const,
        message: {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: reply }] as ContentBlock[],
          stopReason: 'stop',
          usage: createEmptyUsage(),
          model: model.id,
          provider: model.provider,
          timestamp: Date.now(),
        } as AssistantMessage,
      };
    })();
  };
}

// ─── 可选：接入真实 LLM（DeepSeek） ──────────────────────────────────

async function maybeCreateRealStreamFn(): Promise<{ model: Model; streamFn: StreamFn } | null> {
  const useReal = process.env.USE_REAL_LLM === '1' || process.env.DEEPSEEK_API_KEY;
  if (!useReal) return null;
  try {
    const { getBuiltinModel, hasProviderConfigured } = await import('agentpack/ai');
    const { adaptAiModel, createStreamFnFromAi } = await import('agentpack/adapters/ai');
    const aiModel = getBuiltinModel('deepseek', 'deepseek-chat');
    if (!aiModel || !hasProviderConfigured('deepseek')) return null;
    console.log('✅ 检测到 DEEPSEEK_API_KEY，使用真实 DeepSeek 模型\n');
    return { model: adaptAiModel(aiModel), streamFn: createStreamFnFromAi(aiModel) };
  } catch {
    return null; // 子路径不可用则降级
  }
}

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
  console.log('║   agentpack-memory 跨会话记忆实例                   ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  // 1. 装配记忆插件（FileMemoryStore 持久化到 ./.agentpack/memory）
  const mem = createMemoryPlugin({
    baseDir: './.agentpack/memory',
    maxMemories: 3,          // 每轮注入 top-3
    consolidateOn: 5,        // 每 5 次捕获自动合并一次
  });
  const installed = mem.install();

  // 2. 选择模型与 streamFn（真实 LLM 优先，否则假 streamFn）
  const real = await maybeCreateRealStreamFn();
  const model: Model = real?.model ?? {
    id: 'fake-model',
    name: 'fake-model',
    provider: 'fake',
    contextWindow: 128000,
    maxTokens: 8192,
    reasoning: false,
  };
  let streamFn: StreamFn = real?.streamFn ?? makeFakeStreamFn('好的，我记住了。');

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

  // 4. 创建 Runtime：记忆工具 + 自定义工具一次性注入 tools
  //    （也支持后续动态注册：runtime.registerTool(...) / registerTools([...])）
  const runtime = createRuntime({
    model,
    streamFn,
    systemPrompt: '你是一个简洁的 AI 助手，会参考注入的相关记忆回答用户。',
    extensions: installed.extensions,
    transformers: installed.transformers,
    tools: [...installed.tools, getWeather],
    sessionStorage: createFileSessionStorage({ baseDir: './.agentpack/sessions' }),
  });
  console.log(`🛠 已注入 ${installed.tools.length + 1} 个工具（${installed.tools.length} 记忆 + 1 自定义 get_weather）\n`);

  // 5. 会话 s1：捕获用户偏好 + 触发自定义工具
  console.log('▶ 会话 s1：捕获用户偏好 + 触发自定义工具');
  console.log('  用户: 我喜欢用 React + TypeScript 做项目，顺便查下北京天气');
  if (!real) streamFn = makeFakeStreamFn('好的，我记住了你的技术栈。北京今天晴 26°C。');
  runtime.setStreamFn(streamFn);

  const r1 = await runtime.run(
    createRequest('我喜欢用 React + TypeScript 做项目，顺便查下北京天气', {
      sessionKey: 's1',
    }),
  );
  console.log(`  助手: ${r1.content}`);
  console.log(`  🔧 使用的工具: ${r1.toolsUsed.length ? r1.toolsUsed.join(', ') : '（假模式未触发）'}\n`);

  const memories = await mem.store.list();
  console.log(`  📝 已捕获 ${memories.length} 条记忆：`);
  for (const m of memories) {
    console.log(`     • [${m.source}] ${m.content.replace(/\s+/g, ' ').slice(0, 60)}...`);
  }
  console.log();

  // 6. 会话 s2：跨会话检索注入（换 sessionKey）
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
    return (real?.streamFn ?? makeFakeStreamFn('根据记忆，你之前提到用 React + TypeScript，深色主题，VSCode。'))(m, ctx);
  };
  runtime.setStreamFn(observeStreamFn);

  const r2 = await runtime.run(
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
  console.log(`║   记忆目录: ./.agentpack/memory`);
  console.log('╚════════════════════════════════════════════════════╝');

  await runtime.close();
}

main().catch((err) => {
  console.error('运行失败:', err);
  process.exit(1);
});
