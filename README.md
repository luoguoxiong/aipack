# Kobot

<p align="center">
  <img src="image/logo.png" alt="Kobot logo" width="200">
</p>

一个轻量级的个人 AI 助手框架。

## 特性

- **多模型支持** — 内置 OpenAI、Anthropic、DeepSeek、Groq、Google Gemini 等 20+ 模型提供商支持，支持自定义兼容 OpenAI API 的服务
- **多渠道交互** — 交互式 CLI、Webhook HTTP API、飞书机器人
- **丰富的工具集** — 文件系统操作、Shell 执行、网络搜索和爬取、记忆管理、定时任务、代码补丁、搜索、消息推送等 20+ 工具
- **会话持久化** — 支持内存和文件两种会话存储方式，可恢复对话历史，支持会话树形结构（含工具调用链记录）
- **Agent Progress Guard (APG)** — 运行时进展检测与自动干预，6 种检测策略识别状态冻结、错误循环、工具循环等停滞模式，支持自适应权重和语义分析
- **Agent Context Runtime (ACR) v2.1** — 上下文运行时操作系统，管理完整上下文生命周期：观察 → 理解 → 压缩 → 记忆 → 重建 → 继续
- **结构化日志** — 基于 pino 的分级日志系统，支持文件轮转和错误日志分离

## 快速开始

### 安装

```bash
# 全局安装
npm install -g kobot-pi

# 或者从源码运行
git clone git@github.com:your/kobot.git
cd kobot
pnpm install
pnpm run build
```

### 首次运行

```bash
# 直接启动（如果未配置 API Key，会自动启动设置向导）
npm start
```

首次启动时，如果未检测到 API Key 环境变量，Kobot 会自动进入交互式设置向导，引导你选择模型提供商并配置 API Key。

### 环境变量配置

你也可以手动设置环境变量：

```bash
# DeepSeek（默认模型）
export DEEPSEEK_API_KEY="your-deepseek-api-key"

# 或其他提供商
export OPENAI_API_KEY="your-openai-api-key"
export ANTHROPIC_API_KEY="your-anthropic-api-key"
export GROQ_API_KEY="your-groq-api-key"
export GEMINI_API_KEY="your-gemini-api-key"
```

环境变量会被自动持久化到 `~/.kobot/.env` 文件，下次启动时自动加载。

### 选择模型

通过 `KOBOT_MODEL` 环境变量选择默认模型：

```bash
export KOBOT_MODEL="gpt-4o-mini"
```

或在配置文件 `~/.kobot/config.yaml` 中设置：

```yaml
agents:
  defaults:
    model: claude-sonnet-4-20250514
    provider: anthropic
```

## CLI 使用

### 命令行入口

```bash
# 启动交互式 CLI（默认命令）
kobot start

# 回放历史会话以复现问题
kobot replay <sessionKey>

# 重置数据
kobot reset all              # 重置所有数据
kobot reset config           # 重置配置
kobot reset logs             # 清空日志
kobot reset sessions         # 清空会话
kobot reset memory           # 清空记忆
```

重置命令支持 `-y` / `--yes` 参数跳过确认提示。

### 交互式命令

启动后进入交互式命令行界面：

```
CLI channel started
Session: cli_20260727_120000
Type "exit" or "quit" to exit
Type "help" for available commands
---
kobot>
```

内置命令：

| 命令              | 说明              |
| --------------- | --------------- |
| `help`          | 显示帮助信息          |
| `tools`         | 列出所有可用工具        |
| `sessions`      | 列出所有会话          |
| `session <key>` | 查看会话详细信息        |
| `use <key>`     | 切换到指定会话（恢复历史记录） |
| `replay <key>`  | 回放历史会话以复现问题     |
| `exit` / `quit` | 退出              |

### 示例会话

```
kobot> 帮我列出当前目录的文件
🔧 Running: shell
✅ shell completed
当前目录下的文件：
- src/
- tests/
- package.json
- tsconfig.json
- README.md

kobot> sessions
Active sessions:
  - sdk:default
```

## 多渠道支持

### Webhook

通过 HTTP API 接入第三方服务。启动 Webhook 服务后，可通过 POST 请求发送消息并获取 AI 回复。

```yaml
# 在配置文件中启用 Webhook
# Webhook 服务默认在 cli.ts 中不自动启动
```

Webhook 请求格式：

```json
POST /webhook
{
  "content": "你好",
  "chatId": "user123",
  "senderId": "user123",
  "senderName": "用户"
}
```

支持可选的 Bearer Token 认证（通过配置 `secret` 字段）。

### 飞书 (Feishu)

通过环境变量配置飞书机器人：

```bash
export FEISHU_APP_ID="your-app-id"
export FEISHU_APP_SECRET="your-app-secret"
export FEISHU_PORT="3000"
export FEISHU_PATH="/webhook/event"
```

启动 Kobot 后，配置了飞书环境变量会自动启动飞书渠道。支持：

- 文本消息处理
- 会话隔离（按 chatId）
- 流式回复

## 配置

Kobot 的配置文件位于 `~/.kobot/config.yaml`。首次启动时如文件不存在会自动创建默认配置。

### 完整配置参考

```yaml
# ~/.kobot/config.yaml
schema_version: 1
workspace: ~/.kobot

agents:
  defaults:
    workspace: workspace # 默认工作空间
    model: deepseek-v4-flash # 默认模型
    provider: auto # 模型提供商（auto 为自动选择）
    max_tokens: 8192
    context_window_tokens: 200000
    context_block_limit: ~ # 上下文块限制
    temperature: 0.1
    max_tool_iterations: 200 # 单次任务最大工具调用次数
    max_concurrent_subagents: 1 # 最大并发子 agent 数
    fail_on_tool_error: true # 工具错误是否终止任务
    max_tool_result_chars: 16000 # 工具结果最大字符数
    provider_retry_mode: standard # 提供商重试模式（standard/persistent）
    timezone: Asia/Shanghai
    bot_name: kobot
    bot_icon: image/logo.png
    unified_session: false # 是否使用统一会话
    disabled_skills: [] # 禁用的技能列表

  model_presets:
    fast:
      label: 快速模式
      model: deepseek-v4-flash
      provider: deepseek
      max_tokens: 4096
      temperature: 0.3
    precise:
      label: 精确模式
      model: claude-sonnet-4-20250514
      provider: anthropic
      max_tokens: 8192
      temperature: 0.1

  instances: {} # 按实例的配置覆盖

providers:
  defaults: {}
  items:
    - name: openai
      base_url: https://api.openai.com/v1
      api_key: '${OPENAI_API_KEY}'
    - name: custom
      base_url: https://your-api.com/v1
      api_key: '${CUSTOM_API_KEY}'
      default_model: your-model
      extra_headers: {} # 额外请求头
      extra_query: {} # 额外查询参数

tools:
  filesystem:
    enabled: true
    workspace_only: true # 限制文件操作在工作空间内
    max_file_size_mb: 10
    allowed_patterns: [] # 允许的文件模式
    denied_patterns: [] # 禁止的文件模式
  shell:
    enabled: true
    workspace_only: true
    timeout_sec: 120
    sandbox_backend: none # 沙箱后端（none/docker）
  web:
    enabled: true
    search_provider: ddg # 搜索引擎（ddg = DuckDuckGo）
    fetch_timeout_sec: 30
    max_search_results: 5
  image_generation:
    enabled: true
    provider: auto
    model: ~
    size: 1024x1024
    quality: standard
  mcp:
    enabled: true
    servers: {} # MCP 服务器配置
  cli_apps:
    enabled: true
    apps: {} # CLI 应用配置

memory:
  enabled: true
  base_dir: memory
  dream:
    enabled: true
    interval_h: 2 # 记忆整理间隔（小时）
    max_batch_size: 20
    max_iterations: 15

sessions:
  storage: file # 会话持久化方式（memory 或 file）
  storage_path: sessions

logging:
  level: info # trace / debug / info / warn / error / fatal
  file_path: logs/kobot.log
  console_enabled: true
  rotation:
    enabled: true # 是否启用日志轮转
    max_size: 10M # 单个日志文件最大大小
    max_files: 30 # 保留日志文件最大数量
    compress: true # 是否压缩旧日志文件
  separate_error_log: true # 是否单独记录错误日志

progress_guard:
  enabled: true
  profile: assistant # 预设：coding / research / assistant / workflow
  window_size: 20 # 检测窗口大小
  min_turns_before_detect: 3 # 最少多少轮后才开始检测
  suspicious_threshold: 0.4 # 可疑阈值
  stuck_threshold: 0.7 # 卡住阈值
  failed_threshold: 0.9 # 失败阈值
  confirmation_turns: 2 # 确认升级所需连续轮数
  downgrade_turns: 3 # 降级所需连续轮数
  debug: false

context_runtime:
  enabled: true
  profile: coding # 预设：coding / research / assistant
  context_limit: 128000 # 上下文限制 token 数
  debug: false

security:
  workspace_access: allow # 工作空间访问策略（allow/deny/ask）
  network_access: true
  pth_guard: true # 路径穿越防护

cron:
  enabled: true
  timezone: UTC

gateway:
  enabled: false # API 网关
  host: 127.0.0.1
  port: 8765
  cors_origins:
    - http://localhost:5173
  auth_token: ~
  webui_path: ~

api:
  enabled: false # REST API 服务
  host: 127.0.0.1
  port: 8000
  api_keys: []
  cors_origins: []
```

### 配置文件路径

配置文件位置可通过 `KOBOT_CONFIG_DIR` 环境变量自定义：

```bash
export KOBOT_CONFIG_DIR="/path/to/config"
```

## 架构

```
kobot/
├── src/
│   ├── agent/              # Agent 引擎（核心循环 + 钩子系统 + 上下文构建）
│   │   ├── agent.ts        # Agent 类（消息循环、工具执行、流式通信）
│   │   ├── context.ts      # 系统提示词构建
│   │   ├── hook.ts         # 事件钩子系统
│   │   ├── types.ts        # Agent 类型定义
│   │   └── index.ts        # 模块导出
│   ├── ai/                 # AI 基础设施（流式协议、模型管理、提供商适配）
│   │   ├── types.ts        # 核心类型（消息、模型、流事件）
│   │   ├── models.ts       # Models 类（提供商管理、流式路由）
│   │   ├── catalog.ts      # 内置模型目录（28 个模型）
│   │   ├── providers-all.ts # 内置提供商工厂
│   │   ├── stream-openai.ts # OpenAI SSE 流式解析
│   │   ├── stream-anthropic.ts # Anthropic 流式解析
│   │   ├── images.ts       # 图片生成
│   │   ├── compat.ts       # 提供商兼容性检测
│   │   ├── overflow.ts     # 上下文溢出检测
│   │   ├── diagnostics.ts  # 诊断工具
│   │   ├── error-body.ts   # 统一错误格式化
│   │   ├── retry.ts        # 指数退避重试
│   │   ├── json-parse.ts   # JSON 修复与流式解析
│   │   ├── sanitize-unicode.ts # Unicode 清理
│   │   └── index.ts        # 模块导出
│   ├── skill/               # Skill 系统（Phase 1）
│   │   ├── types.ts        # 类型定义（SkillManifest, SkillMatch 等）
│   │   ├── registry.ts     # Skill 注册中心（CRUD + 禁用管理）
│   │   ├── loader.ts       # Skill 加载器（目录扫描 + YAML/MD 解析）
│   │   ├── router.ts       # 四级路由（显式/关键词/文件/LLM）
│   │   ├── runtime.ts      # 执行引擎（Hook 链 + 超时 + 熔断 + Trace）
│   │   ├── context-manager.ts  # 上下文管理器（文件读取 + Token 预算）
│   │   ├── prompt-compiler.ts  # Prompt 编译器（Frontmatter + Context + Tool 注入）
│   │   ├── manager.ts      # Skill 管理器（统一入口 + CLI）
│   │   └── index.ts        # 导出
│   ├── channels/           # 交互渠道
│   │   ├── cli.ts          # 命令行界面
│   │   ├── webhook.ts      # Webhook HTTP 服务
│   │   ├── feishu.ts       # 飞书机器人集成
│   │   └── types.ts        # 渠道类型定义
│   ├── config/             # 配置子系统
│   │   ├── schema.ts       # Zod 配置模式定义（完整配置类型）
│   │   ├── loader.ts       # 配置加载和保存
│   │   └── paths.ts        # 路径解析工具
│   ├── storage/            # 持久化存储
│   │   ├── file.ts         # 文件存储实现
│   │   ├── memory.ts       # 内存存储实现
│   │   ├── session-manager.ts  # 会话管理器（树形结构）
│   │   └── types.ts        # 存储类型定义
│   ├── tools/              # 工具集
│   │   ├── base.ts         # 工具基类（容错、重试、健康监控）
│   │   ├── types.ts        # 工具类型定义
│   │   ├── registry.ts     # 工具注册中心
│   │   ├── filesystem.ts   # 文件系统工具（7个）
│   │   ├── shell.ts        # Shell 命令工具
│   │   ├── web.ts          # 网络工具（搜索+抓取）
│   │   ├── search.ts       # 搜索工具（grep+glob）
│   │   ├── memory.ts       # 记忆管理工具（CRUD）
│   │   ├── cron.ts         # 定时任务工具（4个）
│   │   ├── utilities.ts    # 通用工具（echo/时间/计算/编解码）
│   │   ├── apply_patch.ts  # 代码补丁工具
│   │   ├── scheduler.ts    # 任务调度工具
│   │   ├── self.ts         # 运行时自省工具
│   │   └── message.ts      # 消息推送工具
│   ├── progress-guard/     # Agent Progress Guard
│   │   ├── index.ts        # 主入口，集成所有组件
│   │   ├── types.ts        # 核心类型定义
│   │   ├── trace-collector.ts   # 执行轨迹采集
│   │   ├── state-engine.ts      # 资源状态引擎
│   │   ├── progress-analyzer.ts # 进展分析（6 种检测策略）
│   │   ├── risk-engine.ts       # 风险评分引擎
│   │   ├── recovery-controller.ts  # 恢复控制器（分级干预）
│   │   ├── metrics.ts           # 指标采集
│   │   ├── adaptive-weights.ts  # 自适应权重学习
│   │   └── semantic-analyzer.ts # 语义循环检测
│   ├── context-runtime/    # Agent Context Runtime (ACR) v2.1
│   │   ├── runtime.ts      # 主运行时入口
│   │   ├── types.ts        # 类型定义
│   │   ├── state/          # 状态管理
│   │   │   ├── agent-state.ts
│   │   │   ├── message-adapter.ts
│   │   │   ├── state-extractor.ts
│   │   │   ├── snapshot-builder.ts
│   │   │   └── index.ts
│   │   ├── compress/       # 压缩策略
│   │   │   ├── index.ts
│   │   │   ├── transition.ts
│   │   │   ├── l1-clean.ts
│   │   │   ├── l2-window.ts
│   │   │   └── pairing.ts
│   │   ├── monitor/        # 监控器
│   │   │   ├── index.ts
│   │   │   ├── token-monitor.ts
│   │   │   └── density-monitor.ts
│   │   ├── tool/           # 工具处理
│   │   │   ├── index.ts
│   │   │   └── digestor.ts
│   │   ├── memory/         # 记忆系统
│   │   │   ├── index.ts
│   │   │   └── session-memory.ts
│   │   ├── observer/       # 观察者
│   │   │   ├── index.ts
│   │   │   └── workspace-observer.ts
│   │   ├── observability/  # 可观测性
│   │   │   ├── index.ts
│   │   │   └── metrics.ts
│   │   ├── config/         # 配置预设
│   │   │   └── defaults.ts
│   │   └── index.ts
│   ├── utils/
│   │   └── logger.ts       # 日志系统（pino + 轮转）
│   ├── kobot.ts            # 核心 Kobot 类（SDK 入口）
│   ├── cli.ts              # CLI 入口（start/replay/reset 命令）
│   ├── setup-wizard.ts     # 首次启动设置向导
│   ├── index.ts            # 公共导出
│   └── types.ts            # 全局类型
├── tests/
│   └── kobot.test.ts       # 测试
├── skills/                  # 内置 Skill 包
│   └── code-review/         # 代码审查 Skill
│       ├── skill.yaml       # Manifest 定义
│       ├── SKILL.md         # Prompt 指令
│       └── handler.ts       # 执行处理器
├── docs/                   # 详细文档
│   ├── configuration.md    # 配置参考
│   ├── context-compression.md  # 上下文压缩策略设计文档
│   ├── context-compressionv2.md
│   ├── development.md      # 开发指南
│   ├── feishu.md           # 飞书集成指南
│   └── loop-detector.md    # 循环检测设计
├── image/
│   └── logo.png            # Logo
├── package.json
└── tsconfig.json
```

### 核心模块

#### Kobot 类

`Kobot` 是框架的核心类，负责初始化 Agent、管理工具注册、处理会话和消息流。

```typescript
import { Kobot } from 'kobot-pi';

// 从配置文件初始化
const bot = await Kobot.fromConfig();

// 同步处理消息
const result = await bot.run('你好！');

// 流式处理消息
for await (const event of bot.stream('写一个 Hello World')) {
  if (event.type === 'text_chunk') {
    process.stdout.write(event.content || '');
  }
}

// 会话管理
const sessions = await bot.listSessions();
const detail = await bot.getSessionDetail('my-session');
const deleted = await bot.deleteSession('my-session');

// 会话回放
const replayResult = await bot.replaySession('my-session');

// 其他
const isBusy = bot.isBusy('session-key');
await bot.waitForIdle('session-key');
await bot.close();
```

#### 流式事件

`stream()` 方法通过 AsyncGenerator 产生以下事件：

| 事件类型                                 | 说明                          |
| ------------------------------------ | --------------------------- |
| `run_started` / `run_finished` / `run_failed` | 运行生命周期                    |
| `text_chunk` / `text_finished`       | 文本流式输出                    |
| `thinking_chunk`                     | 思考过程输出                    |
| `tool_started` / `tool_finished`     | 工具执行事件（`isError` 区分失败）  |
| `file_edit`                          | 文件编辑事件（含 start/end/error） |

流式事件可配合 Webhook、飞书等渠道实现实时响应。

#### 会话管理

Kobot 支持会话持久化，保存对话历史和工具调用记录。会话以树形结构存储，包含：

- 模型变更（provider、modelId）
- 用户消息和 AI 回复
- 工具调用输入和结果（完整配对）
- Token 用量统计

会话回放功能可通过 `kobot replay <sessionKey>` 或 SDK 的 `bot.replaySession()` 方法，按顺序重新发送历史用户消息以复现和诊断问题。

#### Agent Progress Guard

`ProgressGuard` 是 Agent 运行时控制平面，实时检测 Agent 执行是否陷入停滞或循环，并自动进行分级干预。

**工作原理**：

```
每轮结束后 → 轨迹采集 → 多维度评分 → 风险引擎 → 分级干预
```

- 多维度进展评分：状态变化、信息增益、错误移动、新颖度、输出增长
- 6 种检测策略：
  - `state_freeze` — 状态冻结检测
  - `error_loop` — 错误循环检测
  - `tool_cycle` — 工具循环检测
  - `action_repeat` — 动作重复检测
  - `progress_stagnation` — 进展停滞检测
  - `budget_waste` — 预算浪费检测
- 语义循环检测（SimHash + n-gram）
- 自适应权重学习，根据历史反馈自动调整策略权重
- 分级干预状态机：`normal → suspicious → stuck → failed`，支持降级恢复
- 白名单机制（批量操作、长思考链、自我修正等豁免规则）

```typescript
// 获取诊断报告
const diagnosis = bot.progressGuard_.getDiagnosis();

// 获取 Dashboard 数据
const dashboard = bot.progressGuard_.getDashboardData();

// 事件监听
bot.progressGuard_.on((event) => {
  console.log(event.type, event.score);
});
```

#### Agent Context Runtime (ACR) v2.1

ACR 是 Agent 上下文运行时操作系统，管理完整的上下文生命周期：

**核心流程**：

```
观察（Observe）→ 理解（Understand）→ 压缩（Compress）
→ 记忆（Remember）→ 重建（Rebuild）→ 继续（Continue）
```

**压缩级别**：

| 级别 | 策略        | 类型  | 压缩比    | 说明           |
| -- | --------- | --- | ------ | ------------ |
| L0 | 无压缩       | -   | 0%     | 正常运行         |
| L1 | 去重 + 清理   | 无损  | 10-20% | 移除重复和无效内容    |
| L2 | 滑窗 + 关键锚点 | 半无损 | 30-50% | 保留近期和关键消息    |
| L3 | 中间步骤总结    | 有损  | 50-70% | 折叠失败尝试，合并重复读 |
| L4 | 语义聚类 + 摘要 | 有损  | 70-85% | 会话分段，分层摘要    |
| L5 | 激进重写      | 有损  | 85-95% | 仅保留最核心信息     |

- 多触发器：Token 阈值、停滞检测（与 Progress Guard 联动）、错误风暴、阶段完成、用户主动触发
- 三场景预设配置：`coding` / `research` / `assistant`
- 工具配对完整性保证（tool\_call 与 tool\_result 永不分离）
- 压缩后平滑过渡（注入过渡消息避免模型困惑）
- 与记忆系统协同（压缩前自动提取重要信息）

#### Skills

Skills 是 Kobot 的可插拔能力包，允许你通过简单的 YAML + Markdown 定义为 Agent 注入特定领域的指令和行为。

**核心流程**：

```
Agent 输入 → SkillRouter（四级匹配）→ ContextManager → PromptCompiler → SkillRuntime → 注入 Agent
```

**四种 Skill 类型**：

| 类型          | 说明                 | 适用场景        |
| ----------- | ------------------ | ----------- |
| `action`    | 带 handler 的自定义执行逻辑 | 需要特定处理流程的任务 |
| `knowledge` | 纯知识/指令注入，无执行逻辑     | 规范引导、角色设定   |
| `workflow`  | 多步骤编排              | 代码审查、问题复现   |
| `agent`     | 子 Agent 托管         | 需要独立会话的任务   |

**四级路由**：

1. **Level 0 — 显式调用**：输入以 `/skillName` 开头时直接触发
2. **Level 1 — 关键词匹配**：匹配 `trigger.keywords` 中的关键词，匹配数越多 confidence 越高
3. **Level 2 — 文件匹配**：匹配 `trigger.file_patterns`，按当前文件扩展名过滤
4. **Level 3 — LLM Router**（Phase 2+）：Level 0-2 未命中时，由 LLM 从候选列表中智能选择

**Manifest 完整字段**：

```yaml
name: my-skill # 必填。唯一标识，也是显式调用名（/my-skill）
version: 1.0.0 # 必填。语义化版本
type: action # 必填。action | knowledge | workflow | agent
description: 做某件事 # 必填。简要说明（Level 3 Router 使用）

trigger: # 选填。触发条件
  keywords: # Level 1 关键词
    - 触发词
  file_patterns: [] # Level 2 文件模式（如 *.vue, *.ts）
  priority: 5 # 同 Level 时优先级（默认 0）

context: # 选填。上下文需求
  include: # 必读文件（自动映射为 required）
    - path/to/file
  required: [] # 必读文件（与 include 等效）
  optional: [] # 预算充足时读入
  exclude: [] # 排除文件
  max_tokens: 8000 # Token 预算

runtime: # 选填。运行时配置
  timeout: 30000 # 超时（ms）
  retry: 1 # 重试次数

tools: # 选填。Agent 可用工具限制
  allowed: # 白名单
    - read_file
    - grep

permission: # 选填。权限声明
  scopes: []
```

**快速创建自定义 Skill**：

创建一个目录，放两个文件：

```yaml
# skills/my-skill/skill.yaml
name: my-skill
version: 1.0.0
type: knowledge
description: 做某件事
trigger:
  keywords:
    - 触发词
context:
  include:
    - path/to/reference.md
```

```markdown
# skills/my-skill/SKILL.md

你是一个 My Skill，请严格按照以下规则执行...

## Rules

1. Rule one
2. Rule two

## Output Format

...
```

**CLI 管理命令**：

```bash
kobot skills list           # 列出所有已注册的 Skill
kobot skills reload         # 重新加载 Skill 目录
kobot skills traces         # 查看最近执行记录
```

**配置禁用 Skill**：在 `config.yaml` 中设置 `agents.defaults.disabled_skills` 列表即可禁用特定 Skill。`kobot skills list` 列出所有 Skill 名称供参考。

## 可用工具

Kobot 内置 25+ 工具，覆盖文件操作、命令执行、网络访问、记忆管理、定时任务等场景。

### 文件系统

| 工具名称               | 说明       |
| ------------------ | -------- |
| `read_file`        | 读取文件内容   |
| `write_file`       | 写入/追加文件  |
| `edit_file`        | 编辑文件     |
| `delete_file`      | 删除文件     |
| `rename_file`      | 重命名/移动文件 |
| `create_directory` | 创建目录     |
| `delete_directory` | 删除目录     |
| `list_directory`   | 列出目录内容   |
| `apply_patch`      | 应用代码补丁   |

### Shell

| 工具名称    | 说明          |
| ------- | ----------- |
| `shell` | 执行 Shell 命令 |

### 网络

| 工具名称         | 说明     |
| ------------ | ------ |
| `web_search` | 搜索引擎查询 |
| `web_fetch`  | 抓取网页内容 |

### 搜索

| 工具名称         | 说明            |
| ------------ | ------------- |
| `grep`       | 在文件中搜索文本      |
| `find_files` | 按 Glob 模式匹配文件 |

### 记忆管理

| 工具名称            | 说明       |
| --------------- | -------- |
| `memory_save`   | 保存一条记忆   |
| `memory_load`   | 加载一条记忆   |
| `memory_list`   | 列出所有记忆键名 |
| `memory_delete` | 删除一条记忆   |

### 定时任务

| 工具名称          | 说明           |
| ------------- | ------------ |
| `cron_add`    | 添加定时 cron 任务 |
| `cron_remove` | 移除定时任务       |
| `cron_list`   | 列出所有定时任务     |
| `cron_enable` | 启用/禁用任务      |

### 通用工具

| 工具名称            | 说明        |
| --------------- | --------- |
| `echo`          | 回显文本      |
| `get_time`      | 获取当前时间    |
| `calculate`     | 执行数学计算    |
| `encode_base64` | Base64 编码 |
| `decode_base64` | Base64 解码 |

### 其他

| 工具名称        | 分类 | 说明    |
| ----------- | -- | ----- |
| `scheduler` | 调度 | 任务调度  |
| `self`      | 自省 | 运行时自省 |
| `message`   | 推送 | 消息推送  |

## 使用 SDK

Kobot 可作为库集成到你的 Node.js 项目中：

```typescript
import { Kobot } from 'kobot-pi';

// 初始化
const bot = await Kobot.fromConfig({
  model: 'deepseek-v4-flash',
});

// 同步处理
const result = await bot.run('你好！');
console.log(result.content);

// 流式处理
for await (const event of bot.stream('写一个 Hello World')) {
  if (event.type === 'text_chunk') {
    process.stdout.write(event.content || '');
  }
}

// 自定义会话（多会话隔离）
await bot.run('消息1', { sessionKey: 'session-a' });
await bot.run('消息2', { sessionKey: 'session-b' });

// 会话回放（复现问题）
const replay = await bot.replaySession('session-a');
console.log(replay.turns); // 每轮的 userMessage / response / error

// 检查会话状态
const isBusy = bot.isBusy('session-a');
await bot.waitForIdle('session-a');

// 关闭
await bot.close();
```

## 日志

日志文件默认保存在 `~/.kobot/logs/kobot.log`，使用 pino 结构化 JSON 格式。

```bash
# 实时查看日志
tail -f ~/.kobot/logs/kobot.log | npx pino-pretty
```

日志配置：

```yaml
logging:
  level: info # trace / debug / info / warn / error / fatal
  file_path: logs/kobot.log
  console_enabled: true # 是否输出到控制台
  rotation:
    enabled: true # 是否启用日志轮转（生产环境必备）
    max_size: 10M # 单个日志文件最大大小（支持 K/M/G 单位）
    max_files: 30 # 保留日志文件最大数量
    compress: true # 是否压缩旧日志文件（.gz 格式）
  separate_error_log: true # 是否单独记录错误日志到 kobot-error.log
```

生产环境日志最佳实践：

- 始终启用 `rotation.enabled` 和 `separate_error_log`
- 建议设置 `max_size` 为 10-20M，`max_files` 根据需求保留 7-30 天
- 生产环境可将 `console_enabled` 设为 false，减少 I/O 开销
- 使用结构化日志格式便于后续分析和监控

## 开发

### 本地开发

```bash
# 安装依赖（pnpm workspace）
pnpm install

# 开发模式运行
pnpm run dev

# 编译 TypeScript
pnpm run build

# 运行测试
pnpm test

# 类型检查
pnpm run lint
```

### 项目脚本

| 命令              | 说明                |
| --------------- | ----------------- |
| `pnpm run dev`  | 开发模式（使用 tsx 直接运行） |
| `pnpm run build` | 编译到 dist/ 目录      |
| `pnpm start`    | 生产模式运行            |
| `pnpm test`     | 运行测试              |
| `pnpm run lint` | TypeScript 类型检查   |
| `pnpm build:agentpack` | 构建 agentpack 子包 |

### 详细文档

- [开发指南](docs/development.md)
- [飞书集成](docs/feishu.md)
- [上下文压缩策略设计](docs/context-compression.md)
- [循环检测设计](docs/loop-detector.md)

## 许可证

MIT
