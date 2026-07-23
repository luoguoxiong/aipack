# Kobot

<p align="center">
  <img src="image/logo.png" alt="Kobot logo" width="200">
</p>

一个轻量级的个人 AI 助手框架，基于 [`pi-agent`](https://github.com/earendil-works/pi) 构建。

## 特性

- **多模型支持** — 内置 OpenAI、Anthropic、DeepSeek、Groq、Google Gemini 等多家模型提供商支持
- **交互式 CLI** — 开箱即用的命令行交互界面，支持会话管理和历史记录
- **Webhook 集成** — 可通过 HTTP API 接入第三方服务
- **丰富的工具集** — 文件系统操作、Shell 执行、网络搜索和爬取、记忆管理、定时任务等
- **会话持久化** — 支持内存和文件两种会话存储方式，可恢复对话历史
- **容错机制** — 工具执行自动重试、健康监控、友好的错误提示
- **结构化日志** — 基于 pino 的分级日志系统，支持文件和控制台输出

## 快速开始

### 安装

```bash
# 全局安装
npm install -g kobot-pi

# 或者从源码运行
git clone git@github.com:your/kobot.git
cd kobot
npm install
npm run build
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

启动后进入交互式命令行界面：

```
🐈 CLI channel started
Type "exit" or "quit" to exit
Type "help" for available commands
---
kobot>
```

### 内置命令

| 命令 | 说明 |
|------|------|
| `help` | 显示帮助信息 |
| `tools` | 列出所有可用工具 |
| `sessions` | 列出所有会话 |
| `session <key>` | 查看会话详细信息 |
| `use <key>` | 切换到指定会话（恢复历史记录） |
| `exit` / `quit` | 退出 |

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

## 配置

Kobot 的配置文件位于 `~/.kobot/config.yaml`。首次启动时如文件不存在会自动创建默认配置。

### 完整配置参考

```yaml
# ~/.kobot/config.yaml
schema_version: 1
workspace: ~/.kobot

agents:
  defaults:
    workspace: workspace          # 默认工作空间
    model: deepseek-v4-flash      # 默认模型
    provider: auto                # 模型提供商（auto 为自动选择）
    max_tokens: 8192
    context_window_tokens: 200000
    temperature: 0.1
    max_tool_iterations: 200      # 单次任务最大工具调用次数
    bot_name: kobot
    bot_icon: 🐈
    unified_session: false
    disabled_skills: []
    timezone: Asia/Shanghai

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

providers:
  defaults: {}
  items:
    - name: openai
      base_url: https://api.openai.com/v1
      api_key: "${OPENAI_API_KEY}"

tools:
  filesystem:
    enabled: true
    workspace_only: true           # 限制文件操作在工作空间内
    max_file_size_mb: 10
  shell:
    enabled: true
    workspace_only: true
    timeout_sec: 120
  web:
    enabled: true
    search_provider: ddg           # 搜索引擎（ddg= DuckDuckGo）
    fetch_timeout_sec: 30
    max_search_results: 5

memory:
  enabled: true
  base_dir: memory

sessions:
  storage: file                    # 会话持久化方式（memory 或 file）
  storage_path: sessions

logging:
  level: info
  file_path: logs/kobot.log
  console_enabled: true

security:
  workspace_access: allow          # 工作空间访问策略
  network_access: true
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
│   ├── agent/          # Agent 生命周期管理
│   │   ├── context.ts  # 系统提示词构建
│   │   ├── hook.ts     # 事件钩子系统
│   │   └── types.ts    # 钩子类型定义
│   ├── channels/       # 交互渠道
│   │   ├── cli.ts      # 命令行界面
│   │   ├── webhook.ts  # Webhook HTTP 服务
│   │   └── types.ts    # 渠道类型定义
│   ├── config/         # 配置子系统
│   │   ├── schema.ts   # Zod 配置模式定义
│   │   ├── loader.ts   # 配置加载和保存
│   │   └── paths.ts    # 路径解析工具
│   ├── storage/        # 持久化存储
│   │   ├── file.ts     # 文件存储实现
│   │   ├── memory.ts   # 内存存储实现
│   │   ├── session-manager.ts  # 会话管理器
│   │   └── types.ts    # 存储类型定义
│   ├── tools/          # 工具集
│   │   ├── base.ts     # 工具基类（容错、重试、健康监控）
│   │   ├── types.ts    # 工具类型定义
│   │   ├── registry.ts # 工具注册中心
│   │   ├── filesystem.ts  # 文件系统工具
│   │   ├── shell.ts    # Shell 命令工具
│   │   ├── web.ts      # 网络工具
│   │   ├── search.ts   # 搜索工具
│   │   ├── memory.ts   # 记忆管理工具
│   │   ├── cron.ts     # 定时任务工具
│   │   └── utilities.ts # 通用工具
│   ├── utils/
│   │   └── logger.ts   # 日志系统
│   ├── kobot.ts        # 核心 Kobot 类
│   ├── cli.ts          # CLI 入口
│   ├── setup-wizard.ts # 设置向导
│   ├── index.ts        # 公共导出
│   └── types.ts        # 全局类型
├── tests/
│   └── kobot.test.ts   # 测试
├── package.json
└── tsconfig.json
```

### 核心模块

#### Kobot 类

`Kobot` 是框架的核心类，负责初始化 Agent、管理工具注册、处理会话和消息流。

- `Kobot.fromConfig()` — 从配置文件初始化
- `run()` — 同步处理消息
- `stream()` — 流式处理消息（支持实时事件推送）
- 会话管理：`listSessions()`、`getSessionDetail()`、`deleteSession()`

#### 流式事件

`stream()` 方法通过 AsyncGenerator 产生以下事件：

| 事件类型 | 说明 |
|---------|------|
| `run_started` / `run_completed` / `run_failed` | 运行生命周期 |
| `text_delta` / `text_completed` | 文本流式输出 |
| `reasoning_delta` / `reasoning_completed` | 推理过程输出 |
| `tool_started` / `tool_completed` / `tool_failed` | 工具执行事件 |
| `file_edit` | 文件编辑事件 |

## 可用工具

| 工具名称 | 分类 | 说明 |
|---------|------|------|
| `read_file` | 文件系统 | 读取文件内容 |
| `write_file` | 文件系统 | 写入文件 |
| `edit_file` | 文件系统 | 编辑文件 |
| `delete_file` | 文件系统 | 删除文件 |
| `rename_file` | 文件系统 | 重命名文件 |
| `create_directory` | 文件系统 | 创建目录 |
| `remove_directory` | 文件系统 | 删除目录 |
| `list_directory` | 文件系统 | 列出目录内容 |
| `shell` | Shell | 执行 Shell 命令 |
| `web_search` | 网络 | 搜索引擎查询 |
| `web_fetch` | 网络 | 抓取网页内容 |
| `memory_save` | 记忆 | 保存记忆 |
| `memory_load` | 记忆 | 加载记忆 |
| `memory_list` | 记忆 | 列出记忆 |
| `memory_delete` | 记忆 | 删除记忆 |
| `echo` | 通用 | 回显文本 |
| `get_time` | 通用 | 获取当前时间 |
| `calculate` | 通用 | 数学计算 |
| `encode_base64` | 通用 | Base64 编码 |
| `decode_base64` | 通用 | Base64 解码 |
| `cron_add` | 定时任务 | 添加定时任务 |
| `cron_remove` | 定时任务 | 移除定时任务 |
| `cron_list` | 定时任务 | 列出定时任务 |
| `grep` | 搜索 | 搜索文件内容 |
| `glob` | 搜索 | 按模式匹配文件 |

## 会话管理

Kobot 支持会话持久化，保存对话历史和工具调用记录。

### 存储配置

```yaml
sessions:
  storage: file          # 文件存储（持久化）
  storage_path: sessions # 存储路径（相对于 workspace）
```

默认使用 `file` 存储类型，会话文件保存在 `~/.kobot/sessions/` 目录。

### 会话操作

```bash
# 列出所有会话
kobot> sessions

# 查看会话详情
kobot> session sdk:default

# 切换会话（恢复历史）
kobot> use sdk:default
```

会话记录包含：
- 模型变更（provider、modelId）
- 用户消息和 AI 回复
- 工具调用输入和结果
- Token 用量统计

## 开发

### 本地开发

```bash
# 安装依赖
npm install

# 开发模式运行
npm run dev

# 编译 TypeScript
npm run build

# 运行测试
npm test

# 类型检查
npm run lint
```

### 项目脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发模式（使用 tsx 直接运行） |
| `npm run build` | 编译到 dist/ 目录 |
| `npm start` | 生产模式运行 |
| `npm test` | 运行测试 |
| `npm run lint` | TypeScript 类型检查 |

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
  if (event.type === 'text_delta') {
    process.stdout.write(event.content || '');
  }
}

// 自定义会话
await bot.run('消息', { sessionKey: 'my-session' });

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
  level: info             # trace / debug / info / warn / error / fatal
  file_path: logs/kobot.log
  console_enabled: true   # 是否输出到控制台
```

## 许可证

MIT
