# agentpack

<p align="center">
  <img src="image/logo.png" alt="agentpack logo" width="200">
</p>

Agent 框架与命令行工具的 monorepo，核心调度、会话持久化、工具执行、上下文转换均自研实现，不依赖任何外部 Agent 框架。

## 包结构

| 包                                                          | 说明                                                                         |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [agentpack](packages/agentpack)                             | Agent 框架：`Runtime + Extension + Transformer`，配置入口 + 执行入口         |
| [agentpack-cli](packages/agentpack-cli)                     | 基于 agentpack 框架的命令行工具（交互式聊天、会话管理、回放等）              |
| [agentpack-coding](packages/agentpack-coding)               | coding 工具集 + coding agent 工厂 + CLI（文件读写、命令执行、代码搜索）      |
| [agentpack-memory](packages/agentpack-memory)               | 持久化记忆插件：自动捕获/注入、BM25 + 可选向量混合检索、记忆工具             |
| [agentpack-compression](packages/agentpack-compression)     | 五级上下文压缩：工具输出裁剪、消息摘要、任务状态提取、会话检查点、新会话交接 |
| [vscode-agentpack-coding](packages/vscode-agentpack-coding) | VSCode 扩展：基于 agentpack-coding 的 WebView 聊天面板                       |

## agentpack（框架）

安装：

```bash
npm install agentpack
# 或
pnpm add agentpack
```

最小示例：

```ts
import {
  createRuntime,
  createRequest,
  createFileSessionStorage,
  getBuiltinModel,
  adaptAiModel,
  createStreamFnFromAi,
} from 'agentpack';

const aiModel = getBuiltinModel('deepseek', 'deepseek-chat'); // 需配置 DEEPSEEK_API_KEY

const runtime = createRuntime({
  model: adaptAiModel(aiModel),
  streamFn: createStreamFnFromAi(aiModel),
  systemPrompt: '你是一个简洁的 AI 助手',
  sessionStorage: createFileSessionStorage({ baseDir: './sessions' }),
});

// 同步调用
const result = await runtime.run(createRequest('你好', { sessionKey: 's1' }));
console.log(result.content);

// 流式调用
for await (const chunk of runtime.stream(
  createRequest('写一首诗', { sessionKey: 's1' }),
)) {
  if (chunk.type === 'text') process.stdout.write(chunk.content ?? '');
}

await runtime.close();
```

## agentpack-cli（命令行）

安装：

```bash
npm install -g agentpack-cli
# 或
pnpm add -g agentpack-cli
```

使用：

```bash
# 交互式聊天（首次运行自动进入 API Key 设置向导）
agentpack chat

# 一次性提问
agentpack run "用一句话介绍 agentpack"

# 继续历史会话
agentpack continue <sessionKey>

# 初始化项目级配置文件
agentpack init --local

# 查看支持的提供商与模型
agentpack models
```

## 开发

```bash
# 安装依赖（pnpm workspace）
pnpm install

# 构建
pnpm --filter agentpack build
pnpm --filter agentpack-cli build

# 类型检查
pnpm --filter agentpack typecheck
pnpm --filter agentpack-cli typecheck
```

## 文档

- [agentpack 框架文档](packages/agentpack/README.md)
- [agentpack-cli 文档](packages/agentpack-cli/README.md)
- [agentpack-memory 文档](packages/agentpack-memory/README.md)
- [agentpack 压缩策略](agentpack-compression-strategy.md)（agentpack-compression 设计文档）

## 应用示例（apps/）

基于 agentpack 构建的端到端应用：

- [ai_travel_agent](apps/ai_travel_agent/README.md) — 🛫 AI 旅行行程规划 Web 应用（Researcher + Planner 双 Agent + SSE 流式 + ICS 日历导出）
- [ai_blog_to_podcast_agent](apps/ai_blog_to_podcast_agent/README.md) — 🎙️ AI 博客转播客 Web 应用（博客正文抓取 + 对话式摘要 + Edge TTS 免费语音合成 + SSE 流式）
- [ai_teaching_agent_team](apps/ai_teaching_agent_team/README.md) — 👨‍🏫 AI 教学代理团队 Web 应用（Professor + Advisor + Librarian + TA 四 Agent 顺序接力 + SSE 全流式 + Markdown 课程导出 + React 前端）
- [ai_rag_database_routing](apps/ai_rag_database_routing/README.md) — 📚 RAG 数据库路由 Web 应用（向量相似度 → LLM → 网页搜索三级路由 + 本地 TF-IDF 向量库 + SSE 流式回答）

## 许可证

MIT
