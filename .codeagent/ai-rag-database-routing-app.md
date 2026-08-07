# RAG 数据库路由应用(ai_rag_database_routing)

## 任务
在 `apps/ai_rag_database_routing` 下基于 agentpack 实现「RAG 数据库路由」Web 应用,
原版来自 `awesome-llm-apps/rag_tutorials/rag_database_routing`,
用 TypeScript + 原生 http 重写,零运行时框架依赖。

## 关键决策
- **三级路由**(与原版一致):① 向量相似度路由(三库同时检索,比较平均相关分,≥ 阈值即采用)→ ② LLM 路由(相似度不足时 Router Agent 判定)→ ③ 网页搜索兜底
- **本地向量存储替代 Qdrant + OpenAIEmbeddings**:零依赖 TF-IDF 稀疏向量 + 余弦相似度,JSON 持久化(`VECTOR_DB_DIR`),重启不丢数据
- **分块与分词**:chunk≈1000 字符、overlap 200、段落边界切分;分词 = 英文单词/数字 + 中文双字滑窗 + 独立单字,过滤停用词
- **网页搜索四层降级**:SerpAPI → Bing(cn.bing.com) → DuckDuckGo HTML → 通用知识兜底;每层 try/catch + 8s 超时 + UA + 1 次重试(4xx 不重试)
- **双 Runtime**:Router(严格只输出 products/support/finance 之一,单轮)+ Answer(上下文流式作答),均无工具、内存会话
- **RuntimeRegistry**:按 `(provider, modelId, apiKey)` 构建并缓存;apiKey 用 sha256 前 8 位作缓存键,不明文存 key
- **多 LLM 提供商**:默认 DeepSeek,可切 OpenAI/Anthropic/Google/Groq 等;API Key 前端输入(localStorage 持久化),缺省回退服务器 `.env`
- **SSE 事件序列**:routing_start → routing_done → answer_start → answer_delta* → done(路由方法/集合/置信度随 routing_done 推送)
- **文档上传**:浏览器 FileReader 读文件 → `POST /api/upload`(`{ collection, files, texts }`)→ 服务端分块、建索引、去重、落盘

## 改动文件(全部新增)
- `apps/ai_rag_database_routing/package.json` — workspace 包(仅依赖 agentpack)
- `apps/ai_rag_database_routing/tsconfig.json` — 对齐 travel
- `apps/ai_rag_database_routing/.env.example` — LLM Key + SERPAPI_KEY + ROUTING_THRESHOLD + VECTOR_DB_DIR + PORT
- `apps/ai_rag_database_routing/README.md` — 架构图 + 三级路由说明 + API 表 + 与原版差异
- `apps/ai_rag_database_routing/src/loadEnv.ts` — 复制自 travel(逐字)
- `apps/ai_rag_database_routing/src/config.ts` — env 解析 + model/streamFn 装配 + buildModel/resolveModelChoice(复用 travel 模式)
- `apps/ai_rag_database_routing/src/vectordb.ts` — 分块/分词/TF-IDF/余弦相似度/JSON 持久化/路由打分
- `apps/ai_rag_database_routing/src/routing.ts` — 三级路由编排 + RAG/网页流式回答(answerQuestion)
- `apps/ai_rag_database_routing/src/runtime.ts` — Router/Answer Runtime + createRuntimeRegistry
- `apps/ai_rag_database_routing/src/search.ts` — searchWeb 四层降级
- `apps/ai_rag_database_routing/src/server.ts` — 原生 http + SSE + 静态资源 + /api/config|upload|clear|query
- `apps/ai_rag_database_routing/public/index.html` / `app.js` / `style.css` — 单页前端(三库 Tab + 上传 + 模型选择 + 流式渲染)

## 复用的 agentpack 能力
- createRuntime / createRequest / createMemorySessionStorage
- getBuiltinModel / getBuiltinModels / hasProviderConfigured / BUILTIN_PROVIDERS / adaptAiModel / createStreamFnFromAi
- Runtime.run()(Router 单轮分类)与 Runtime.stream()(Answer 增量文本,ResultChunk.type=text/error)
- 模式参考:apps/ai_travel_agent 的 config/runtime/server/loadEnv

## 验证
- `pnpm --filter ai-rag-database-routing typecheck` 零错误

## 待用户侧验证(需真实 API Key / 网络)
- DeepSeek + SerpAPI 完整跑通:上传文档 → 提问 → 向量/LLM 路由 → SSE 流式回答
- 网页搜索降级链路在国内网络环境下 Bing / DuckDuckGo 可达性
- LLM 路由在向量相似度不足时的判定质量

## 日期
2026-08-07
