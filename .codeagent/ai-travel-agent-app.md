# 任务:在 agentpack 新增 apps 目录并实现 ai_travel_agent

- **日期**: 2026-08-06
- **目标**: 在 `agentpack/` 根新增 `apps/` 目录,基于 agentpack 实现 `ai_travel_agent` Web 应用,功能参考 `awesome-llm-apps/starter_ai_agents/ai_travel_agent`
- **用户确认的关键决策**:
  - 交互形式:仅 Web(原生 http + SSE)
  - 搜索后端:SerpAPI + 免费降级(DuckDuckGo + 内置兜底)
  - 默认 LLM:DeepSeek(env 可切换)

## 变更清单

### 新增
- `apps/ai_travel_agent/package.json` — workspace 包,依赖 `agentpack: workspace:*`
- `apps/ai_travel_agent/tsconfig.json` — strict,outDir=dist,排除 public
- `apps/ai_travel_agent/.env.example` — 环境变量模板(变量名对齐 ai/catalog.ts)
- `apps/ai_travel_agent/README.md` — 完整文档(架构图、API 表、差异对比)
- `apps/ai_travel_agent/src/config.ts` — env 解析 + getBuiltinModel/adaptAiModel/createStreamFnFromAi 装配
- `apps/ai_travel_agent/src/tools/search.ts` — search_web 工具(SerpAPI→DuckDuckGo→内置兜底,带重试)
- `apps/ai_travel_agent/src/runtime.ts` — Researcher + Planner 双 Runtime 编排,Planner 流式
- `apps/ai_travel_agent/src/itinerary.ts` — 零依赖 ICS 生成(RFC 5545,折行+转义)
- `apps/ai_travel_agent/src/server.ts` — 原生 http:静态资源 + /api/config + /api/plan(SSE) + /api/ics
- `apps/ai_travel_agent/public/index.html` — 单页 UI(hero 图用 mandated text_to_image URL)
- `apps/ai_travel_agent/public/app.js` — SSE 消费、逐字渲染、ICS 下载、复制
- `apps/ai_travel_agent/public/style.css` — 暗色卡片式样式

### 修改
- `pnpm-workspace.yaml` — 新增 `apps/*`
- `README.md`(根) — 新增「应用示例(apps/)」区链接
- `pnpm-lock.yaml` — 自动更新(新增 ai-travel-agent workspace 包)

## 复用的 agentpack 能力
- `createRuntime` / `createRequest` / `createFileSessionStorage`
- `getBuiltinModel` / `adaptAiModel` / `createStreamFnFromAi` / `hasProviderConfigured` / `BUILTIN_PROVIDERS`
- 模式参考:`examples/deepseek.ts`

## 验证结果
- ✅ `pnpm install --no-frozen-lockfile`:8 个 workspace 项目链接成功
- ✅ `tsc --noEmit`:exit 0,无类型错误
- ✅ ICS 单元测试:3 天 → 3 个 VEVENT,日期正确(20260810→11→12),CRLF 换行
- ✅ 搜索降级测试:DuckDuckGo 网络失败 → 内置兜底返回 3 条(含东京专用知识)
- ✅ 服务启动:banner 正确打印模型/LLM 状态/搜索后端/端口
- ✅ `GET /` → index.html;`GET /app.js`/`/style.css` → 正确 MIME
- ✅ `GET /api/config` → `{"provider":"deepseek","model":"deepseek-chat","llmReady":false,"searchBackend":"duckduckgo+fallback"}`
- ✅ `POST /api/ics` → HTTP 200,`text/calendar`,有效 ICS
- ✅ `POST /api/plan`(无 Key)→ SSE:先 `stage:research_start`,再单个 `error` 事件(清晰提示配置 DEEPSEEK_API_KEY)

## 待用户侧验证(需真实 API Key)
- 设置 `DEEPSEEK_API_KEY=sk-xxx` 后完整跑通 Researcher→Planner,验证真实行程质量与 SSE 逐字渲染
- 设置 `SERPAPI_KEY` 验证 SerpAPI 路径
- 下载 `.ics` 导入 macOS 日历确认全天事件

## 修复的小问题
- server.ts `readJson` 返回 unknown 导致属性访问类型错误 → 显式 cast 为 typed body
- /api/plan 错误事件重复发送(planTravel + handlePlan catch 双发)→ planTravel 不再发 error,统一由 handlePlan catch 发送

## 后续修复:.env 自动加载(用户反馈「配了 Key 但 LLM 仍显示未就绪」)
- **根因**:Node.js 原生不读取 `.env` 文件,config.ts 直接读 `process.env` 拿不到 `.env` 里的值
- **修复**:新增 [src/loadEnv.ts](apps/ai_travel_agent/src/loadEnv.ts),零依赖 .env 加载器,在 config.ts 顶部最先 import(副作用执行)
- **优先级**(多层容错):真实 shell env > .env 文件 > 默认值,已存在的环境变量不被 .env 覆盖(便于 CI/生产覆盖)
- **验证**:启动日志 `[loadEnv] 已从 .env 加载 9 个环境变量`,banner 显示 `LLM 就绪: ✅ 是`
- **端到端验证**(真实 DeepSeek,deepseek-v4-flash):东京 2 天 → 3 stage + 1245 delta + 1 done 事件,行程质量良好(Day 1 浅草寺/晴空塔/用餐推荐)

## 后续修复:DuckDuckGo 一直失败(用户反馈「为什么 DuckDuckGo 都是失败的」)
- **根因**:经诊断,此网络环境**阻断了 DuckDuckGo** —— `html.duckduckgo.com`/`api.duckduckgo.com` TCP 连接超时(15s),`zh.wikipedia.org` 也被阻断;而 `cn.bing.com`/`www.bing.com`(45ms)与 DeepSeek API 均可达。属区域网络限制,非代码 bug。
- **修复**:在 [search.ts](apps/ai_travel_agent/src/tools/search.ts) 新增 **Bing** 免费搜索层,放在 DDG 之前。新降级链:**SerpAPI → Bing → DuckDuckGo → 内置兜底**。
- **附加加固**:统一 `fetchHtml` 加 8s 超时(`AbortSignal.timeout`,避免阻断层卡死 15s)+ 1 次重试 + 浏览器 User-Agent(Bing 必需);完善 HTML 实体解码(`&ensp;`/`&#0183;`/`&#NNN;`)。
- **验证**:
  - search 工具单测:`梅州 客家 必去景点` → source=`bing`,5 条真实结果(百度百科/梅州网/旅游攻略)
  - 端到端(梅州 2 天):Researcher 现用真实 Bing 结果(知乎攻略、客天下/雁南飞、客家美食),行程「梅州 2 天精华之旅:世界客都」基于真实研究生成
  - `/api/config` 显示 `searchBackend: "bing+duckduckgo+fallback"`
- **结论**:DDG 在此环境不可达已无影响 —— Bing 优先命中,DDG 仅作其他环境下的备用层
