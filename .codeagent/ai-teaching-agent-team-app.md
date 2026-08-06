# AI 教学代理团队应用(ai_teaching_agent_team)

## 任务
在 `apps/ai_teaching_agent_team` 下基于 agentpack 实现「AI 教学代理团队」Web 应用,
功能参考 `awesome-llm-apps/advanced_ai_agents/multi_agent_apps/agent_teams/ai_teaching_agent_team`,
架构对齐已有的 `apps/ai_travel_agent`,**前端用 React**(仓库首个 React 前端 app)。

## 关键决策
- 4-Agent 顺序接力流水线(非参考版 4 路并行独立):Professor 先建知识库 → 喂给 Advisor/Librarian/TA(TA 还吃路线图)
- 全 4 Agent SSE 流式(对齐 travel 只流式最后 Planner 的增强):ResultChunk.type 区分 text/tool_start/tool_end/error/done
- 搜索工具四层降级(复用 travel search.ts 模式):SerpAPI → Bing(cn.bing.com) → DuckDuckGo → 内置教育兜底
- 导出:客户端 Blob 下载 Markdown(done 事件携带完整 course,无服务端导出端点)
- 模型选择 + API Key 逐字复用 travel config.ts 模式;Key 前端输入(localStorage teaching_agent_apikey_<provider>)或服务器 .env
- RuntimeRegistry 按 (provider, modelId, apiKey哈希) 缓存 4-Runtime 团队;sessionKey 编入模型 tag 隔离历史
- 前端 Vite + React + TS:dev 双进程(tsx watch 3001 + vite 5173 代理 /api);生产 vite build → dist/frontend 由后端静态托管 + SPA fallback
- 会话按 agent:topic:model 持久化 .agentpack/teaching-sessions/(30 天)

## 改动文件(全部新增)
- `apps/ai_teaching_agent_team/package.json` — workspace 包(agentpack + react + vite devDeps + concurrently)
- `apps/ai_teaching_agent_team/tsconfig.json` — 后端(rootDir src, outDir dist, exclude frontend)
- `apps/ai_teaching_agent_team/vite.config.ts` — root frontend/, outDir ../dist/frontend, proxy /api→3001
- `apps/ai_teaching_agent_team/.env.example` — PORT=3001 + LLM_PROVIDER/LLM_MODEL + 各 provider Key + SERPAPI_KEY
- `apps/ai_teaching_agent_team/README.md` — 架构图 + 4 Agent 表 + 双态启动 + API + 差异对比
- `apps/ai_teaching_agent_team/src/loadEnv.ts` — 复制自 travel(逐字)
- `apps/ai_teaching_agent_team/src/config.ts` — 复用 travel 的 buildModel/resolveModelChoice/ModelOption(serpapiKey,无 firecrawl)
- `apps/ai_teaching_agent_team/src/tools/search.ts` — search_web 四层降级(SerpAPI→Bing→DDG→教育兜底)
- `apps/ai_teaching_agent_team/src/runtime.ts` — 4 Runtime 工厂 + RuntimeTeam + Registry + generateCourse
- `apps/ai_teaching_agent_team/src/markdown.ts` — 零依赖 Markdown 课程拼装(标题页+目录+4 章节)
- `apps/ai_teaching_agent_team/src/server.ts` — 原生 http + SSE(/api/teach) + /api/config + 静态托管 dist/frontend(SPA fallback)
- `apps/ai_teaching_agent_team/frontend/{index.html,tsconfig.json,vite-env.d.ts}` — Vite React 前端
- `apps/ai_teaching_agent_team/frontend/src/{main.tsx,App.tsx,api.ts,agents.ts,styles.css}` — React 主逻辑
- `apps/ai_teaching_agent_team/frontend/src/components/{ConfigBar,StageProgress,SectionPanel}.tsx`
- `agentpack/README.md` — apps/ 列表追加第三条(1 行)

## 复用的 agentpack 能力
- createRuntime / createRequest / createFileSessionStorage / Runtime / Model / StreamFn
- getBuiltinModel / getBuiltinModels / hasProviderConfigured / BUILTIN_PROVIDERS / adaptAiModel / createStreamFnFromAi
- Runtime.stream() 的 ResultChunk(type=text/tool_start/tool_end/error/done,已核实 core/result.ts:111)
- Tool 接口(core/types.ts:123,execute(toolCallId,args,signal)→{content,details})
- 模式参考:apps/ai_travel_agent 的 config/runtime/server/tools/search/loadEnv

## 验证
- `pnpm install --no-frozen-lockfile`(新增 11 依赖需更新 lockfile)
- `pnpm --filter ai-teaching-agent-team typecheck` 零错误(后端)
- `pnpm --filter ai-teaching-agent-team typecheck:web` 零错误(前端;修过 api.ts SSE data 的 3 处 unknown 断言)
- `pnpm --filter ai-teaching-agent-team build` 成功:vite 36 模块 → dist/frontend;tsc → dist/server.js
- 待:GET /api/config 返回 models+llmReady+searchBackend+defaultModel
- 待:POST /api/teach(无 LLM Key)→ SSE error 事件;有 Key → 4 阶段流式 + done 携带完整 Markdown

## 踩坑与修复
- pnpm install 报 ERR_PNPM_OUTDATED_LOCKFILE(frozen-lockfile)→ `pnpm install --no-frozen-lockfile` 更新 lockfile(11 个新增依赖)
- 前端 typecheck 报 api.ts 3 处 TS2345:SSE data 是 Record<string,unknown>,需 typeof 收窄后再传回调
- tsconfig "找不到任何输入" 诊断:src 无文件时的误报,写入文件后消除
- runtime.ts "未终止的模板字面量" 诊断:markdown.js 模块缺失 + 缺 @types/node 的级联误报,非真实语法错误

## 待用户侧验证(需真实 API Key)
- DeepSeek 完整跑通 4-Agent 流水线 + Markdown 下载
- 真实搜索(Bing/DDG)对学习主题的资源质量
- 切换 OpenAI/Anthropic 等 provider 的 Key 透传
- 生产构建 serve 单端口验证(静态 + /api)

## 日期
2026-08-06
