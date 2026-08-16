/**
 * apps/ai_rag_database_routing/src/routing.ts
 *
 * 查询编排(三级路由 + RAG/网页流式回答),对应原版的三阶段设计:
 *   1. 向量相似度路由:搜索三个数据库,比较平均相关分,达到阈值即采用
 *   2. LLM 路由:相似度不足时,由 Router Agent 判定 products/support/finance
 *   3. 网页搜索兜底:仍无合适数据库时,用搜索工具获取网络结果后回答
 *
 * 回答阶段:命中数据库 → 取 top-4 片段作为上下文流式生成(SSE);
 *          网页兜底 → 用搜索结果作为上下文流式生成。
 */
import { createRequest, type Runtime } from '@aipack-ai/agent';
import type { CollectionId } from './vectordb.js';
import { VectorStore, isCollectionId, COLLECTIONS } from './vectordb.js';
import { searchWeb } from './search.js';
import type { RuntimePair } from './runtime.js';

export type RoutingMethod = 'vector' | 'llm' | 'none';

export type QueryEvent =
  | { type: 'routing_start' }
  | {
      type: 'routing_done';
      method: RoutingMethod;
      collection?: CollectionId;
      confidence?: number;
      note?: string;
    }
  | { type: 'answer_start'; source: 'database' | 'web'; collection?: CollectionId }
  | { type: 'answer_delta'; delta: string }
  | { type: 'done'; answer: string }
  | { type: 'error'; message: string };

export interface QueryContext {
  store: VectorStore;
  runtimes: RuntimePair;
  serpapiKey?: string;
  routingThreshold: number;
}

export interface QueryInput {
  question: string;
}

/**
 * 执行完整查询链路:路由 → 检索 → 流式回答。
 * 通过 onEvent 回调把阶段事件推送给 SSE;signal 用于客户端断开时中止。
 */
export async function answerQuestion(
  input: QueryInput,
  ctx: QueryContext,
  onEvent: (e: QueryEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const question = input.question.trim();
  if (!question) throw new Error('问题不能为空');

  // ── 阶段 1:向量相似度路由 ─────────────────────────────────────
  onEvent({ type: 'routing_start' });
  const vectorRoute = ctx.store.routeBySimilarity(question, ctx.routingThreshold);

  let method: RoutingMethod;
  let collection: CollectionId | undefined;
  let confidence: number | undefined;

  if (vectorRoute) {
    method = 'vector';
    collection = vectorRoute.collection;
    confidence = vectorRoute.score;
    onEvent({ type: 'routing_done', method, collection, confidence });
  } else {
    // ── 阶段 2:LLM 路由 ─────────────────────────────────────────
    const llmRoute = await routeByLlm(ctx.runtimes.router, question, signal);
    if (llmRoute) {
      method = 'llm';
      collection = llmRoute;
      onEvent({ type: 'routing_done', method, collection });
    } else {
      method = 'none';
      onEvent({ type: 'routing_done', method, note: '未找到合适数据库,将使用网页搜索兜底' });
    }
  }

  if (signal?.aborted) throw new Error('aborted');

  // ── 回答阶段 ──────────────────────────────────────────────────
  let answer: string;
  if (collection) {
    const hits = ctx.store.search(collection, question, 4);
    if (hits.length === 0) {
      // 兜底:集合为空或检索不到 → 走网页搜索
      onEvent({ type: 'routing_done', method, note: '所选数据库无可检索内容,使用网页搜索兜底' });
      answer = await answerFromWeb(input, ctx, onEvent, signal);
    } else {
      onEvent({ type: 'answer_start', source: 'database', collection });
      answer = await streamAnswer(ctx.runtimes.answer, question, hits.map((h) => h.text), onEvent, signal);
    }
  } else {
    answer = await answerFromWeb(input, ctx, onEvent, signal);
  }

  onEvent({ type: 'done', answer });
}

/** 网页搜索兜底:获取搜索结果后,基于结果流式回答,返回完整答案 */
async function answerFromWeb(
  input: QueryInput,
  ctx: QueryContext,
  onEvent: (e: QueryEvent) => void,
  signal?: AbortSignal,
): Promise<string> {
  onEvent({ type: 'answer_start', source: 'web' });
  const { text } = await searchWeb(input.question, { serpapiKey: ctx.serpapiKey, limit: 5 });
  if (signal?.aborted) throw new Error('aborted');
  return streamAnswer(ctx.runtimes.answer, input.question, [text], onEvent, signal);
}

/** LLM 路由:Router Runtime 单轮判定,解析为合法集合 id,失败返回 null */
async function routeByLlm(
  router: Runtime,
  question: string,
  signal?: AbortSignal,
): Promise<CollectionId | null> {
  // ephemeral 不落盘，避免轮询会话累积
  const req = createRequest(question, { ephemeral: true });
  const result = await router.run(req);
  if (signal?.aborted) throw new Error('aborted');
  if (!result.success) {
    throw new Error(result.error || 'LLM 路由失败');
  }
  const raw = result.content.trim().toLowerCase().replace(/[`'"。.]/g, '');
  return isCollectionId(raw) ? raw : null;
}

/** 流式生成回答:把上下文 + 问题交给 Answer Runtime,增量推送 */
async function streamAnswer(
  answer: Runtime,
  question: string,
  contextTexts: string[],
  onEvent: (e: QueryEvent) => void,
  signal?: AbortSignal,
): Promise<string> {
  const context = [
    `用户问题: ${question}`,
    '',
    '提供的上下文:',
    ...contextTexts.map((t, i) => `--- 片段 ${i + 1} ---\n${t}`),
    '',
    '请基于以上上下文回答用户问题。',
  ].join('\n');

  const req = createRequest(context, { ephemeral: true });
  let answerText = '';
  for await (const chunk of answer.stream(req)) {
    if (signal?.aborted) throw new Error('aborted');
    if (chunk.type === 'text' && chunk.content) {
      answerText += chunk.content;
      onEvent({ type: 'answer_delta', delta: chunk.content });
    }
    if (chunk.type === 'error') {
      throw new Error(chunk.content || '生成回答时出错');
    }
  }
  if (!answerText) throw new Error('模型未返回任何内容');
  return answerText;
}

/** 供前端展示路由结果的集合名 */
export function collectionLabel(id: CollectionId): string {
  return COLLECTIONS[id].name;
}
