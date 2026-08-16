/**
 * 往返验证脚本 —— 不依赖真实 LLM / API Key。
 *
 * 用 InMemoryStore + 假 streamFn 验证完整闭环：
 *   capture → index → recall/inject → strip（防累积）→ tools
 *
 * 单会话架构（A 方案）：每个 Runtime 绑定一个 sessionKey。
 * 跨会话记忆检索通过多 Runtime 实例共享同一 store 实现。
 *
 * 运行：pnpm --filter aipack-memory example
 *   或：node --import tsx examples/round-trip.ts
 */

import {
  createRuntime,
  createRequest,
  extractText,
  createEmptyUsage,
} from '@aipack-ai/agent';
import type {
  StreamFn,
  Context,
  Model,
  AssistantMessage,
  ContentBlock,
  TextContent,
} from '@aipack-ai/agent';

import { createMemoryPlugin } from '../src/plugin';
import { InMemoryStore } from '../src/store/in-memory-store';
import { createMemoryTools } from '../src/tools/memory-tools';
import {
  MEMORY_BLOCK_START,
} from '../src/injection/sentinels';
import type { ToolResult } from '@aipack-ai/agent';

// ─── 断言工具 ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

// ─── 假 streamFn：捕获 context 并返回固定回复 ─────────────────────────

const capturedContexts: Context[] = [];

function makeFakeStreamFn(reply: string): StreamFn {
  return (model: Model, context: Context) => {
    // 深拷贝 messages 快照（避免后续 splice 影响断言）
    capturedContexts.push({
      systemPrompt: context.systemPrompt,
      messages: context.messages.map((m) => ({ ...m })),
      tools: context.tools,
    });
    // 返回 AsyncGenerator（StreamResult = AsyncIterable<StreamEvent>）
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

// ─── 取最新 user 消息的纯文本 ────────────────────────────────────────

function latestUserText(ctx: Context): string {
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    const msg = ctx.messages[i];
    if (msg.role === 'user') {
      return extractText(msg.content as string | ContentBlock[]);
    }
  }
  return '';
}

/** 统计文本中 sentinel 块出现次数 */
function countSentinelBlocks(text: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(MEMORY_BLOCK_START, idx)) !== -1) {
    count++;
    idx += MEMORY_BLOCK_START.length;
  }
  return count;
}

// ─── 模型定义 ──────────────────────────────────────────────────────────

const model: Model = {
  id: 'test-model',
  name: 'test-model',
  provider: 'test',
  contextWindow: 128000,
  maxTokens: 8192,
  reasoning: false,
};

// ─── 创建带记忆插件的 Runtime（多 Runtime 共享同一 store） ───────────

function createMemoryRuntime(streamFn: StreamFn) {
  const mem = createMemoryPlugin({ store });
  const installed = mem.install();
  return createRuntime({
    model,
    streamFn,
    extensions: installed.extensions,
    transformers: installed.transformers,
    tools: installed.tools,
  });
}

// 共享 store（跨会话记忆检索的关键）
const store = new InMemoryStore();

// ─── 主流程 ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n=== aipack-memory 往返验证 ===\n');

  // s1：捕获会话；s2：检索注入会话（跨会话记忆）
  const runtime1 = createMemoryRuntime(makeFakeStreamFn('好的，我记住了你用 React + TypeScript。'));
  const runtime2 = createMemoryRuntime(makeFakeStreamFn('根据之前的记忆，你用的是 React + TypeScript。'));

  // ─── 测试 1：capture ──────────────────────────────────────────────
  console.log('▶ 测试 1：自动捕获（capture）');

  await runtime1.run(
    createRequest('我喜欢用 React + TypeScript 做项目', { sessionKey: 's1' }),
  );

  const memories = await store.list();
  assert(memories.length >= 1, `捕获到 ${memories.length} 条记忆（应 ≥1）`);
  assert(
    memories.some((m) => m.content.includes('React')),
    '捕获的 memory content 含 "React"',
  );
  console.log(`  📝 捕获内容: ${memories[0]?.content.slice(0, 80)}...\n`);

  // ─── 测试 2：injection（跨会话：s2 检索 s1 的记忆）─────────────────
  console.log('▶ 测试 2：自动注入（injection，跨会话检索）');

  capturedContexts.length = 0;

  await runtime2.run(
    createRequest('我之前说过用什么 React 技术栈？', { sessionKey: 's2' }),
  );

  const ctx2 = capturedContexts[0];
  assert(ctx2 != null, 'streamFn 收到了 context');
  if (ctx2) {
    const userText = latestUserText(ctx2);
    assert(
      userText.includes(MEMORY_BLOCK_START),
      '最新 user 消息含 sentinel 块（MEMORY_BLOCK_START）',
    );
    assert(
      userText.includes('React'),
      '注入的记忆内容含 "React"',
    );
    console.log(`  📝 注入后的 user 消息（前 120 字）: ${userText.slice(0, 120)}...\n`);
  }

  // ─── 测试 3：strip 防累积（同一 s2 会话再跑一次）──────────────────
  console.log('▶ 测试 3：剥离防累积（strip-then-inject）');

  capturedContexts.length = 0;
  runtime2.setStreamFn(makeFakeStreamFn('没错，你之前提到过 React + TypeScript。'));

  await runtime2.run(
    createRequest('我之前说过用什么 React 技术栈？', { sessionKey: 's2' }),
  );

  const ctx3 = capturedContexts[0];
  if (ctx3) {
    const allUserText = ctx3.messages
      .filter((m) => m.role === 'user')
      .map((m) => extractText(m.content as string | ContentBlock[]))
      .join('\n---\n');

    const blockCount = countSentinelBlocks(allUserText);
    assert(
      blockCount === 1,
      `全部 user 消息中只有 ${blockCount} 个 sentinel 块（应 =1，防累积）`,
    );
    console.log();
  }

  // ─── 测试 4：BM25 检索（CJK + Latin）─────────────────────────────
  console.log('▶ 测试 4：BM25 检索（CJK + Latin 混合）');

  const searchResults = await store.search('React 技术栈', 5);
  assert(
    searchResults.length >= 1,
    `检索到 ${searchResults.length} 条相关记忆（应 ≥1）`,
  );
  assert(
    searchResults.length > 0 && searchResults[0].entry.content.includes('React'),
    'top-1 命中含 "React" 的记忆',
  );
  console.log();

  // ─── 测试 5：记忆工具往返 ─────────────────────────────────────────
  console.log('▶ 测试 5：记忆工具往返（save_memory / search_memory）');

  const tools = createMemoryTools(store);
  const saveTool = tools.find((t) => t.name === 'save_memory')!;
  const searchTool = tools.find((t) => t.name === 'search_memory')!;

  // save_memory
  const saveResult: ToolResult = await saveTool.execute('call-1', {
    content: '用户偏好深色主题',
    concepts: ['dark-mode', 'ui'],
  });
  const saveText = saveResult.content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('');
  assert(saveText.includes('已保存'), `save_memory 返回成功: ${saveText}`);
  assert(saveResult.details != null && typeof saveResult.details === 'object' &&
    'id' in saveResult.details, 'save_memory 返回 details.id');

  // search_memory
  const searchToolResult: ToolResult = await searchTool.execute('call-2', {
    query: '深色主题',
    limit: 3,
  });
  const searchText = searchToolResult.content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('');
  assert(
    searchText.includes('深色主题'),
    `search_memory 命中含 "深色主题": ${searchText.slice(0, 80)}`,
  );
  console.log();

  // ─── 测试 6：sentinel 工具函数 ───────────────────────────────────
  console.log('▶ 测试 6：sentinel 工具函数');

  const { stripMemoryBlock, wrapMemoryBlock } = await import('../src/injection/sentinels');
  const original = '这是一条普通消息';
  const wrapped = wrapMemoryBlock(['记忆行1', '记忆行2']);
  const roundTrip = stripMemoryBlock(`${wrapped}\n\n${original}`);
  assert(
    roundTrip === original,
    `stripMemoryBlock(wrapMemoryBlock(...)) 往返一致: "${roundTrip}" === "${original}"`,
  );
  console.log();

  // ─── 汇总 ─────────────────────────────────────────────────────────
  console.log('════════════════════════════════════════');
  console.log(`  通过: ${passed}  失败: ${failed}`);
  console.log('════════════════════════════════════════\n');

  await runtime1.close();
  await runtime2.close();

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('验证脚本异常:', err);
  process.exit(1);
});
