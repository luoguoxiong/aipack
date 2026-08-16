# aipack

<p align="center">
  <img src="image/logo.png" alt="aipack logo" width="200">
</p>

Agent 框架与命令行工具的 monorepo，核心调度、会话持久化、工具执行、上下文转换均自研实现，不依赖任何外部 Agent 框架。

## 包结构

| 包                                              | 说明                                                       |
| ---------------------------------------------- | -------------------------------------------------------- |
| [aipack](packages/agent)                       | Agent 框架：`Runtime + Extension + Transformer`，配置入口 + 执行入口 |
| [aipack-cli](packages/cli)                     | 基于 aipack 框架的命令行工具（交互式聊天、会话管理、回放等）                       |
| [aipack-coding](packages/coding)               | coding 工具集 + coding agent 工厂 + CLI（文件读写、命令执行、代码搜索）       |
| [aipack-memory](packages/memory)               | 持久化记忆插件：自动捕获/注入、BM25 + 可选向量混合检索、记忆工具                     |
| [aipack-compression](packages/compression)     | 五级上下文压缩：工具输出裁剪、消息摘要、任务状态提取、会话检查点、新会话交接                   |
| [vscode-aipack-coding](packages/vscode-coding) | VSCode 扩展：基于 aipack-coding 的 WebView 聊天面板                |

## aipack（框架）

安装：

```bash
npm install aipack
# 或
pnpm add aipack
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
} from 'aipack';

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

## aipack-cli（命令行）

安装：

```bash
npm install -g aipack-cli
# 或
pnpm add -g aipack-cli
```

使用：

```bash
# 交互式聊天（首次运行自动进入 API Key 设置向导）
aipack chat

# 一次性提问
aipack run "用一句话介绍 aipack"

# 继续历史会话
aipack continue <sessionKey>

# 初始化项目级配置文件
aipack init --local

# 查看支持的提供商与模型
aipack models
```

## 开发

```bash
# 安装依赖（pnpm workspace）
pnpm install

# 构建
pnpm --filter aipack build
pnpm --filter aipack-cli build

# 类型检查
pnpm --filter aipack typecheck
pnpm --filter aipack-cli typecheck
```

## 发布（Changesets 自动发布）

本仓库使用 [Changesets](https://github.com/changesets/changesets) 管理 `packages/*` 下 npm 包的版本与发布，由 GitHub Actions（[`.github/workflows/release.yml`](.github/workflows/release.yml)）自动完成版本升级与 npm 发布。

### 发布流程

1. **记录变更**：开发完成一个可发布改动后，在本地运行（需 Node ≥ 20）：
   ```bash
   pnpm changeset
   ```
   按提示选择受影响的包、bump 类型（major / minor / patch）并填写 changelog 摘要，生成的 changeset 文件随代码一起提交到 PR。
2. **自动创建 Version PR**：changeset 文件合并到 `main` 后，`Release` workflow 会自动创建 / 更新一个名为 `chore(release): version packages` 的 PR，里面包含版本号升级与 `CHANGELOG.md` 更新。
3. **自动发布**：合并该 Version PR 后，workflow 检测到无待处理 changeset，自动执行 `pnpm build && changeset publish` 将包发布到 npm，并创建对应的 git tag。

### 首次启用前需配置 NPM\_TOKEN

在 GitHub 仓库 **Settings → Secrets and variables → Actions → New repository secret** 添加：

- Name：`NPM_TOKEN`
- Value：npm 个人访问令牌（<https://www.npmjs.com/settings/username/tokens>，需 `Automation` 或 `Publish` 权限，且账户对 `@aipack` scope 有发布权）

`@aipack` 为 public scope，发布时已通过 `--access public` 对所有包公开可见。

> 说明：`@aipack-ai/vscode-coding` 是 VSCode 扩展，不发布到 npm（已在 changeset 配置 `ignore` 中排除），其发布走 VSCode Marketplace。

## 文档

- [aipack 框架文档](packages/agent/README.md)
- [aipack-cli 文档](packages/cli/README.md)
- [aipack-memory 文档](packages/memory/README.md)
- [aipack 压缩策略](aipack-compression-strategy.md)（aipack-compression 设计文档）

## 应用示例（apps/）

基于 aipack 构建的端到端应用：

- [ai\_travel\_agent](apps/ai_travel_agent/README.md) — 🛫 AI 旅行行程规划 Web 应用（Researcher + Planner 双 Agent + SSE 流式 + ICS 日历导出）
- [ai\_blog\_to\_podcast\_agent](apps/ai_blog_to_podcast_agent/README.md) — 🎙️ AI 博客转播客 Web 应用（博客正文抓取 + 对话式摘要 + Edge TTS 免费语音合成 + SSE 流式）
- [ai\_teaching\_agent\_team](apps/ai_teaching_agent_team/README.md) — 👨‍🏫 AI 教学代理团队 Web 应用（Professor + Advisor + Librarian + TA 四 Agent 顺序接力 + SSE 全流式 + Markdown 课程导出 + React 前端）
- [ai\_rag\_database\_routing](apps/ai_rag_database_routing/README.md) — 📚 RAG 数据库路由 Web 应用（向量相似度 → LLM → 网页搜索三级路由 + 本地 TF-IDF 向量库 + SSE 流式回答）

## 许可证

MIT
