# Nanobot-Ts

一个轻量级个人 AI 助手框架，使用 TypeScript 构建，支持多渠道接入、丰富的工具集和可扩展的技能系统。

> **项目来源**：本项目是基于开源项目 Nanobot 的 TypeScript 移植版本，保留了原项目的核心架构和功能设计，并进行了代码重构和优化。

## ✨ 功能特性

### 🤖 智能 Agent 能力

- **单主 Agent + 按需子 Agent** 架构，支持 ReAct 工具调用循环
- 支持流式响应，实时展示思考过程和工具执行状态
- 内置 18+ 工具：文件系统、Shell 执行、Web 搜索、代码搜索、长期记忆、定时任务等
- 支持 MCP（Model Context Protocol）动态工具接入

### 📡 多渠道支持

- WebUI（基于 React）
- CLI 命令行界面
- HTTP API（OpenAI 兼容）
- WebSocket 实时通信
- 16+ 即时通讯渠道：Telegram、Discord、Slack、飞书、企业微信、微信、WhatsApp、Signal、QQ、钉钉、Email、Matrix、Mattermost、MS Teams 等

### 🧠 LLM Provider 支持

- OpenAI / DeepSeek / OpenAI 兼容 API
- Anthropic Claude
- Azure OpenAI
- AWS Bedrock
- GitHub Copilot
- 支持自动降级和多 Provider 回退

### 🛠️ 技能系统

- 11 个内置技能：GitHub 操作、图像生成、记忆管理、天气查询、摘要生成、tmux 控制、定时任务、技能创建器、我的助手、clawhub、配置更新等
- 支持创建和扩展自定义技能
- 技能自动注入系统提示词，引导 Agent 完成复杂任务

### 🔧 工具集

| 类别     | 工具                                                                             |
| -------- | -------------------------------------------------------------------------------- |
| 文件系统 | `read_file`, `write_file`, `edit_file`, `list_dir`（`apply_patch` 按需加载）     |
| Shell    | `shell_exec`（`exec_session` 按需加载）                                          |
| Web      | `web_search`, `web_fetch`                                                        |
| 代码搜索 | `find_files`, `grep`                                                             |
| 记忆     | `memory_store`, `memory_recall`, `memory_search`, `memory_list`, `memory_delete` |
| 定时任务 | `cron_add`, `cron_list`, `cron_remove`                                           |
| 图像生成 | `generate_image`                                                                 |
| 子 Agent | `spawn`                                                                          |
| 长任务   | `create_goal`, `update_goal`                                                     |
| 消息     | `message`                                                                        |
| 系统     | `system_info`, `my`                                                              |
| MCP      | 动态加载外部工具                                                                 |

## 🚀 快速开始

### 环境要求

- Node.js >= 18.0.0
- npm 或 yarn

### 安装依赖

```bash
# 安装后端依赖
npm install

# 安装 WebUI 依赖
npm run webui:install
```

### 构建项目

```bash
npm run build
```

### 启动服务

#### 使用启动脚本（推荐）

```bash
# 启动 WebUI
./start.sh webui

# 启动 CLI 聊天
./start.sh chat

# 运行单条消息
./start.sh run "帮我分析一下这个项目的代码"
```

#### 开发模式

```bash
# 开发模式启动 WebUI
npm run start:dev-webui

# 开发模式启动 CLI
npm run start:dev-chat
```

### 配置 API Key

首次启动后，配置文件位于 `~/.nanobot/config.json`。需要配置 LLM Provider 的 API Key：

```json
{
  "providers": {
    "items": [
      {
        "name": "deepseek",
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "your-api-key",
        "default_model": "deepseek-chat"
      }
    ]
  }
}
```

## 📖 文档

| 文档                                                         | 说明                           |
| ------------------------------------------------------------ | ------------------------------ |
| [ARCHITECTURE.md](ARCHITECTURE.md)                           | 架构与执行流程说明             |
| [AGENT_TOOLS.md](AGENT_TOOLS.md)                             | Agent 工具完整清单与说明       |
| [CONFIGURATION.md](CONFIGURATION.md)                         | 配置文件完整说明               |
| [API.md](API.md)                                             | HTTP API 和 WebSocket 协议文档 |
| [SKILLS_DEVELOPMENT.md](SKILLS_DEVELOPMENT.md)               | 技能开发指南                   |
| [ARCHITECTURE_OPTIMIZATION.md](ARCHITECTURE_OPTIMIZATION.md) | 架构优化方案                   |
| [TOKEN_OPTIMIZATION.md](TOKEN_OPTIMIZATION.md)               | Token 消耗分析与优化           |

## 📁 项目结构

```
nanobot-ts/
├── src/                    # 后端源码
│   ├── agent/              # Agent 核心逻辑
│   │   ├── tools/          # 工具集（18+ 工具）
│   │   ├── loop.ts         # 主 Agent 循环
│   │   ├── runner.ts       # ReAct 工具调用循环
│   │   ├── subagent.ts     # 子 Agent 管理
│   │   └── skills.ts       # 技能加载器
│   ├── api/                # HTTP API 服务
│   ├── apps/               # CLI 应用服务
│   ├── audio/              # 音频处理
│   ├── bus/                # 消息总线
│   ├── channels/           # 渠道适配器（16+ 渠道）
│   ├── cli/                # 命令行接口
│   ├── command/            # 命令路由
│   ├── config/             # 配置管理
│   ├── cron/               # 定时任务服务
│   ├── gateway/            # 网关服务
│   ├── pairing/            # 配对服务
│   ├── providers/          # LLM Provider
│   ├── sdk/                # SDK 客户端
│   ├── security/           # 安全策略
│   ├── session/            # 会话管理
│   ├── skills/             # 技能运行时
│   ├── triggers/           # 触发器
│   ├── webui/              # WebUI 后端 API
│   └── utils/              # 工具函数
├── webui/                  # WebUI 前端
│   ├── src/
│   │   ├── components/     # React 组件
│   │   ├── hooks/          # React Hooks
│   │   ├── i18n/           # 国际化（10 种语言）
│   │   └── lib/            # 工具库
│   └── package.json
├── skills/                 # 技能目录
│   ├── github/             # GitHub 技能
│   ├── weather/            # 天气技能
│   ├── image-generation/   # 图像生成技能
│   ├── memory/             # 记忆管理技能
│   ├── summarize/          # 摘要生成技能
│   ├── tmux/               # Tmux 控制技能
│   ├── cron/               # 定时任务技能
│   ├── skill-creator/      # 技能创建器
│   └── my/                 # 我的助手技能
├── templates/              # Agent 模板
│   ├── agent/              # Agent 身份和提示词模板
│   ├── memory/             # 记忆模板
│   └── prompts/            # 提示词模板
├── .nanobot/               # 运行时配置和数据
│   ├── config.json         # 配置文件
│   └── workspace/          # 工作目录
└── package.json
```

## 🎯 CLI 命令

```bash
# 启动 WebUI
nanobot webui [-p <port>]

# 启动 CLI 聊天
nanobot chat

# 运行单条消息
nanobot run <message>

# 管理配置
nanobot config init          # 初始化配置
nanobot config show          # 显示当前配置
nanobot config path          # 打印配置文件路径

# 管理会话
nanobot sessions list        # 列出所有会话
nanobot sessions delete <session>

# 列出可用工具
nanobot tools

# 显示帮助
nanobot --help
```

## 🔧 配置说明

核心配置项（详细说明见 [CONFIGURATION.md](CONFIGURATION.md)）：

| 配置项                                | 默认值                    | 说明               |
| ------------------------------------- | ------------------------- | ------------------ |
| `agents.defaults.model`               | anthropic/claude-opus-4-5 | 默认模型           |
| `agents.defaults.provider`            | auto                      | Provider 类型      |
| `agents.defaults.workspace`           | .nanobot/workspace        | 工作目录           |
| `agents.defaults.max_tool_iterations` | 200                       | ReAct 最大迭代次数 |
| `api.port`                            | 8000                      | API 服务端口       |
| `security.workspace_access`           | allow                     | 工作区访问权限     |

## 🌐 多语言支持

WebUI 支持以下语言：

- 中文（简体/繁体）
- English
- Spanish
- French
- Indonesian
- Japanese
- Korean
- Portuguese (Brazil)
- Vietnamese

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！
