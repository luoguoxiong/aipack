/**
 * 根目录示例：使用 agentpack-compression 实现多级上下文压缩
 *
 * 演示五级渐进式降级：
 *   L1: ToolOutputTrim       工具输出裁剪（thinking 剥离 + tool_result 裁剪）
 *   L2: MessageSummarize     旧消息摘要（Fork Agent）
 *   L3: TaskStateExtraction  任务状态提取（结构化 JSON）
 *   L4: SessionCheckpoint     会话检查点（持久化 + 激进缩减）
 *   L5: NewSessionHandoff    新会话交接（保底重置）
 *
 * 运行（零依赖、零 API Key，用假 streamFn 模拟）：
 *   npx tsx examples/compression-demo.ts
 *
 * 接入真实 LLM（可选，参考 deepseek.ts 的 streamFn 构造）：
 *   DEEPSEEK_API_KEY=sk-xxx npx tsx examples/compression-demo.ts
 */

import {
  createRuntime,
  createRequest,
  extractText,
  createEmptyUsage,
  createMemorySessionStorage,
  createDefaultTransformers,
} from 'agentpack';
import type {
  StreamFn,
  Context,
  Model,
  AssistantMessage,
  ContentBlock,
  Tool,
} from 'agentpack';
import {
  createCompressionTransformer,
  loadCompressionConfig,
} from 'agentpack-compression';

// ─── 假模型：极小 contextWindow 以快速触发压缩 ─────────────────────

const FAKE_MODEL: Model = {
  id: 'demo-model',
  name: 'Demo Model',
  provider: 'demo',
  contextWindow: 800,   // 小窗口：~3200 字符即满
  maxTokens: 1024,
  reasoning: false,
};

// ─── 假 streamFn：区分 Fork Agent 调用与正常对话 ───────────────────

function makeFakeStreamFn(): StreamFn {
  let toolCallCounter = 0;

  return (_model: Model, ctx: Context) => {
    return (async function* () {
      const sysPrompt = ctx.systemPrompt;

      // ── 检测 L2 Fork Agent（摘要请求） ──
      if (sysPrompt.includes('context compression agent')) {
        const summary = [
          '## Context Summary',
          `User is running a demo to test context compression.`,
          `Previous interactions involved reading files and getting tool results.`,
          '',
          '## Key Decisions',
          '- Demo is working correctly',
          '',
          '## Tool Results',
          '- read_file: returned file content successfully',
          '',
          '## Pending Actions',
          '- Continue testing compression levels',
        ].join('\n');
        yield { type: 'start' as const, partial: { content: [{ type: 'text' as const, text: '' }] } };
        yield { type: 'text_delta' as const, delta: summary };
        yield { type: 'done' as const, message: makeAssistant(_model, summary) };
        return;
      }

      // ── 检测 L3 Fork Agent（任务状态提取） ──
      if (sysPrompt.includes('task state extraction')) {
        const taskState = JSON.stringify({
          originalRequest: 'User is testing agentpack-compression multi-level context compression',
          currentPhase: 'demonstration',
          completedSteps: ['Started runtime', 'Executed tool calls', 'Triggered L1 and L2 compression'],
          pendingSteps: ['Complete the demo'],
          keyDecisions: ['Using fake model with small contextWindow'],
          constraints: ['No real API key available'],
          toolResults: [
            { tool: 'read_file', status: 'success', summary: 'Returned file content' },
          ],
          errors: [],
          variables: {},
        }, null, 2);
        yield { type: 'start' as const, partial: { content: [{ type: 'text' as const, text: '' }] } };
        yield { type: 'text_delta' as const, delta: taskState };
        yield { type: 'done' as const, message: makeAssistant(_model, taskState) };
        return;
      }

      // ── 检测 L5 Fork Agent（会话交接） ──
      if (sysPrompt.includes('session handoff')) {
        const handoff = [
          '## Original Task',
          'Testing agentpack-compression package with 5-level progressive degradation.',
          '',
          '## What Was Done',
          '- Created runtime with compression transformer',
          '- Executed multiple tool calls to fill context',
          '- Triggered L1 (tool output trim) and L2 (message summarize)',
          '- Context still exceeded limits, triggering L3+',
          '',
          '## Current State',
          'Context window exhausted after multiple compression attempts.',
          '',
          '## What Remains',
          '- Continue the demo in a fresh session',
          '',
          '## Critical Context',
          '- Using fake model with 800 token contextWindow',
          '- All tool calls returned successfully',
        ].join('\n');
        yield { type: 'start' as const, partial: { content: [{ type: 'text' as const, text: '' }] } };
        yield { type: 'text_delta' as const, delta: handoff };
        yield { type: 'done' as const, message: makeAssistant(_model, handoff) };
        return;
      }

      // ── 正常对话：检查上一条消息是否为 toolResult ──
      const lastMsg = ctx.messages[ctx.messages.length - 1];
      const isAfterTool = lastMsg && (lastMsg as any).role === 'toolResult';

      if (isAfterTool) {
        // 工具执行后：返回纯文本回复（无更多工具调用）
        const reply = '好的，文件内容已读取完毕。';
        yield { type: 'start' as const, partial: { content: [{ type: 'text' as const, text: '' }] } };
        yield { type: 'text_delta' as const, delta: reply };
        yield { type: 'done' as const, message: makeAssistant(_model, reply) };
      } else {
        // 首次回复：返回 toolCall 触发 read_file
        const callId = `call_${++toolCallCounter}`;
        const content: ContentBlock[] = [
          { type: 'text' as const, text: '让我读取文件内容。' },
          { type: 'toolCall' as const, id: callId, name: 'read_file', arguments: { path: `file_${toolCallCounter}.txt` } },
        ];
        yield { type: 'start' as const, partial: { content } };
        yield { type: 'text_delta' as const, delta: '让我读取文件内容。' };
        yield {
          type: 'done' as const,
          message: makeAssistantWithToolCall(_model, content, callId),
        };
      }
    })();
  };
}

function makeAssistant(model: Model, text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: createEmptyUsage(),
    model: model.id,
    provider: model.provider,
    timestamp: Date.now(),
  };
}

function makeAssistantWithToolCall(model: Model, content: ContentBlock[], _callId: string): AssistantMessage {
  return {
    role: 'assistant',
    content,
    stopReason: 'toolUse',
    usage: createEmptyUsage(),
    model: model.id,
    provider: model.provider,
    timestamp: Date.now(),
  };
}

// ─── 自定义工具：返回超长内容以快速填满上下文 ──────────────────────

const readFileTool: Tool = {
  name: 'read_file',
  description: '读取文件内容（演示用，返回超长内容）',
  parameters: {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: '文件路径' },
    },
    required: ['path'],
  },
  async execute(_toolCallId: string, args: unknown) {
    const { path } = (args ?? {}) as { path?: string };
    // 生成 25 行内容，约 ~180 token，3-4 次调用逐步填满 800 token 窗口
    const lines: string[] = [];
    lines.push(`File: ${path}`);
    lines.push('========================================');
    for (let i = 1; i <= 25; i++) {
      lines.push(`Line ${i}: Data row ${i} from ${path}. Contains configuration values for testing compression.`);
    }
    lines.push('========================================');
    lines.push('End of file.');
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      details: { path, lineCount: lines.length },
    };
  },
};

// ─── 辅助函数 ──────────────────────────────────────────────────────

function logSeparator(title: string) {
  console.log('\n' + '─'.repeat(50));
  console.log(`  ${title}`);
  console.log('─'.repeat(50));
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── 主流程 ────────────────────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║   agentpack-compression 多级压缩演示               ║');
  console.log('╚════════════════════════════════════════════════════╝');
  console.log(`  模型: ${FAKE_MODEL.name} (contextWindow: ${FAKE_MODEL.contextWindow} tokens)`);
  console.log(`  工具: read_file（每次返回 25 行内容 ~180 tokens）`);
  console.log(`  预期: 第 1 轮触发 L1，第 6 轮触发 L2`);

  // 1. 加载压缩配置（使用小 contextWindow 友好的阈值）
  const compressionConfig = loadCompressionConfig({
    l1: { threshold: 0.50, targetRatio: 0.40, toolResultMaxLines: 12, toolResultHeadLines: 3, toolResultTailLines: 3 },
    l2: { threshold: 0.65, targetRatio: 0.50, protectedRecentCount: 4, minResourcesToCompress: 3 },
    l3: { threshold: 0.78, targetRatio: 0.40, protectedRecentCount: 3 },
    l4: { threshold: 0.88, targetRatio: 0.30, minWorkingSet: 2 },
    l5: { threshold: 0.95 },
  });

  console.log(`  配置: L1>${(compressionConfig.l1.threshold * 100).toFixed(0)}% L2>${(compressionConfig.l2.threshold * 100).toFixed(0)}% L3>${(compressionConfig.l3.threshold * 100).toFixed(0)}% L4>${(compressionConfig.l4.threshold * 100).toFixed(0)}% L5>${(compressionConfig.l5.threshold * 100).toFixed(0)}%\n`);

  // 2. 创建压缩转换器
  const compressionTransformer = createCompressionTransformer({
    config: compressionConfig,
    model: FAKE_MODEL,
    streamFn: makeFakeStreamFn(),
    sessionStorage: createMemorySessionStorage(),
    contextWindow: FAKE_MODEL.contextWindow,
  });

  // 3. 创建 Runtime：默认转换器 + 压缩转换器
  const transformers = [
    ...createDefaultTransformers(),
    compressionTransformer,
  ];

  console.log(`  转换器列表: ${transformers.map(t => `${t.name}(${t.priority})`).join(', ')}\n`);

  const runtime = createRuntime({
    model: FAKE_MODEL,
    streamFn: makeFakeStreamFn(),
    systemPrompt: '你是一个文件分析助手，使用 read_file 工具读取文件并分析。',
    transformers,
    tools: [readFileTool],
  });

  // 4. 模拟多轮对话，逐步填满上下文
  const turns = [
    '请读取 file_1.txt 的内容',
    '请读取 file_2.txt 的内容',
    '请读取 file_3.txt 的内容',
    '请读取 file_4.txt 的内容',
    '请读取 file_5.txt 的内容',
    '请读取 file_6.txt 的内容',
    '请读取 file_7.txt 的内容',
    '请读取 file_8.txt 的内容',
  ];

  for (let i = 0; i < turns.length; i++) {
    logSeparator(`Turn ${i + 1}: ${turns[i].slice(0, 30)}...`);

    const result = await runtime.run(
      createRequest(turns[i], { sessionKey: 'demo' }),
    );

    // 估算压缩后的上下文大小
    const messages = runtime.getMessages('demo');
    const totalText = messages
      .map(m => {
        const c = (m as any).content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return extractText(c as ContentBlock[]);
        if (typeof m === 'string') return m;
        return '';
      })
      .join('\n');
    const estTokens = estimateTokens(totalText);
    const ratio = ((estTokens / FAKE_MODEL.contextWindow) * 100).toFixed(1);

    console.log(`  助手: ${result.content.slice(0, 80)}`);
    console.log(`  消息数: ${messages.length}`);
    console.log(`  估算 Token: ~${estTokens} / ${FAKE_MODEL.contextWindow} (${ratio}%)`);

    // 检查是否出现压缩产物
    const hasCompaction = messages.some(m => {
      const r = (m as any).role;
      const c = (m as any).content;
      const text = typeof m === 'string' ? m
        : typeof c === 'string' ? c
        : '';
      return r === 'compactionSummary' || text.includes('Context Summary');
    });
    const hasTaskState = messages.some(m => {
      const r = (m as any).role;
      const c = (m as any).content;
      const text = typeof m === 'string' ? m
        : typeof c === 'string' ? c
        : '';
      return r === 'taskState' || text.includes('originalRequest');
    });
    const hasHandoff = messages.some(m => {
      const c = (m as any).content;
      const text = typeof m === 'string' ? m
        : typeof c === 'string' ? c
        : '';
      return text.includes('Session Handoff');
    });
    const hasCheckpoint = messages.some(m => {
      const c = (m as any).content;
      const text = typeof m === 'string' ? m
        : typeof c === 'string' ? c
        : '';
      return text.includes('Session Checkpoint');
    });

    const compressionMarkers: string[] = [];
    if (hasCompaction) compressionMarkers.push('L2-Summary');
    if (hasTaskState) compressionMarkers.push('L3-TaskState');
    if (hasCheckpoint) compressionMarkers.push('L4-Checkpoint');
    if (hasHandoff) compressionMarkers.push('L5-Handoff');

    if (compressionMarkers.length > 0) {
      console.log(`  压缩产物: ${compressionMarkers.join(', ')}`);
    }

    // 如果触发了 L5 交接，停止循环
    if (hasHandoff) {
      console.log('\n  ⚡ L5 会话交接已触发，演示完成。');
      break;
    }
  }

  // 5. 最终状态报告
  logSeparator('最终上下文状态');

  const finalMessages = runtime.getMessages('demo');
  console.log(`  最终消息数: ${finalMessages.length}`);
  console.log('  消息列表:');
  for (let i = 0; i < finalMessages.length; i++) {
    const msg = finalMessages[i] as any;
    const role = msg.role ?? (typeof msg === 'string' ? 'string' : 'unknown');
    let text: string;
    if (typeof msg === 'string') text = msg;
    else if (typeof msg.content === 'string') text = msg.content;
    else if (Array.isArray(msg.content)) text = extractText(msg.content as ContentBlock[]);
    else text = JSON.stringify(msg).slice(0, 80);
    const preview = text.replace(/\n/g, ' ').slice(0, 80);
    console.log(`    [${i}] ${role}: ${preview}...`);
  }

  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║   ✅ 压缩演示完成                                   ║');
  console.log('╚════════════════════════════════════════════════════╝');

  await runtime.close();
}

main().catch((err) => {
  console.error('运行失败:', err);
  process.exit(1);
});
