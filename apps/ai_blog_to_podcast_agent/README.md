# 🎙️ AI Blog to Podcast Agent

基于 [agentpack](../../packages/agentpack) 的博客转播客 Web 应用,用 TypeScript + 原生 http 重写,零运行时框架依赖。

## 特性

- **单 Agent 编排**:Summarizer Runtime(带抓取工具)用 `stream()` 一把梭,通过 `ResultChunk.type` 区分抓取/摘要阶段
- **抓取三层降级**(符合多层容错偏好):Firecrawl v2 `/scrape` → 原生 fetch + HTML 正文提取 → 兜底(让 LLM 基于已知处理)
- **Edge TTS 免费语音合成**:微软神经语音,无需 API Key,WebSocket 直连 `speech.platform.bing.com`;连接失败重试 1 次,30s 超时;DRM token 基于 SHA256 动态生成(每 5 分钟轮换)
- **流式摘要**:Summarizer 通过 SSE 实时推送摘要增量,前端逐字渲染
- **多 LLM 提供商**:默认 DeepSeek,可切换 OpenAI / Anthropic / Google / Groq 等;API Key 可前端输入(localStorage 持久化)或服务器配置
- **会话持久化**:基于 agentpack `FileSessionStorage`,同一 URL 历史可恢复
- **极简依赖**:仅 `agentpack`(workspace)+ `ws`(Edge TTS WebSocket)+ devDeps(`tsx`/`typescript`/`@types/node`/`@types/ws`)

## 架构

```
用户输入(博客 URL + LLM Key)
        │
        ▼
┌──────────────────┐   scrape_blog 工具   ┌─────────────────────┐
│ Summarizer       │ ────────────────────▶│ Firecrawl / fetch / │
│ Runtime          │ ◀── 博客正文 ─────────│ 兜底                │
│ (stream)         │                      └─────────────────────┘
└──────────────────┘
        │ SSE 流式摘要(summary_delta *)
        ▼
   前端逐字渲染摘要
        │ done 后 POST /api/tts
        ▼
┌──────────────────┐   Edge TTS WebSocket ┌─────────────────────┐
│ /api/tts         │ ────────────────────▶│ speech.platform.    │
│ (服务器代理)     │ ◀── mp3 Buffer ──────│ bing.com(免费)     │
└──────────────────┘                      └─────────────────────┘
        │ audio/mpeg
        ▼
   前端 <audio> 播放 + 下载
```

## 快速开始

### 1. 安装依赖

在仓库根目录(`agentpack/`)执行:

```bash
pnpm install
```

### 2. 配置环境变量

```bash
cd apps/ai_blog_to_podcast_agent
cp .env.example .env
# 编辑 .env,至少配置一个 LLM API Key
```

| 变量                | 说明                                       | 默认       |
| ------------------- | ------------------------------------------ | ---------- |
| `LLM_PROVIDER`      | LLM 提供商                                 | `deepseek` |
| `LLM_MODEL`         | 模型 id(留空按 provider 取默认)            | —          |
| `DEEPSEEK_API_KEY`  | DeepSeek Key                               | —          |
| `OPENAI_API_KEY`    | OpenAI Key                                 | —          |
| `ANTHROPIC_API_KEY` | Anthropic Key                              | —          |
| `GEMINI_API_KEY`    | Google Gemini Key                          | —          |
| `GROQ_API_KEY`      | Groq Key                                   | —          |
| `FIRECRAWL_API_KEY` | Firecrawl Key(可选,不配则走免费原生 fetch) | —          |
| `PORT`              | Web 服务端口                               | `3000`     |

> TTS 使用 Edge TTS(微软神经语音),**免费且无需 API Key**,服务器直连 WebSocket 合成,前端可选语音与语速。
> LLM API Key 可在 `.env` 配置(供所有用户共用),也可由前端用户输入(localStorage 持久化,服务器不存储)。
> 完整 provider 与 envVar 对照见 [`packages/agentpack/ai/catalog.ts`](../../packages/agentpack/ai/catalog.ts) 的 `BUILTIN_PROVIDERS`。

### 3. 启动

```bash
# 开发(热重载)
pnpm --filter ai-blog-to-podcast-agent dev

# 或带 Key
DEEPSEEK_API_KEY=sk-xxx pnpm --filter ai-blog-to-podcast-agent dev

# 生产构建
pnpm --filter ai-blog-to-podcast-agent build
pnpm --filter ai-blog-to-podcast-agent serve
```

打开浏览器访问 `http://localhost:3000`,输入博客 URL(可选语音与语速),点击「生成播客」。

## 工作原理

### 单 Agent 编排

与 [ai_travel_agent](../ai_travel_agent) 的双 Agent 设计不同,本应用用单个 Summarizer Runtime 一把梭:

- **Summarizer Runtime**([src/runtime.ts](src/runtime.ts)):系统提示词要求调用 `scrape_blog` 工具抓取博客并生成 ≤2000 字符对话式摘要;带会话持久化,`maxTurns=10`
- 用 `runtime.stream()` 流式输出,通过 `ResultChunk.type` 区分阶段:`tool_start`/`tool_end`(抓取)与 `text`(摘要增量)

`generatePodcast()` 编排单阶段:遍历 `stream()` 的 chunk,映射为 `onProgress` 回调推送给 SSE。

### 抓取工具三层降级([src/tools/scrape.ts](src/tools/scrape.ts))

1. `FIRECRAWL_API_KEY` 存在 → Firecrawl v2 `/scrape`(Bearer 鉴权,返回 markdown 正文)
2. 否则 → 原生 fetch + HTML 正文提取(剥离 script/style/nav,取 main/article,正则提取 p/h/li 文本)
3. 都失败 → 兜底(返回 URL + 提示,让 LLM 基于已知处理)

每层 `try/catch`,Firecrawl 20s 超时、fetch 8s 超时 + 1 次重试,4xx 不重试。

### TTS:Edge TTS 免费语音合成([src/tts.ts](src/tts.ts))

使用微软 Edge 浏览器「大声朗读」后端(`speech.platform.bing.com`),**免费、无需 API Key**,协议移植自 [rany2/edge-tts](https://github.com/rany2/edge-tts)(Python)的 DRM + SSML + 二进制帧解析:

- **DRM token**:基于 SHA256 动态生成 `Sec-MS-GEC`(当前 unix 秒转 Windows 文件时间,向下取整到 5 分钟,拼接 `TRUSTED_TOKEN` 后哈希,每 5 分钟轮换)
- **WebSocket 通信**:连接后发送 `speech.config`(JSON)与 `ssml`(SSML)两条消息;响应文本消息 `Path:turn.end` 表示合成结束
- **二进制帧解析**:前 2 字节大端 = header 长度,提取 header 后剩余字节即 mp3 数据;仅收集 `Content-Type:audio/mpeg` / `Path:audio` 帧
- **多层容错**:连接失败重试 1 次;30s 超时;文本为空/语音无效等业务错误不重试
- **精选语音**:14 个语音(中文普通话/方言/粤语/台湾、英文、多语言、日文、韩文),前端按语言分组下拉

输出格式 `audio-24khz-48kbitrate-mono-mp3`。

## API

| 方法   | 路径           | 说明                                                        |
| ------ | -------------- | ----------------------------------------------------------- |
| `GET`  | `/`            | 单页 UI                                                     |
| `GET`  | `/api/config`  | 当前模型、抓取后端、TTS 后端、语音列表与模型目录            |
| `POST` | `/api/podcast` | SSE 流式生成摘要;body `{ url, model?, apiKey? }`            |
| `POST` | `/api/tts`     | 生成 mp3 下载(Edge TTS 免费);body `{ text, voice?, rate? }` |

### SSE 事件序列(`/api/podcast`)

```
event: stage    data: {"stage":"scrape_start"}
event: stage    data: {"stage":"scrape_done"}
event: stage    data: {"stage":"summary_start"}
event: delta    data: {"delta":"...摘要增量..."}
event: done     data: {"summary":"...完整摘要..."}
event: error    data: {"message":"..."}   # 出错时
```

## 开发

```bash
# 类型检查
pnpm --filter ai-blog-to-podcast-agent typecheck

# 目录结构
# src/
#   config.ts        环境变量与模型装配
#   runtime.ts       Summarizer Runtime 构建与编排
#   server.ts        原生 http + SSE + 二进制 TTS
#   tts.ts           Edge TTS 调用(DRM token + WebSocket + 帧解析)
#   tools/scrape.ts  抓取工具(三层降级)
# public/
#   index.html / app.js / style.css   单页前端
```

## License

MIT
