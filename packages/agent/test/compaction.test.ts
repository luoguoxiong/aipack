/**
 * 内置摘要压缩（compaction）测试：
 * - 阈值触发摘要压缩（摘要请求 / compactionSummary 消息 / buildContext 转 user）
 * - 摘要失败降级硬截断
 * - enabled: false / 未配置保持旧行为
 * - 溢出恢复路径摘要优先
 * - compaction_summary 资源 pinned（截断转换器不删）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../runtime/index.ts';
import type {
  StreamFn,
  StreamEvent,
  Message,
  AssistantMessage,
  Model,
} from '../core/index.ts';
import { createRequest, createEmptyUsage, SESSION_VERSION } from '../core/index.ts';
import type { CompactionTelemetryInfo } from '../telemetry/index.ts';
import { messagesToResources, resourcesToMessages } from '../context-resource/index.ts';
import { TruncationTransformer } from '../transformer/index.ts';
import type { TransformContext } from '../core/index.ts';
import { createMemorySessionStorage } from '../session/index.ts';

// ─── mock 工厂 ─────────────────────────────────────────────────────

const SUMMARY_PROMPT = 'SUMMARIZE:';

/** 阈值测试模型：contextWindow = 10000 token */
function compactionTestModel(contextWindow = 10_000): Model {
  return {
    id: 'test-model',
    name: 'Test Model',
    provider: 'test',
    contextWindow,
    maxTokens: 4096,
    reasoning: false,
  };
}

function doneTextEvent(text: string): StreamEvent {
  return {
    type: 'done',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      stopReason: 'stop',
      usage: { input: 1, output: 1, total: 2 },
      timestamp: Date.now(),
    } as AssistantMessage,
  };
}

function errorEvent(message: string): StreamEvent {
  return {
    type: 'error',
    message: {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: message,
      usage: { input: 0, output: 0, total: 0 },
      timestamp: Date.now(),
    } as AssistantMessage,
  };
}

/** 大消息（800 token ≈ 3200 字符） */
function bigText(label: string): string {
  return `${label}:`.padEnd(3200, 'x');
}

interface RecordedCall {
  systemPrompt: string;
  roles: string[];
  firstContent: string;
}

/** 模型调用记录（引用共享，mock 内部持续更新） */
interface RecordState {
  calls: RecordedCall[];
  summaryCalls: number;
  normalCalls: number;
}

/**
 * 记录每次模型调用 + 按需区分摘要请求的 mock。
 * summaryText = null 表示摘要请求失败；reply 为正常对话回复。
 */
function recordingStreamFn(options: {
  summaryText?: string | null;
  reply?: string;
  firstError?: StreamEvent;
}): { streamFn: StreamFn; state: RecordState } {
  const state: RecordState = { calls: [], summaryCalls: 0, normalCalls: 0 };
  const streamFn: StreamFn = async function* (_model, context) {
    const first = context.messages[0];
    state.calls.push({
      systemPrompt: context.systemPrompt,
      roles: context.messages.map(m => m.role),
      firstContent: typeof first.content === 'string' ? first.content : '',
    });
    if (context.systemPrompt === SUMMARY_PROMPT) {
      state.summaryCalls += 1;
      if (options.summaryText === null) {
        yield errorEvent('summary failed');
        return;
      }
      yield doneTextEvent(options.summaryText ?? '这是历史摘要');
      return;
    }
    state.normalCalls += 1;
    if (state.normalCalls === 1 && options.firstError) {
      yield options.firstError;
      return;
    }
    yield doneTextEvent(options.reply ?? bigText('reply'));
  };
  return { streamFn, state };
}

/** 溢出场景专用：带存储与历史的 fixture */
async function overflowFixture(count: number) {
  const storage = createMemorySessionStorage();
  const messages: Message[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: 'user',
      content: `历史消息 ${i} `.repeat(20),
      timestamp: Date.now() - (count - i) * 1000,
    });
  }
  await storage.save('s1', {
    key: 's1',
    version: SESSION_VERSION,
    messages,
    model: null,
    usage: createEmptyUsage(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return storage;
}

// ─── 阈值触发摘要压缩 ─────────────────────────────────────────────

describe('内置摘要压缩', () => {
  it('阈值触发：历史被摘要替换，发出请求中摘要转为 user 消息', async () => {
    const compactionEvents: CompactionTelemetryInfo[] = [];
    const { streamFn, state } = recordingStreamFn({
      summaryText: '这是历史摘要',
    });

    const runtime = createRuntime({
      streamFn,
      model: compactionTestModel(),
      compaction: {
        triggerRatio: 0.6,   // 6000 token
        targetRatio: 0.3,    // 3000 token，保留最新 1500
        prompt: SUMMARY_PROMPT,
      },
      telemetry: {
        onCompaction(info) {
          compactionEvents.push(info);
        },
      },
    });

    // 4 轮 run 积累（每轮 user 800t + assistant 800t = 1600t）
    for (let i = 1; i <= 4; i++) {
      await runtime.run(createRequest(bigText(`u${i}`)));
    }
    assert.equal(state.summaryCalls, 0, '未达阈值不应压缩');

    // 第 5 轮开始时 8 条旧消息(6400t) + u5(800t) = 7200t > 6000t 触发
    const result = await runtime.run(createRequest(bigText('u5')));
    assert.equal(result.success, true);

    assert.equal(state.summaryCalls, 1, '应发起一次摘要请求');
    // 摘要请求：systemPrompt 为压缩指令，输入含被压缩消息的序列化标记
    const summaryCall = state.calls.find(c => c.systemPrompt === SUMMARY_PROMPT);
    assert.ok(summaryCall, '摘要请求应被记录');
    assert.ok(summaryCall.firstContent.includes('[用户]'), '摘要输入应为序列化消息行');

    // 会话内：被压缩段替换为单条 compactionSummary 消息
    const msgs = runtime.getMessages();
    assert.equal((msgs[0] as { role: string }).role, 'compactionSummary');
    assert.equal(msgs[0].content, '这是历史摘要');
    assert.equal(
      msgs.filter(m => (m as { role: string }).role === 'compactionSummary').length,
      1,
    );
    // 保留段（a4, u5）+ 本轮回复 a5
    assert.equal(msgs.length, 4, `压缩后消息条数: ${msgs.length}`);

    // 发往模型的消息：摘要已转为 user（provider 兼容），带标注前缀
    const lastNormalCall = state.calls[state.calls.length - 1];
    assert.equal(lastNormalCall.roles[0], 'user');
    assert.ok(lastNormalCall.firstContent.includes('压缩摘要'));
    assert.ok(lastNormalCall.firstContent.includes('这是历史摘要'));

    // 遥测
    assert.equal(compactionEvents.length, 1);
    assert.equal(compactionEvents[0].mode, 'summary');
    assert.equal(compactionEvents[0].trigger, 'threshold');
    assert.equal(compactionEvents[0].droppedMessages, 7);
    assert.ok(compactionEvents[0].tokensAfter < compactionEvents[0].tokensBefore);
    assert.equal(compactionEvents[0].summary, '这是历史摘要');
  });

  it('摘要失败：降级硬截断，不影响对话继续', async () => {
    const compactionEvents: CompactionTelemetryInfo[] = [];
    const { streamFn, state } = recordingStreamFn({
      summaryText: null, // 摘要请求失败
    });

    const runtime = createRuntime({
      streamFn,
      model: compactionTestModel(),
      compaction: {
        triggerRatio: 0.6,
        targetRatio: 0.3,
        prompt: SUMMARY_PROMPT,
      },
      telemetry: {
        onCompaction(info) {
          compactionEvents.push(info);
        },
      },
    });

    for (let i = 1; i <= 4; i++) {
      await runtime.run(createRequest(bigText(`u${i}`)));
    }
    const result = await runtime.run(createRequest(bigText('u5')));
    assert.equal(result.success, true, '摘要失败不应影响主流程');

    assert.equal(state.summaryCalls, 1, '应尝试过一次摘要');
    const msgs = runtime.getMessages();
    assert.ok(
      !msgs.some(m => (m as { role: string }).role === 'compactionSummary'),
      '失败降级不应产生摘要消息',
    );
    // 保留段（a4, u5）+ 本轮回复 a5 = 3 条
    assert.equal(msgs.length, 3);
    assert.equal(compactionEvents.length, 1);
    assert.equal(compactionEvents[0].mode, 'truncate');
    assert.equal(compactionEvents[0].trigger, 'threshold');
  });

  it('enabled: false：不压缩不截断，消息全量保留', async () => {
    const { streamFn, state } = recordingStreamFn({ summaryText: '不应出现' });

    const runtime = createRuntime({
      streamFn,
      model: compactionTestModel(),
      compaction: {
        enabled: false,
        triggerRatio: 0.6,
        targetRatio: 0.3,
        prompt: SUMMARY_PROMPT,
      },
    });

    for (let i = 1; i <= 5; i++) {
      await runtime.run(createRequest(bigText(`u${i}`)));
    }

    assert.equal(state.summaryCalls, 0);
    const msgs = runtime.getMessages();
    assert.equal(msgs.length, 10, '全部消息应保留');
  });

  it('未配置 compaction：保持旧行为（阈值路径不触发）', async () => {
    const { streamFn, state } = recordingStreamFn({ summaryText: '不应出现' });

    const runtime = createRuntime({
      streamFn,
      model: compactionTestModel(),
    });

    for (let i = 1; i <= 5; i++) {
      await runtime.run(createRequest(bigText(`u${i}`)));
    }

    assert.equal(state.summaryCalls, 0, '未配置 compaction 不应发起摘要请求');
    assert.equal(runtime.getMessages().length, 10);
  });
});

// ─── 溢出恢复路径：摘要优先 ───────────────────────────────────────

describe('溢出恢复摘要压缩', () => {
  it('显式溢出：摘要替换历史后同回合重试成功', async () => {
    const compactionEvents: CompactionTelemetryInfo[] = [];
    const { streamFn, state } = recordingStreamFn({
      summaryText: '溢出摘要',
      reply: 'recovered',
      firstError: {
        type: 'error',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: '[context-overflow] API error 400: prompt is too long',
          usage: { input: 0, output: 0, total: 0 },
          timestamp: Date.now(),
        } as AssistantMessage,
      },
    });

    const storage = await overflowFixture(20);

    const runtime = createRuntime({
      streamFn,
      model: compactionTestModel(1000),
      sessionStorage: storage,
      compaction: { prompt: SUMMARY_PROMPT },
      telemetry: {
        onCompaction(info) {
          compactionEvents.push(info);
        },
      },
    });

    const result = await runtime.run(createRequest('hi', { sessionKey: 's1' }));

    assert.equal(result.success, true);
    assert.equal(result.content, 'recovered');
    // 溢出 1 次 + 摘要 1 次 + 重试 1 次
    assert.equal(state.calls.length, 3);
    assert.equal(state.summaryCalls, 1);

    const msgs = runtime.getMessages('s1');
    const summaryMsg = msgs.find(m => (m as { role: string }).role === 'compactionSummary');
    assert.ok(summaryMsg, '溢出恢复应产生摘要消息');
    assert.equal(summaryMsg.content, '溢出摘要');
    assert.ok(
      !msgs.some(m => m.role === 'assistant' && (m as AssistantMessage).errorMessage),
      '溢出错误消息不应落库',
    );

    assert.equal(compactionEvents.length, 1);
    assert.equal(compactionEvents[0].mode, 'summary');
    assert.equal(compactionEvents[0].trigger, 'overflow');
  });
});

// ─── 资源层：compaction_summary pinned ────────────────────────────

describe('compaction_summary 资源', () => {
  const summaryMessage = {
    role: 'compactionSummary',
    content: '摘要内容',
    timestamp: Date.now(),
  } as unknown as Message;

  it('消息 → 资源：映射为 compaction_summary 且 pinned', () => {
    const [resource] = messagesToResources([summaryMessage]);
    assert.equal(resource.type, 'compaction_summary');
    assert.equal(resource.pinned, true);
  });

  it('资源 → 消息：roundtrip 保持 compactionSummary role', () => {
    const resources = messagesToResources([summaryMessage]);
    const [msg] = resourcesToMessages(resources);
    assert.equal((msg as { role: string }).role, 'compactionSummary');
    assert.equal(msg.content, '摘要内容');
  });

  it('TruncationTransformer 不移除 pinned 摘要资源', async () => {
    const transformer = new TruncationTransformer(1); // 极小上限
    const normalMessage: Message = {
      role: 'user',
      content: '普通消息',
      timestamp: Date.now(),
    };
    const resources = messagesToResources([summaryMessage, normalMessage]);
    const ctx = {} as TransformContext;
    const result = await transformer.transform(resources, ctx);
    assert.ok(
      result.some(r => r.type === 'compaction_summary'),
      'pinned 摘要资源应保留',
    );
  });
});
