/**
 * apps/ai_teaching_agent_team/netlify/functions/teach.ts
 *
 * Netlify Function:POST /api/teach → SSE 流式生成课程(4-Agent 顺序接力)。
 * 与本地 server.ts 的 POST /api/teach 行为一致,供前端 streamTeach() 消费。
 *
 * 与本地实现的差异(serverless 适配):
 *   - 用 ReadableStream 返回 SSE,而非 http.ServerResponse 逐字节写
 *   - 客户端断开通过 req.signal 感知(而非 req 'close' 事件)
 *   - 模块级缓存 Runtime 注册表:热实例(同一 Lambda 容器)内复用 4-Runtime 团队
 *   - 受 Netlify 函数执行时长上限约束(约 60s),长主题生成可能被平台截断;
 *     前端会收到流中断,可换更小主题重试
 */
import { loadConfig, resolveModelChoice } from '../../dist/config.js';
import { createRuntimeRegistry, generateCourse } from '../../dist/runtime.js';
import type { CourseProgress } from '../../dist/runtime.js';

// 模块级注册表:热实例内按 (provider, modelId, keyHash) 缓存 4-Runtime 团队
const registry = createRuntimeRegistry(loadConfig().serpapiKey);

export default async function handler(req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => null)) as
      | { topic?: string; model?: { provider?: string; modelId?: string }; apiKey?: string }
      | null;
    if (!body || typeof body.topic !== 'string' || !body.topic.trim()) {
      return json(400, '缺少 topic 参数');
    }
    const topic = body.topic.trim();

    // 校验并解析模型选择(缺省回退默认模型);未配置 Key 或未知模型 → 400
    const config = loadConfig();
    const { choice, error: modelError } = resolveModelChoice(
      body.model,
      { provider: config.provider, modelId: config.modelId },
      body.apiKey,
    );
    if (modelError) {
      return json(400, modelError);
    }
    let team;
    try {
      team = registry.get(choice.provider, choice.modelId, choice.apiKey);
    } catch (e) {
      return json(400, (e as Error).message);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            // 客户端已断开,忽略后续推送
          }
        };

        const onProgress = (p: CourseProgress) => {
          if (p.type === 'delta') {
            send('delta', { agent: p.agent, delta: p.delta });
          } else if (p.type === 'done') {
            send('done', { course: p.course });
          } else if (p.type === 'error') {
            send('error', { message: p.message });
          } else {
            // *_start / *_done 阶段事件
            send('stage', { stage: p.type, section: p.section });
          }
        };

        try {
          await generateCourse({ topic, modelKey: choice.modelKey }, team, onProgress, req.signal);
        } catch (err) {
          const msg = (err as Error).message === 'aborted' ? '客户端已断开' : (err as Error).message;
          if (msg !== '客户端已断开') {
            send('error', { message: msg });
            console.error('[/api/teach] 失败:', err);
          }
        } finally {
          try {
            controller.close();
          } catch {
            // 流已关闭
          }
        }
      },
      cancel() {
        // 客户端断开:generateCourse 通过 req.signal 感知并中止
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    console.error('[netlify teach] 未捕获错误:', err);
    return json(500, `Internal Server Error: ${(err as Error).message}`);
  }
}

function json(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
