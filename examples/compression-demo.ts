/**
 * 根目录示例：使用 aipack-compression + DeepSeek 模型实现多级上下文压缩
 *
 * 演示五级渐进式降级：
 *   L1: ToolOutputTrim       工具输出裁剪（thinking 剥离 + tool_result 裁剪）
 *   L2: MessageSummarize     旧消息摘要（Fork Agent 调用真实 DeepSeek）
 *   L3: TaskStateExtraction  任务状态提取（结构化 JSON）
 *   L4: SessionCheckpoint     会话检查点（持久化 + 激进缩减）
 *   L5: NewSessionHandoff    新会话交接（保底重置）
 *
 * 运行:
 *   DEEPSEEK_API_KEY=sk-xxx npx tsx examples/compression-demo.ts
 * 换用推理模型:
 *   DEEPSEEK_API_KEY=sk-xxx DEEPSEEK_MODEL=deepseek-reasoner npx tsx examples/compression-demo.ts
 * 自定义模拟窗口大小（用于快速触发压缩，不传则用模型真实 contextWindow）:
 *   DEEPSEEK_API_KEY=sk-xxx DEMO_CONTEXT_WINDOW=4000 npx tsx examples/compression-demo.ts
 */

import {
  createRuntime,
  createRequest,
  extractText,
  createMemorySessionStorage,
  createDefaultTransformers,
  adaptAiModel,
  createStreamFnFromAi,
  getBuiltinModel,
  hasProviderConfigured,
} from '@aipack/agent';
import type { Model, ContentBlock, Tool } from '@aipack/agent';
import {
  createCompressionTransformer,
  loadCompressionConfig,
} from '@aipack/compression';

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
    console.error('⚠️  未检测到 DEEPSEEK_API_KEY，无法调用真实模型。');
    console.error('   设置环境变量后重试: DEEPSEEK_API_KEY=sk-xxx npx tsx examples/compression-demo.ts');
    process.exit(1);
  }

  // ── 3. 适配为框架 Model ─────────────────────────────────────────
  const realModel = adaptAiModel(aiModel);

  // 演示用：允许通过环境变量覆盖 contextWindow，用小窗口快速触发压缩
  // 不设置 DEMO_CONTEXT_WINDOW 则使用模型真实 contextWindow（如 deepseek-chat 的 64K）
  const demoContextWindow = process.env.DEMO_CONTEXT_WINDOW
    ? Number(process.env.DEMO_CONTEXT_WINDOW)
    : realModel.contextWindow;

  const model: Model = { ...realModel, contextWindow: demoContextWindow };

  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║   aipack-compression + DeepSeek 多级压缩演示    ║');
  console.log('╚════════════════════════════════════════════════════╝');
  console.log(`  模型: ${model.name} (${model.id})`);
  console.log(`  contextWindow: ${model.contextWindow} tokens${demoContextWindow !== realModel.contextWindow ? ` (覆盖自 ${realModel.contextWindow})` : ''}`);
  console.log(`  工具: read_file（返回 30 行内容，约 250 tokens/次）`);
  console.log(`  预期: 多轮对话后逐步触发 L1 → L2 → L3+ 压缩\n`);

  // ── 4. 加载压缩配置 ────────────────────────────────────────────
  const compressionConfig = loadCompressionConfig({
    l1: { threshold: 0.50, targetRatio: 0.40, toolResultMaxLines: 10, toolResultHeadLines: 3, toolResultTailLines: 3 },
    l2: { threshold: 0.65, targetRatio: 0.50, protectedRecentCount: 4, minResourcesToCompress: 3 },
    l3: { threshold: 0.78, targetRatio: 0.40, protectedRecentCount: 3 },
    l4: { threshold: 0.88, targetRatio: 0.30, minWorkingSet: 2 },
    l5: { threshold: 0.95 },
  });

  console.log(`  配置: L1>${(compressionConfig.l1.threshold * 100).toFixed(0)}% L2>${(compressionConfig.l2.threshold * 100).toFixed(0)}% L3>${(compressionConfig.l3.threshold * 100).toFixed(0)}% L4>${(compressionConfig.l4.threshold * 100).toFixed(0)}% L5>${(compressionConfig.l5.threshold * 100).toFixed(0)}%\n`);

  // ── 5. 创建压缩转换器 ───────────────────────────────────────────
  // streamFn 复用真实 DeepSeek 适配器，Fork Agent 也会调用真实模型生成摘要
  const streamFn = createStreamFnFromAi(aiModel);
  const compressionTransformer = createCompressionTransformer({
    config: compressionConfig,
    model,
    streamFn,
    sessionStorage: createMemorySessionStorage(),
    contextWindow: model.contextWindow,
  });

  // ── 6. 创建 Runtime ─────────────────────────────────────────────
  const transformers = [
    ...createDefaultTransformers(),
    compressionTransformer,
  ];

  console.log(`  转换器列表: ${transformers.map(t => `${t.name}(${t.priority})`).join(', ')}\n`);

  const runtime = createRuntime({
    model,
    streamFn,
    sessionKey: 'demo',
    systemPrompt: '你是一个文件分析助手，使用 read_file 工具读取文件并简要分析内容。',
    transformers,
    tools: [readFileTool],
  });

  // ── 7. 模拟多轮对话，逐步填满上下文 ────────────────────────────
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
    logSeparator(`Turn ${i + 1}: ${turns[i]}`);

    // 流式输出本轮回复
    process.stdout.write('  AI: ');
    const request = createRequest(turns[i]);

    for await (const chunk of runtime.stream(request)) {
      if (chunk.type === 'text' && chunk.content) process.stdout.write(chunk.content);
      if (chunk.type === 'tool_start') console.log(`\n  [调用工具] ${chunk.toolName}`);
      if (chunk.type === 'tool_end') console.log(`  [工具完成] ${chunk.toolName}`);
    }
    console.log('\n');

    // 估算压缩后的上下文大小
    const messages = runtime.getMessages();
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
    const ratio = ((estTokens / model.contextWindow) * 100).toFixed(1);

    console.log(`  消息数: ${messages.length}`);
    console.log(`  估算 Token: ~${estTokens} / ${model.contextWindow} (${ratio}%)`);

    // 检查是否出现压缩产物
    const markers = detectCompressionArtifacts(messages);
    if (markers.length > 0) {
      console.log(`  压缩产物: ${markers.join(', ')}`);
    }

    // 如果触发了 L5 交接，停止循环
    if (markers.includes('L5-Handoff')) {
      console.log('\n  ⚡ L5 会话交接已触发，演示完成。');
      break;
    }
  }

  // ── 8. 最终状态报告 ─────────────────────────────────────────────
  logSeparator('最终上下文状态');

  const finalMessages = runtime.getMessages();
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

// ─── 自定义工具：返回超长内容以快速填满上下文 ──────────────────────

const readFileTool: Tool = {
  name: 'read_file',
  description: '读取文件内容（演示用，返回多行内容）',
  parameters: {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: '文件路径' },
    },
    required: ['path'],
  },
  async execute(_toolCallId: string, args: unknown) {
    const { path } = (args ?? {}) as { path?: string };
    // 生成 30 行内容，约 ~250 token，多次调用逐步填满上下文窗口
    const lines: string[] = [];
    lines.push(`File: ${path}`);
    lines.push('========================================');
    for (let i = 1; i <= 30; i++) {
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

function detectCompressionArtifacts(messages: any[]): string[] {
  const markers: string[] = [];
  const hasCompaction = messages.some(m => {
    const r = m.role;
    const c = m.content;
    const text = typeof m === 'string' ? m : typeof c === 'string' ? c : '';
    return r === 'compactionSummary' || text.includes('Context Summary');
  });
  const hasTaskState = messages.some(m => {
    const r = m.role;
    const c = m.content;
    const text = typeof m === 'string' ? m : typeof c === 'string' ? c : '';
    return r === 'taskState' || text.includes('originalRequest');
  });
  const hasCheckpoint = messages.some(m => {
    const c = m.content;
    const text = typeof m === 'string' ? m : typeof c === 'string' ? c : '';
    return text.includes('Session Checkpoint');
  });
  const hasHandoff = messages.some(m => {
    const c = m.content;
    const text = typeof m === 'string' ? m : typeof c === 'string' ? c : '';
    return text.includes('Session Handoff');
  });

  if (hasCompaction) markers.push('L2-Summary');
  if (hasTaskState) markers.push('L3-TaskState');
  if (hasCheckpoint) markers.push('L4-Checkpoint');
  if (hasHandoff) markers.push('L5-Handoff');
  return markers;
}

main().catch((err) => {
  console.error('运行失败:', err);
  process.exit(1);
});
