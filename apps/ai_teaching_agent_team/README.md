# ai_teaching_agent_team — 👨‍🏫 AI 教学代理团队

基于 [agentpack](../..) 框架构建的 **4-Agent 协作教学团队** Web 应用（React 前端）。输入一个学习主题，四位"教师"顺序接力、全部流式输出，最终产出一份完整课程文档（Markdown 可下载）。

```
主题 ─▶ ①🧠 Professor 教授     构建知识库（search_web 检索权威资料）
        │          知识库
        ▼
        ②🗺️ Academic Advisor  设计学习路线图（无工具，纯综合）
        │          路线图
        ▼
        ③📚 Research Librarian 策展学习资源（search_web）
        │          资源清单
        ▼
        ④✍️ Teaching Assistant 设计练习材料（search_web + 知识库 + 路线图）
        └──▶ 拼装完整课程 Markdown（可下载）
```

与参考实现（[awesome-llm-apps 的 ai_teaching_agent_team](https://github.com/luoguoxiong/awesome-llm-apps/tree/main/advanced_ai_agents/multi_agent_apps/agent_teams/ai_teaching_agent_team)，Streamlit + Google Docs/Composio）的差异：

| 维度     | 参考实现                     | 本实现                                                   |
| -------- | ---------------------------- | -------------------------------------------------------- |
| 团队协作 | 4 个 agent 并行独立          | **顺序接力**，后 3 位基于知识库/路线图展开               |
| 流式     | 非流式                       | **4 个 agent 全部 SSE 流式**                             |
| 文档导出 | Google Docs（Composio 付费） | **零依赖 Markdown 下载**                                 |
| 搜索     | SerpAPI                      | **四层降级**：SerpAPI → Bing → DuckDuckGo → 内置教育兜底 |
| 前端     | Streamlit                    | **Vite + React + TypeScript**                            |

## 4 位教师

| Agent                 | 角色         | 工具         | 产出                                              |
| --------------------- | ------------ | ------------ | ------------------------------------------------- |
| 🧠 Professor          | 知识库构建   | `search_web` | 第一性原理、核心术语、原理、应用，结构化 Markdown |
| 🗺️ Academic Advisor   | 学习路径设计 | 无           | 分阶段模块、目标/时间/前置知识、里程碑            |
| 📚 Research Librarian | 资源策展     | `search_web` | 博客 / GitHub / 文档 / 视频 / 课程，附描述与难度  |
| ✍️ Teaching Assistant | 练习设计     | `search_web` | 渐进练习、测验、项目、真实场景，附详细解答        |

## 快速开始

### 环境

- Node.js ≥ 18（本仓库为 pnpm workspace，需在仓库根执行）
- 至少一个 LLM provider 的 API Key（默认 DeepSeek；也支持 OpenAI / Anthropic / Google / Groq 等）

### 安装

```bash
cd agentpack
pnpm install
```

### 配置 API Key

两种方式任选（**方式一优先**，方式二为前端输入）：

1. **服务器 .env**（推荐）：复制 `.env.example` 为 `.env`，填入 Key

   ```bash
   cd apps/ai_teaching_agent_team
   cp .env.example .env
   # 编辑 .env:
   #   LLM_PROVIDER=deepseek
   #   DEEPSEEK_API_KEY=sk-xxx
   #   SERPAPI_KEY=xxx        # 可选，不填走 Bing + DDG + 内置兜底
   ```

2. **前端输入**：打开页面后在顶部输入 API Key（按 provider 保存在浏览器 localStorage `teaching_agent_apikey_<provider>`）。若某 provider 已由服务器配置，前端 Key 输入框自动禁用。

### 开发模式（双进程，HMR）

```bash
cd agentpack
pnpm --filter ai-teaching-agent-team dev
```

- 前端：http://localhost:5173 （Vite + React HMR，`/api` 代理到后端 3001）
- 后端：http://localhost:3001/api （agentpack SSE 服务，`tsx watch`）

### 生产模式（单端口）

```bash
cd agentpack
pnpm --filter ai-teaching-agent-team build   # vite build(前端) + tsc(后端)
pnpm --filter ai-teaching-agent-team serve   # node dist/server.js
```

打开 http://localhost:3001

### 部署到 Netlify（无服务器）

应用已适配为 **静态前端 + Netlify Functions** 架构：

- 前端（Vite 构建产物 `dist/frontend`）→ 静态托管
- `/api/config`、`/api/teach` → Netlify Functions（SSE 流式由 `netlify/functions/teach.ts` 实现）
- 会话存储自动切换：检测到 Lambda 环境时写入 `/tmp`（本地仍为 `.agentpack/teaching-sessions`）

发布步骤：

1. 把仓库推送到 GitHub
2. 打开 [app.netlify.com](https://app.netlify.com/) → **Add new site → Import an existing project**
3. 选择本仓库，构建配置自动读取**仓库根**的 `netlify.toml`（已预置）：
   - Build command：`pnpm --filter agentpack build && pnpm --filter ai-teaching-agent-team build && pnpm --filter ai-teaching-agent-team build:functions`
   - Publish directory：`apps/ai_teaching_agent_team/dist/frontend`
   - Functions directory：`apps/ai_teaching_agent_team/netlify/functions-dist`
4. **Site configuration → Environment variables** 添加（与 `.env` 相同，Netlify 上不能用 `.env` 文件）：
   `LLM_PROVIDER`、`DEEPSEEK_API_KEY`（及所用 provider 的 Key）、`SERPAPI_KEY`（可选）
5. **Deploy site** → 完成，访问生成的 `https://<site>.netlify.app`

> ⚠️ **时长限制**：Netlify Functions 同步执行有硬上限（约 60 秒）。4-Agent 完整生成对于较长主题可能超时被平台截断（前端流中断）。适合短主题与演示场景；需要完整长时间生成时，仍建议用本地 `serve` 或常驻 Node 平台（Render/Railway/Fly）。

本地调试 Netlify 版可安装 `@netlify/cli` 后运行 `netlify dev`（Functions 目录指向 `netlify/functions-dist`）。

## 使用

1. 选择模型（下拉按 provider 分组；未配置 Key 的 provider 需在右侧输入 Key）
2. 输入学习主题（如「Python 入门」「Transformer 原理」「快速排序」）
3. 点击「开始生成课程」→ 4 阶段依次流式输出，可实时看到每位教师的产出
4. 完成后点击「下载课程 (.md)」导出完整课程文档

## 架构

```
apps/ai_teaching_agent_team/
├── package.json             # 单包:agentpack + react/vite devDeps
├── tsconfig.json            # 后端 TS 配置(rootDir: src, outDir: dist)
├── vite.config.ts           # Vite:root frontend/, outDir ../dist/frontend, /api 代理
├── .env.example             # 环境变量模板
├── netlify/                 # ── Netlify Functions(无服务器) ──
│   └── functions/
│       ├── config.ts        # GET /api/config(打包为 config.mjs)
│       └── teach.ts         # POST /api/teach SSE 流式(打包为 teach.mjs)
├── scripts/
│   └── build-functions.mjs  # esbuild 内联打包 agentpack → netlify/functions-dist/
├── src/                     # ── 后端(agentpack) ──
│   ├── loadEnv.ts           # 零依赖 .env 加载器
│   ├── config.ts            # 模型/streamFn 装配 + 模型目录 + 选择校验
│   ├── runtime.ts           # 4 个 Runtime 工厂 + RuntimeRegistry + generateCourse 编排
│   ├── markdown.ts          # 零依赖 Markdown 课程文档拼装
│   ├── server.ts            # 原生 http + SSE(/api/teach) + /api/config + 静态托管
│   └── tools/search.ts      # search_web 四层降级(SerpAPI→Bing→DDG→教育兜底)
└── frontend/                # ── 前端(Vite + React + TS) ──
    ├── index.html
    ├── tsconfig.json
    └── src/
        ├── main.tsx         # React 入口
        ├── App.tsx          # 主状态机:配置/生成流/4 分区/下载
        ├── api.ts           # fetchConfig + streamTeach(SSE 解析)
        ├── agents.ts        # 4 agent 元数据
        ├── styles.css       # 暗色主题 + 4 分区/阶段进度样式
        └── components/
            ├── ConfigBar.tsx       # 模型下拉 + API Key + 状态条
            ├── StageProgress.tsx   # 4 阶段进度条
            └── SectionPanel.tsx    # 单 agent 流式输出面板(×4)
```

## API

| 方法 | 路径          | 说明                                                |
| ---- | ------------- | --------------------------------------------------- |
| GET  | `/api/config` | 模型目录、当前模型、LLM 就绪状态、搜索后端链        |
| POST | `/api/teach`  | SSE 流式生成课程；body `{ topic, model?, apiKey? }` |

### SSE 事件序列（`POST /api/teach`）

```
event: stage  data: {"stage":"professor_start"}
event: delta  data: {"agent":"professor","delta":"..."}
event: stage  data: {"stage":"professor_done","section":"..."}
event: delta  data: {"agent":"advisor","delta":"..."}      # ...依次类推
event: stage  data: {"stage":"ta_done","section":"..."}
event: done   data: {"course":"# 完整课程 Markdown..."}
event: error  data: {"message":"..."}                      # 出错时
```

### 多 Agent 协作与会话

- 4 个 agent 各为独立 `Runtime`，由 [runtime.ts](src/runtime.ts) 中的 `generateCourse` 顺序编排，前一阶段产出作为后一阶段输入（TA 同时接收知识库 + 路线图）。
- 会话按 `agent:topic:model` 持久化到 `.agentpack/teaching-sessions/`（30 天），切换模型会隔离历史。
- `createRuntimeRegistry` 按 `(provider, modelId, apiKey哈希)` 缓存 4-Runtime 团队，支持运行时切换模型、Key 变更自动重建。

## 与其他 apps 对比

| 维度     | ai_travel_agent         | ai_blog_to_podcast_agent | ai_teaching_agent_team |
| -------- | ----------------------- | ------------------------ | ---------------------- |
| Agent 数 | 2（Researcher+Planner） | 1 + 工具                 | **4（顺序接力）**      |
| 流式     | 仅 Planner              | 是                       | **4 个全部流式**       |
| 前端     | vanilla                 | vanilla                  | **React (Vite + TS)**  |
| 导出     | ICS                     | mp3                      | **Markdown**           |
| 模型选择 | 是                      | 是                       | 是                     |

## 常见问题

- **「未配置 XXX_API_KEY」**：该 provider 未在服务器 `.env` 配置，请在页面顶部输入 API Key（会保存到 localStorage）。Netlify 部署请在站点控制台 Environment variables 添加。
- **Netlify 上生成中途被截断**：Netlify Functions 同步执行约 60 秒上限，4-Agent 完整生成对长主题可能超时。换更短主题或改用常驻 Node 平台。
- **Netlify 上模型下拉显示未配置**：确认 `DEEPSEEK_API_KEY` 等已添加到 Netlify 站点 Environment variables（不是 `.env` 文件），并重新部署。
- **搜索全部降级到内置兜底**：网络受限时 Bing/DDG 可能被阻断，属预期降级；配置 `SERPAPI_KEY` 可获得最佳搜索质量。
- **开发态访问 3001 看不到页面**：前端由 Vite 5173 提供，生产态才由后端托管 `dist/frontend`。
