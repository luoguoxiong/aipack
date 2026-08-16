/**
 * aipack-compression 演示
 *
 * 用 mock 的 streamFn 模拟 fork agent，演示 L1（裁剪）+ L2（摘要）链路。
 *
 * 运行：pnpm example
 */

import {
  createCompressionTransformer,
  loadCompressionConfig,
  ConsoleTelemetryReporter,
} from '../index';
import type { ContextResource, Model, StreamFn, StreamResult } from '@aipack-ai/agent';

// ─── Mock 模型 ────────────────────────────────────────────────────

const model: Model = {
  id: 'demo-model',
  name: 'Demo Model',
  provider: 'demo',
  contextWindow: 1000, // 故意设小，便于触发压缩
  maxTokens: 2048,
  reasoning: false,
};

// ─── Mock streamFn：返回固定摘要文本 ──────────────────────────────

const mockStreamFn: StreamFn = async function* (_m, _ctx, _opts): StreamResult {
  const summary = '## Context Summary\nDemo task: user requested X.\n\n## Key Decisions\n- Use approach Y';
  yield { type: 'text_delta', delta: summary };
};

// ─── 构造测试资源 ─────────────────────────────────────────────────

function makeResource(
  id: string,
  type: ContextResource['type'],
  content: unknown,
  deps: string[] = [],
  pinned = false,
): ContextResource {
  return {
    id,
    type,
    role: type === 'assistant_message' ? 'assistant'
      : type === 'user_message' ? 'user'
      : type === 'tool_result' ? 'toolResult'
      : 'system',
    content,
    timestamp: Date.now() + Math.random(),
    dependencies: deps,
    meta: {},
    pinned,
  };
}

async function main(): Promise<void> {
  const config = loadCompressionConfig({
    telemetry: { enabled: true, logTokenDelta: true, logTriggerReason: true },
  });

  const reporter = new ConsoleTelemetryReporter({
    logTokenDelta: config.telemetry.logTokenDelta,
    logTriggerReason: config.telemetry.logTriggerReason,
  });

  const transformer = createCompressionTransformer({
    config,
    model,
    streamFn: mockStreamFn,
    contextWindow: model.contextWindow,
    telemetryReporter: reporter,
  });

  // 构造一段超长 tool_result 触发 L1
  const longOutput = Array.from({ length: 200 }, (_, i) => `line ${i}: data`).join('\n');
  const resources: ContextResource[] = [
    makeResource('sys1', 'system_message', 'You are a helpful assistant.'),
    makeResource('u1', 'user_message', 'Please run the analysis.'),
    makeResource('a1', 'assistant_message', 'Calling tool.', ['call_1']),
    makeResource('tr1', 'tool_result', longOutput, ['call_1']),
    makeResource('a2', 'assistant_message', 'Done.'),
  ];

  const transformed = await transformer.transform(resources, {
    graph: {} as any,
    runtime: { sessionKey: 'demo', turn: 1 },
  });

  console.log('\n=== Result ===');
  console.log(`Before: ${resources.length} resources`);
  console.log(`After:  ${transformed.length} resources`);
  for (const r of transformed) {
    const text = typeof r.content === 'string'
      ? r.content
      : JSON.stringify(r.content).slice(0, 80);
    console.log(`  [${r.type}${r.pinned ? '*' : ''}] ${text.slice(0, 60)}...`);
  }
}

main().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});
