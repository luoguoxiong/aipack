/**
 * apps/ai_teaching_agent_team/netlify/functions/config.ts
 *
 * Netlify Function:GET /api/config → 当前模型/搜索后端/模型目录(JSON)。
 * 与本地 server.ts 的 GET /api/config 行为一致,供前端 fetchConfig() 使用。
 *
 * 打包方式:见 scripts/build-functions.mjs(esbuild 内联打包 agentpack 与全部依赖,
 * 输出自包含 .mjs 到 netlify/functions-dist/,避免 pnpm workspace 依赖在
 * Netlify 函数打包器(zisi)下解析失败)。路由由 netlify.toml redirects 提供。
 */
import { loadConfig } from '../../dist/config.js';

export default async function handler(): Promise<Response> {
  try {
    const config = loadConfig();
    const body = {
      provider: config.provider,
      model: config.modelId,
      llmReady: config.llmReady,
      searchBackend: config.searchBackend,
      defaultModel: { provider: config.provider, modelId: config.modelId },
      models: config.models,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  } catch (err) {
    console.error('[netlify config] 未捕获错误:', err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
}
