# 博客转播客应用(ai_blog_to_podcast_agent)

## 任务
在 `apps/ai_blog_to_podcast_agent` 下基于 agentpack 实现「博客转播客」Web 应用,
功能参考 `awesome-llm-apps/starter_ai_agents/ai_blog_to_podcast_agent`,
架构对齐已有的 `apps/ai_travel_agent`。

## 关键决策
- 单 Agent(而非 travel 的双 Agent):Summarizer Runtime 同时抓取并生成摘要,用 stream() 一把梭,通过 ResultChunk.type 区分阶段
- 抓取工具三层降级:Firecrawl v2 /scrape → 原生 fetch + HTML 正文提取 → 兜底
- TTS 模型三层降级:eleven_multilingual_v2 → eleven_turbo_v2 → eleven_v2
- ElevenLabs Key 由前端输入(localStorage 持久化),服务器不存储(隐私 + 无状态)
- 接口分离:摘要走 SSE 流式 /api/podcast(音频不适合 SSE);mp3 走独立二进制接口 /api/tts
- SSE 事件序列:scrape_start → scrape_done → summary_start → summary_delta* → done

## 改动文件(全部新增)
- `apps/ai_blog_to_podcast_agent/package.json` — workspace 包
- `apps/ai_blog_to_podcast_agent/tsconfig.json` — 对齐 travel
- `apps/ai_blog_to_podcast_agent/.env.example` — LLM Key + FIRECRAWL_API_KEY + PORT
- `apps/ai_blog_to_podcast_agent/README.md` — 架构图 + API + 差异对比
- `apps/ai_blog_to_podcast_agent/src/loadEnv.ts` — 复制自 travel(逐字)
- `apps/ai_blog_to_podcast_agent/src/config.ts` — firecrawlKey + scrapeBackend(复用 travel 的 buildModel/resolveModelChoice)
- `apps/ai_blog_to_podcast_agent/src/tools/scrape.ts` — scrape_blog 工具(三层降级)
- `apps/ai_blog_to_podcast_agent/src/runtime.ts` — Summarizer Runtime + Registry + generatePodcast
- `apps/ai_blog_to_podcast_agent/src/tts.ts` — ElevenLabs 调用(模型降级 + 重试)
- `apps/ai_blog_to_podcast_agent/src/server.ts` — 原生 http + SSE + 二进制 TTS
- `apps/ai_blog_to_podcast_agent/public/index.html` / `app.js` / `style.css` — 单页前端

## 复用的 agentpack 能力
- createRuntime / createRequest / createFileSessionStorage
- getBuiltinModel / getBuiltinModels / hasProviderConfigured / BUILTIN_PROVIDERS / adaptAiModel / createStreamFnFromAi
- Runtime.stream() 的 ResultChunk(type=text/tool_start/tool_end/error/done,已核实 core/result.ts:111)
- 模式参考:apps/ai_travel_agent 的 config/runtime/server/tools/search/loadEnv

## 验证
- `pnpm --filter ai-blog-to-podcast-agent typecheck` 零错误
- `GET /api/config` 返回 scrapeBackend + models + llmReady + defaultModel
- `POST /api/podcast`(无 LLM Key)→ SSE error 事件(清晰提示配置 Key)
- `POST /api/tts`(无 elevenlabsKey)→ 400
- 抓取降级:无 FIRECRAWL_API_KEY 时 scrapeBackend="fetch+fallback"

## 待用户侧验证(需真实 API Key)
- DeepSeek + Firecrawl + ElevenLabs 完整跑通:抓取真实博客 → 摘要流式 → mp3 播放
- Firecrawl 失效时原生 fetch 抓取质量
- TTS 模型降级(multilingual_v2 不可用时降到 turbo_v2)

## 日期
2026-08-06

---

## 迭代:TTS 从 ElevenLabs 迁移到 Edge TTS(免费·无需 Key)

### 背景
用户要求免费语音合成方案。ElevenLabs 需付费 API Key,不适合开箱即用。

### 关键决策
- 选 Edge TTS(微软神经语音)替代 ElevenLabs:免费、无需 API Key、音质好、支持下载
- 协议移植自 rany2/edge-tts(Python):WSS + DRM token + SSML + 二进制帧解析
- 多层容错:连接失败重试 1 次;30s 超时;DRM token 基于 SHA256 动态生成(每 5 分钟轮换)
- 前端移除 ElevenLabs Key 输入框,改为语音下拉(按语言分组,14 个精选语音)+ 语速选择

### 协议要点(实测验证)
- WSS URL: `wss://speech.platform.bing.com/.../edge/v1?TrustedClientToken=...&Sec-MS-GEC=<token>&Sec-MS-GEC-Version=1-143.0.3650.75`
- Sec-MS-GEC token: SHA256((unix秒 + WIN_EPOCH, 向下取整 300, ×1e7) + TRUSTED_TOKEN).hex.upper
- 连接后发两条消息:speech.config(JSON) + ssml(SSML)
- 二进制帧:前 2 字节大端 = header 长度,然后 header 文本,然后 mp3 数据
- 文本消息 Path:turn.end 表示合成结束

### 改动文件
- `src/tts.ts`:重写为 Edge TTS(WebSocket + DRM token + 帧解析 + 14 语音列表)
- `src/server.ts`:`/api/config` 返回 voices + ttsBackend;`/api/tts` 改为 `{ text, voice, rate }`;banner 改为 "Edge TTS(免费·无需Key)"
- `public/index.html`:移除 ElevenLabs Key 输入框,新增语音下拉 + 语速下拉
- `public/app.js`:移除 elevenlabsKey/voiceId 逻辑,新增 renderVoiceSelect(按语言分组)+ 语速持久化;修复 setGenerating 残留的 elevenlabsKey/voiceId 引用(改为 voice/rate)
- `public/style.css`:适配新控件
- `package.json`:description/keywords 去掉 elevenlabs,加 edge-tts;依赖加 ws + @types/ws
- `README.md`:特性/架构图/env 说明/API 表/差异对比/目录结构 全部改为 Edge TTS

### 踩坑与修复
- 403 错误:缺动态 Sec-MS-GEC DRM token + 正确请求头 → 实现 generateSecMsGec + 完整 headers(Origin/User-Agent/Cookie)
- 音频帧解析错误:误用 `\r\n\r\n` 分隔 → 实际是前 2 字节大端 header 长度
- pnpm ERR_PNPM_UNEXPECTED_STORE:store 位置冲突 → `pnpm install --no-frozen-lockfile`
- Node v18 无全局 WebSocket:装 ws 包并 import
- app.js setGenerating 残留 elevenlabsKey/voiceId 引用(TypeError)→ 改为 voice/rate

### 验证
- `pnpm --filter ai-blog-to-podcast-agent typecheck` 零错误
- `GET /api/config` 返回 ttsBackend=edge-tts + 14 语音
- `POST /api/tts` { text, voice } → HTTP 200 + audio/mpeg + 有效 mp3(file 识别为 MPEG ADTS layer III 48kbps 24kHz),afplay 可播放
- `X-TTS-Voice` 响应头正确返回所选语音

### 待用户侧验证(需 LLM API Key)
- DeepSeek + Edge TTS 完整跑通:抓取真实博客 → 摘要流式 → mp3 播放

### 日期
2026-08-06
