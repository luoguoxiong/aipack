# 📚 RAG Agent with Database Routing

基于 [agentpack](../../packages/agentpack) 移植的 **RAG 数据库路由** Web 应用,原版来自 [awesome-llm-apps / rag_database_routing](../../../awesome-llm-apps/rag_tutorials/rag_database_routing)。用 TypeScript + 原生 http 重写,零运行时框架依赖。

## 特性

- **三个专属知识库**:产品信息 / 客户支持与 FAQ / 财务信息,文档按标签分库管理
- **三级路由**(与原版一致):
  1. **向量相似度路由** —— 同时检索三个数据库,比较平均相关分,达到阈值即采用
  2. **LLM 路由** —— 相似度不足时,由 Router Agent 判定应路由到哪个数据库
  3. **网页搜索兜底** —— 仍无合适数据库时,用网络搜索获取结果后回答
- **RAG 流式回答**:命中数据库后取 top-4 片段作为上下文,通过 SSE 逐字流式生成
- **本地向量存储**:零依赖 TF-IDF 稀疏向量 + 余弦相似度(替代 Qdrant + OpenAIEmbeddings),JSON 持久化,重启不丢数据
- **多 LLM 提供商**:默认 DeepSeek,可切换 OpenAI / Anthropic / Google / Groq 等;API Key 可在页面输入(localStorage 记忆),缺省回退服务器 `.env` 配置
- **极简依赖**:仅 `agentpack`(workspace)+ devDeps(`tsx`/`typescript`/`@types/node`)

## 架构

```
用户提问
    │
    ▼
┌─────────────────────┐
│ ① 向量相似度路由      │  ── 检索 products / support / finance 三库,比较平均分
└─────────────────────┘
    │ 未达阈值
    ▼
┌─────────────────────┐
│ ② LLM 路由(Router)  │  ── 严格输出 products / support / finance 之一
└─────────────────────┘
    │ 仍无法判定
    ▼
┌─────────────────────┐
│ ③ 网页搜索兜底        │  ── SerpAPI → Bing → DuckDuckGo → 通用知识
└─────────────────────┘
    │
    ▼
┌─────────────────────┐   SSE stream
│ Answer Runtime      │ ─────────────────▶  前端逐字渲染
│ (RAG/网页上下文回答)  │
└─────────────────────┘
```

## 快速开始

### 1. 安装依赖

在仓库根目录(`agentpack/`)执行:

```bash
pnpm install
```

### 2. 配置环境变量

```bash
cd apps/ai_rag_database_routing
cp .env.example .env
# 编辑 .env,至少配置一个 LLM API Key
```

| 变量                | 说明                                    | 默认                |
| ------------------- | --------------------------------------- | ------------------- |
| `LLM_PROVIDER`      | LLM 提供商                              | `deepseek`          |
| `LLM_MODEL`         | 模型 id(留空按 provider 取默认)         | —                   |
| `DEEPSEEK_API_KEY`  | DeepSeek Key                            | —                   |
| `OPENAI_API_KEY`    | OpenAI Key                              | —                   |
| `ROUTING_THRESHOLD` | 向量路由置信度阈值(0~1,低于则降级 LLM)  | `0.12`              |
| `VECTOR_DB_DIR`     | 向量存储持久化目录                      | `.agentpack/rag-db` |
| `SERPAPI_KEY`       | SerpAPI Key(可选,不配则走免费搜索)      | —                   |
| `PORT`              | Web 服务端口                            | `3000`              |

> 完整 provider 与 envVar 对照见 [`packages/agentpack/ai/catalog.ts`](../../packages/agentpack/ai/catalog.ts) 的 `BUILTIN_PROVIDERS`。

### 3. 启动

```bash
# 开发(热重载)
pnpm --filter ai-rag-database-routing dev

# 或带 Key
DEEPSEEK_API_KEY=sk-xxx pnpm --filter ai-rag-database-routing dev

# 生产构建
pnpm --filter ai-rag-database-routing build
pnpm --filter ai-rag-database-routing serve
```

打开浏览器访问 `http://localhost:3000`。

### 4. 使用

1. **上传文档**:在「文档库」切换数据库 Tab(产品 / 支持 / 财务),上传 `.txt` / `.md` 文件或粘贴文本,点击「上传」
2. **提问**:输入自然语言问题(如「这个产品支持哪些语言?」「退款政策是什么?」「去年营收是多少?」),系统自动路由到最相关的数据库并流式回答

## 与原版的差异

| 原版(Streamlit/Python)      | 本实现(agentpack/TS)                          |
| --------------------------- | --------------------------------------------- |
| Qdrant + OpenAIEmbeddings   | 本地 TF-IDF 稀疏向量 + 余弦相似度(零依赖)     |
| PDF 上传                    | `.txt` / `.md` 上传 + 粘贴文本                |
| agno Agent 路由             | agentpack Router Runtime(严格单轮分类)        |
| LangChain 检索链 + Streamlit| agentpack Answer Runtime + 原生 http + SSE    |
| LangGraph + DuckDuckGo 兜底 | agentpack 搜索工具链(SerpAPI→Bing→DDG→通用)  |

## 工作原理

### 三级路由([src/routing.ts](src/routing.ts))

1. **向量相似度路由**:对每个数据库用 TF-IDF 余弦相似度取 top-3 片段,计算平均分;平均分最高且 ≥ `ROUTING_THRESHOLD` 的数据库胜出
2. **LLM 路由**:相似度不足时,Router Runtime(系统提示词严格要求只输出 `products` / `support` / `finance` 之一)判定目标数据库
3. **网页搜索兜底**:仍无合适数据库(或所选库为空)时,`searchWeb()` 四层降级获取网络结果,作为上下文回答

### 本地向量存储([src/vectordb.ts](src/vectordb.ts))

- 文本按段落边界分块(块≈1000 字符,重叠 200)
- 分词:英文单词/数字 + 中文双字滑窗 + 独立单字,过滤常见停用词
- 每块构建稀疏 TF-IDF 向量并预计算 L2 范数;检索时计算查询向量与各块余弦相似度
- 变更后持久化到 `VECTOR_DB_DIR/store.json`,启动时自动加载

### 文档上传

浏览器端用 `FileReader` 读取文件文本 → `POST /api/upload`(body `{ collection, files, texts }`)→ 服务端分块、建索引、去重(相同片段跳过)、落盘。

## API

| 方法   | 路径             | 说明                                                          |
| ------ | ---------------- | ------------------------------------------------------------- |
| `GET`  | `/`              | 单页 UI                                                       |
| `GET`  | `/api/config`    | 模型状态 + 路由阈值 + 各数据库统计                            |
| `POST` | `/api/upload`    | 上传文档;body `{ collection, files: [{name,content}], texts }`|
| `POST` | `/api/clear`     | 清空数据库;body `{ collection }`                              |
| `POST` | `/api/query`     | SSE 流式回答;body `{ question, model?, apiKey? }`             |

`/api/query` 的 SSE 事件:`routing`(start/done)→ `answer_start` → `delta`* → `done`。

## 开发

```bash
# 类型检查
pnpm --filter ai-rag-database-routing typecheck

# 目录结构
# src/
#   config.ts      环境变量与模型装配
#   vectordb.ts    本地向量存储(分块/分词/TF-IDF/持久化)
#   routing.ts     三级路由 + RAG 流式回答编排
#   runtime.ts     Router / Answer Runtime 构建与注册表
#   search.ts      网页搜索(四层降级)
#   server.ts      原生 http + SSE + 静态资源
# public/
#   index.html / app.js / style.css   单页前端
```

## License

MIT
