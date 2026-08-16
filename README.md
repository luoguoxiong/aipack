<div align="center">

![aipack logo](./image/logo.png)

# aipack

**轻量级个人 AI 助手框架** — Agent 运行时 + 丰富插件生态 + 多端应用

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18-green.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/typescript-5.5%2B-blue.svg)](tsconfig.json)

</div>

---

## 🌟 特性

- **自研 Agent 框架**：核心调度、会话持久化、工具执行、上下文转换均自研实现，不依赖任何外部 Agent 框架
- **Runtime + Extension + Transformer 三段式架构**：灵活扩展，插件通过 Tapable 钩子挂载生命周期
- **多模型提供商支持**：OpenAI、DeepSeek、Anthropic、Google、Groq、Mistral、xAI、Moonshot 等 13+ 提供商开箱即用
- **流式与同步双入口**：`runtime.run()` 一次性返回，`runtime.stream()` 流式返回增量事件
- **持久化会话管理**：内存 / 文件双存储适配器，支持过期惰性清理
- **跨会话长期记忆**：BM25 + 向量双路混合检索，自动捕获/注入/合并
- **多级上下文压缩**：L1 工具输出裁剪 → L2 旧消息摘要 → L3 任务状态提取 → L4 会话检查点 → L5 新会话交接
- **可观测性全链路**：埋点 SDK + 收集服务 + Dashboard，Prometheus 指标导出
- **多端交付**：CLI、VSCode 插件、Tauri 桌面端、Web 应用全覆盖

---

## 📦 项目结构

```
aipack/
├── packages/                    # 核心包
│   ├── agent/                  # Agent 框架核心（Runtime + Extension + Transformer）
│   ├── cli/                    # 命令行工具（aipack 命令）
│   ├── coding/                 # 编程工具集 + Coding Agent
│   ├── memory/                 # 持久化记忆插件（BM25 + 向量检索）
│   ├── compression/            # 多级上下文压缩插件
│   ├── observability/          # 可观测性上报 SDK
│   ├── observability-server/   # 可观测性收集服务 + Dashboard
│   └── vscode-coding/          # VSCode AI Coding 扩展
├── apps/                        # 示例应用
│   ├── ai_blog_to_podcast_agent/   # AI 博客转播客 Agent
│   ├── ai_office_agent/             # AI 办公助手（Tauri 桌面端）
│   ├── ai_rag_database_routing/     # AI RAG 数据库路由
│   ├── ai_teaching_agent_team/      # AI 教学 Agent 团队
│   └── ai_travel_agent/             # AI 旅行助手
├── examples/                    # 代码示例
│   ├── deepseek.ts             # DeepSeek 模型接入示例
│   ├── agent-memory.ts         # Agent 记忆插件示例
│   └── compression-demo.ts     # 上下文压缩示例
├── docs/                        # 设计文档
├── web-docs/                    # 官方文档网站（Vite + React）
└── image/                       # 资源图片
```

---

## 🚀 快速开始

### 环境要求

- Node.js >= 18.0.0
- pnpm >= 8（推荐）或 npm / yarn

### 安装（作为 CLI 使用）

```bash
npm install -g @aipack-ai/cli
# 或
pnpm add -g @aipack-ai/cli
```

### 首次使用

```bash
# 1. 启动交互式聊天（无 API Key 时自动进入设置向导）
aipack chat

# 2. 或一次性提问
aipack run "用一句话介绍 aipack"
```

### 安装（作为库使用）

```bash
pnpm add @aipack-ai/agent
```

### 最小代码示例

```typescript
import {
  createRuntime,
  createRequest,
  getBuiltinModel,
  adaptAiModel,
  createStreamFnFromAi,
  createFileSessionStorage,
} from '@aipack-ai/agent';

// 1. 从内置模型目录获取 DeepSeek 模型
const aiModel = getBuiltinModel('deepseek', 'deepseek-chat');

// 2. 创建 Runtime（零手写 streamFn）
const runtime = await createRuntime({
  model: adaptAiModel(aiModel),
  streamFn: createStreamFnFromAi(aiModel),
  systemPrompt: '你是一个简洁的 AI 助手',
  sessionStorage: createFileSessionStorage({ baseDir: './sessions' }),
  tools: [{
    name: 'get_weather',
    description: '查询城市天气',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
    execute: async (_id, args) => ({
      content: [{ type: 'text', text: `${args.city}: 晴 25°C` }],
    }),
  }],
});

// 3. 流式运行
console.log('\nAI:');
for await (const chunk of runtime.stream(createRequest('北京天气怎么样？'))) {
  if (chunk.type === 'text' && chunk.content) {
    process.stdout.write(chunk.content);
  }
}
await runtime.close();
```

运行：

```bash
DEEPSEEK_API_KEY=sk-xxx npx tsx your-script.ts
```

更多示例见 [examples/](./examples) 目录。

---

## 🧩 核心包介绍

### 1. `@aipack-ai/agent` — Agent 框架核心

**包路径**: [packages/agent](./packages/agent)

Agent 框架内核，提供：

| 模块 | 说明 |
| --- | --- |
| **Runtime** | 核心调度器：请求 → 任务图 → 上下文转换 → 模型调用 → 工具执行 → 结果 |
| **Extension** | 插件系统：Tapable 钩子挂载生命周期（beforeRun / done / failed 等） |
| **Transformer** | 上下文转换器：按数组顺序链式转换（工具配对、截断、快照等） |
| **Session** | 会话持久化：文件 / 内存双适配器，`maxAge` 过期惰性清理 |
| **TaskGraph** | 任务依赖图：工具调用链路追踪与分析 |
| **AI 模型层** | 多提供商标准化模型目录 + 流式实现（`aipack/ai` 子模块） |

### 2. `@aipack-ai/cli` — 命令行工具

**包路径**: [packages/cli](./packages/cli)

基于 aipack 框架的 AI 命令行助手。

```bash
aipack chat              # 交互式聊天（默认命令）
aipack run "你好"        # 一次性提问
aipack continue <key>    # 继续历史会话
aipack replay <key>      # 回放会话复现问题
aipack sessions list     # 列出所有会话
aipack init --local      # 初始化项目配置
aipack models            # 查看支持的模型
aipack reset all         # 重置所有数据
```

### 3. `@aipack-ai/coding` — 编程工具集

**包路径**: [packages/coding](./packages/coding)

文件读写、命令执行、代码搜索等编程工具 + Coding Agent 工厂 + CLI。

**内置工具**：

| 工具 | 说明 |
| --- | --- |
| `read_file` | 读取文件 |
| `write_file` | 写入文件 |
| `edit_file` | 编辑文件（精确替换） |
| `list_directory` | 列出目录 |
| `run_command` | 执行 Shell 命令 |
| `grep` | 代码搜索（ripgrep） |
| `glob` | 文件模式匹配 |

### 4. `@aipack-ai/memory` — 持久化记忆插件

**包路径**: [packages/memory](./packages/memory)

跨会话长期记忆能力：**capture → compress → index → recall/inject → consolidate**

- **自动捕获**：每轮对话结束提取要点存为记忆（零-LLM 要点压缩，可选 LLM 摘要）
- **自动注入**：每轮对话开始检索相关记忆，sentinel 机制防跨轮累积
- **BM25 检索**：零依赖关键词检索，支持 CJK（中日韩）bigram 分词
- **混合检索**：BM25 + 向量双路独立召回融合
- **记忆合并**：增量去重 / 合并相似记忆，修剪过期低置信度条目
- **Agent 工具**：save / search / list / delete 4 个可调用工具

### 5. `@aipack-ai/compression` — 上下文压缩插件

**包路径**: [packages/compression](./packages/compression)

五级上下文压缩策略，解决长对话 Token 爆炸问题：

| 级别 | 策略 | 说明 |
| --- | --- | --- |
| L1 | 工具输出裁剪 | 截断冗余工具输出 |
| L2 | 旧消息摘要 | 历史对话摘要压缩 |
| L3 | 任务状态提取 | 抽取当前任务关键状态 |
| L4 | 会话检查点 | 完整状态快照存档 |
| L5 | 新会话交接 | 跨会话无缝上下文迁移 |

### 6. `@aipack-ai/observability` + `@aipack-ai/observability-server` — 可观测性

**包路径**: [packages/observability](./packages/observability) · [packages/observability-server](./packages/observability-server)

- **SDK 侧**：`appId + appSecret` 一行接入，失败本地缓存补报
- **服务侧**：SQLite 落盘 + 内存聚合 + REST 查询 + Web Dashboard
- **指标**：Token 用量、调用延迟、工具成功率、错误分布
- **告警**：自定义规则 + 通知
- **导出**：Prometheus `/metrics` 端点

### 7. `@aipack-ai/vscode-coding` — VSCode 扩展

**包路径**: [packages/vscode-coding](./packages/vscode-coding)

基于 aipack-coding 的 VSCode AI Coding 助手：

- Webview 聊天面板 + 流式输出
- 工具调用卡片展示 + 命令二次确认
- 跨会话记忆（自动 capture/recall 项目约定）
- 支持 13+ 模型提供商，可在 VSCode 设置中切换

---

## 💡 示例应用 (apps)

| 应用 | 说明 | 亮点 |
| --- | --- | --- |
| [ai_blog_to_podcast_agent](./apps/ai_blog_to_podcast_agent) | AI 博客转播客 | 网页抓取 → 内容改写 → TTS 语音合成 |
| [ai_office_agent](./apps/ai_office_agent) | AI 办公助手 | Tauri 桌面端 + Office 文档操作 + 文件工具 |
| [ai_rag_database_routing](./apps/ai_rag_database_routing) | RAG 数据库路由 | 向量数据库 + 智能路由搜索 |
| [ai_teaching_agent_team](./apps/ai_teaching_agent_team) | 教学 Agent 团队 | 多 Agent 协作教学 + 前端交互面板 |
| [ai_travel_agent](./apps/ai_travel_agent) | AI 旅行助手 | 行程规划 + 联网搜索 + 流式输出 |

---

## 🔧 开发指南

### 克隆 & 安装依赖

```bash
git clone https://github.com/luoguoxiong/aipack.git
cd aipack
pnpm install
```

### 构建所有包

```bash
pnpm build
```

### 运行示例

```bash
# DeepSeek 模型示例
DEEPSEEK_API_KEY=sk-xxx pnpm example:deepseek

# Agent 记忆示例
pnpm example:agent-memory

# 上下文压缩示例
pnpm example:compression

# Coding 工具示例
pnpm example:coding
```

### 测试

```bash
# 类型检查
pnpm lint

# 各包测试（具体见各包 scripts.test）
pnpm --filter @aipack-ai/agent test
pnpm --filter @aipack-ai/memory test
pnpm --filter @aipack-ai/coding test
```

### 文档网站

```bash
# 开发模式
pnpm docs:dev

# 构建
pnpm docs:build
```

### 版本发布

项目使用 [Changesets](https://github.com/changesets/changesets) 管理版本：

```bash
# 1. 添加变更记录
pnpm changeset

# 2. 更新版本号 & CHANGELOG
pnpm version-packages

# 3. 构建 & 发布
pnpm release
```

---

## 📋 Scripts 参考

根目录 `package.json` 脚本：

| 命令 | 说明 |
| --- | --- |
| `pnpm build` | 构建所有 packages 下的包 |
| `pnpm build:agent` | 单独构建 agent 包 |
| `pnpm example:deepseek` | 运行 DeepSeek 示例 |
| `pnpm example:agent-memory` | 运行 Agent 记忆示例 |
| `pnpm example:compression` | 运行上下文压缩示例 |
| `pnpm example:coding` | 运行 Coding 工具示例 |
| `pnpm lint` | 全量 TypeScript 类型检查（noEmit） |
| `pnpm docs:dev` | 启动文档网站开发服务器 |
| `pnpm docs:build` | 构建文档网站 |
| `pnpm changeset` | 添加 changeset 变更记录 |
| `pnpm version-packages` | 根据 changeset 更新版本号 |
| `pnpm release` | 构建 + 发布所有包到 npm |

---

## 🔐 API Key 配置

API Key 支持以下方式（优先级从高到低）：

1. **Shell 环境变量**：
   ```bash
   export DEEPSEEK_API_KEY="sk-xxx"
   export OPENAI_API_KEY="sk-xxx"
   ```

2. **`.env` 文件**（项目级 `<cwd>/.env` 优先级 > 用户级 `~/.aipack/.env`）：
   ```bash
   DEEPSEEK_API_KEY=sk-xxx
   OPENAI_API_KEY=sk-xxx
   ANTHROPIC_API_KEY=sk-xxx
   ```

3. **CLI 向导**：首次运行 `aipack chat` 无任何 Key 时自动进入设置。

变量名规则：`<PROVIDER_ID_UPPERCASE>_API_KEY`，如 `DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`GROQ_API_KEY` 等。

支持的提供商：`openai` · `deepseek` · `anthropic` · `groq` · `google` · `openrouter` · `mistral` · `xai` · `cerebras` · `together` · `fireworks` · `nvidia` · `moonshot`

---

## 🤝 相关项目

- [Agent 框架 README](./packages/agent/README.md) — 核心 Runtime / Extension / Transformer 详细 API
- [CLI README](./packages/cli/README.md) — `aipack` 命令完整参考与配置说明
- [记忆插件 README](./packages/memory/README.md) — 持久化记忆检索原理与自定义扩展
- [可观测性服务 README](./packages/observability-server/README.md) — Server 部署与 Dashboard 使用

---

## 📄 License

MIT © [luoguoxiong](https://github.com/luoguoxiong)
