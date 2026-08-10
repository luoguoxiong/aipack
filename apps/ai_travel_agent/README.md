# 🛫 AI Travel Agent

基于 [agentpack](../../packages/agentpack) 的 AI 旅行行程规划 Web 应用,用 TypeScript + 原生 http 重写,零运行时框架依赖。

## 特性

- **双 Agent 编排**:Researcher(带搜索工具)→ Planner(流式生成行程),两阶段设计
- **三层搜索降级**(符合多层容错偏好):SerpAPI → DuckDuckGo HTML → 内置旅游知识兜底
- **流式输出**:Planner 通过 SSE 实时推送行程增量,前端逐字渲染
- **多 LLM 提供商**:默认 DeepSeek,可切换 OpenAI / Anthropic / Google / Groq 等
- **ICS 日历导出**:零依赖手写 ICS,按 "Day N" 拆分为全天事件,可导入 Google/Apple/Outlook 日历
- **会话持久化**:基于 agentpack `FileSessionStorage`,同一目的地历史可恢复
- **极简依赖**:仅 `agentpack`(workspace)+ devDeps(`tsx`/`typescript`/`@types/node`)

## 架构

```
用户输入(目的地+天数)
        │
        ▼
┌──────────────────┐   search_web 工具   ┌─────────────────┐
│ Researcher       │ ──────────────────▶│ SerpAPI / DDG / │
│ Runtime          │ ◀── 搜索结果 ───────│ 内置兜底        │
└──────────────────┘                     └─────────────────┘
        │ 研究结果
        ▼
┌──────────────────┐   SSE stream
│ Planner          │ ─────────────────▶  前端逐字渲染
│ Runtime          │
└──────────────────┘
        │ 行程文本
        ▼
   generateIcs() ──▶ travel_itinerary.ics
```

## 快速开始

### 1. 安装依赖

在仓库根目录(`agentpack/`)执行:

```bash
pnpm install
```

### 2. 配置环境变量

```bash
cd apps/ai_travel_agent
cp .env.example .env
# 编辑 .env,至少配置一个 LLM API Key
```

| 变量                | 说明                               | 默认       |
| ------------------- | ---------------------------------- | ---------- |
| `LLM_PROVIDER`      | LLM 提供商                         | `deepseek` |
| `LLM_MODEL`         | 模型 id(留空按 provider 取默认)    | —          |
| `DEEPSEEK_API_KEY`  | DeepSeek Key                       | —          |
| `OPENAI_API_KEY`    | OpenAI Key                         | —          |
| `ANTHROPIC_API_KEY` | Anthropic Key                      | —          |
| `GOOGLE_API_KEY`    | Google Gemini Key                  | —          |
| `GROQ_API_KEY`      | Groq Key                           | —          |
| `SERPAPI_KEY`       | SerpAPI Key(可选,不配则走免费搜索) | —          |
| `PORT`              | Web 服务端口                       | `3000`     |

> 完整 provider 与 envVar 对照见 [`packages/agentpack/ai/catalog.ts`](../../packages/agentpack/ai/catalog.ts) 的 `BUILTIN_PROVIDERS`。

### 3. 启动

```bash
# 开发(热重载)
pnpm --filter ai-travel-agent dev

# 或带 Key
DEEPSEEK_API_KEY=sk-xxx pnpm --filter ai-travel-agent dev

# 生产构建
pnpm --filter ai-travel-agent build
pnpm --filter ai-travel-agent serve
```

打开浏览器访问 `http://localhost:3000`,输入目的地与天数,点击「生成行程」。

## 工作原理

### 双 Agent 编排

agentpack 是单 Runtime 框架,本应用用两个独立 Runtime 实例实现双 Agent 设计:

- **Researcher Runtime**([src/runtime.ts](src/runtime.ts)):系统提示词要求生成搜索词并调用 `search_web` 工具;带会话持久化,`maxTurns=20` 允许多轮搜索
- **Planner Runtime**:系统提示词要求按天生成结构化行程;`maxTurns=5`,纯生成无工具;用 `stream()` 流式输出

`planTravel()` 编排两阶段:先 `researcher.run()` 同步获取研究结果,再 `planner.stream()` 流式生成行程,通过 `onProgress` 回调推送给 SSE。

### 搜索工具三层降级([src/tools/search.ts](src/tools/search.ts))

1. `SERPAPI_KEY` 存在 → SerpAPI Google 搜索
2. 否则 → DuckDuckGo HTML 免费抓取(正则解析)
3. 都失败 → 内置旅游知识兜底(热门目的地通用建议)

每层 `try/catch`,网络失败带 1 次重试,任何一层失败不影响主流程。

### ICS 生成([src/itinerary.ts](src/itinerary.ts))

正则 `/Day\s*(\d+)\s*[:：]\s*([\s\S]*?)(?=Day\s*\d+|)/gi` 拆分天,每 Day 一个全天事件(`VALUE=DATE` 的 DTSTART/DTEND)。文本转义(逗号/分号/换行)、75 字节折行,符合 [RFC 5545](https://datatracker.ietf.org/doc/html/rfc5545)。

## API

| 方法   | 路径          | 说明                                           |
| ------ | ------------- | ---------------------------------------------- |
| `GET`  | `/`           | 单页 UI                                        |
| `GET`  | `/api/config` | 当前模型与搜索后端状态                         |
| `POST` | `/api/plan`   | SSE 流式生成行程;body `{ destination, days }`  |
| `POST` | `/api/ics`    | 生成 ICS 下载;body `{ itinerary, startDate? }` |

## 开发

```bash
# 类型检查
pnpm --filter ai-travel-agent typecheck

# 目录结构
# src/
#   config.ts        环境变量与模型装配
#   runtime.ts       双 Runtime 构建与编排
#   server.ts        原生 http + SSE + 静态资源
#   itinerary.ts    ICS 生成
#   tools/search.ts  搜索工具(三层降级)
# public/
#   index.html / app.js / style.css   单页前端
```

## License

MIT
