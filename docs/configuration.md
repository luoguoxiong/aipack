# Kobot 配置参考

## 配置文件

Kobot 的默认配置文件路径为 `~/.kobot/config.yaml`。首次启动时如文件不存在会自动创建。

配置文件位置可通过 `KOBOT_CONFIG_DIR` 环境变量自定义：

```bash
export KOBOT_CONFIG_DIR="/path/to/config"
# 此时配置文件位于 /path/to/config/config.yaml
```

## 完整配置结构

```yaml
schema_version: 1
workspace: ~/.kobot
```

### agents

Agent 配置，包括默认设置、模型预设和独立实例。

```yaml
agents:
  defaults:
    workspace: workspace          # 工作空间目录（相对 workspace 或绝对路径）
    model: deepseek-v4-flash      # 默认模型 ID
    provider: auto                # 模型提供商（auto 自动选择，可选：openai/anthropic/deepseek/groq/google 等）
    max_tokens: 8192              # 最大输出 token 数
    context_window_tokens: 200000 # 上下文窗口大小
    temperature: 0.1              # 生成温度（0-1）
    context_block_limit: ~        # 最大上下文块数限制（可选）
    fallback_models: []           # 备用模型列表（当主模型不可用时）
    max_tool_iterations: 200      # 单次任务最大工具调用迭代次数
    max_concurrent_subagents: 1   # 最大并发子 agent 数
    fail_on_tool_error: true      # 工具出错时是否终止任务
    max_tool_result_chars: 16000  # 工具结果最大字符数
    provider_retry_mode: standard # 提供商重试模式（standard / persistent）
    reasoning_effort: ~           # 推理努力程度（可选）
    timezone: UTC                 # 时区
    bot_name: kobot               # 机器人名称
    bot_icon: 🐈                  # 机器人图标
    unified_session: false        # 是否使用统一会话
    disabled_skills: []           # 禁用的技能列表

  model_presets:                  # 模型预设（可在运行时切换）
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
      reasoning_effort: high

  instances:                      # 独立 Agent 实例（可覆盖 defaults 的部分字段）
    my-agent:
      model: gpt-4o-mini
      provider: openai
      bot_name: my-bot
```

#### fallback_models

当主模型不可用时自动切换到的备用模型列表。每个条目可以是字符串（模型 ID）或完整配置对象：

```yaml
agents:
  defaults:
    fallback_models:
      - deepseek-v4-flash                          # 字符串形式
      - model: gpt-4o-mini                         # 对象形式
        provider: openai
        max_tokens: 4096
```

### providers

模型提供商配置，用于自定义 API 端点或添加第三方提供商。

```yaml
providers:
  defaults: {}                     # 所有提供商的默认配置
  items:
    - name: openai                 # 提供商名称
      base_url: https://api.openai.com/v1
      api_key: "${OPENAI_API_KEY}" # 支持环境变量引用
      default_model: gpt-4o-mini
      extra_headers: {}            # 自定义 HTTP 头
      extra_query: {}              # 自定义查询参数
      extra_body: {}               # 自定义请求体

    - name: my-custom
      base_url: https://api.example.com/v1
      api_key: "${CUSTOM_API_KEY}"
      default_model: my-model
```

支持的提供商：`openai`、`anthropic`、`deepseek`、`groq`、`google`、`mistral`、`cerebras`、`xai`、`openrouter`、`together`、`fireworks`、`nvidia`、`minimax`、`moonshot`、`kimi`、`zai`、`opencode`、`cloudflare` 等。

### tools

工具配置，控制各工具类别的启用状态和行为。

```yaml
tools:
  filesystem:
    enabled: true                 # 启用文件系统工具
    workspace_only: true          # 限制操作在 workspace 内
    allowed_patterns: []          # 允许的文件模式（空表示全部允许）
    denied_patterns: []           # 拒绝的文件模式
    max_file_size_mb: 10          # 最大文件大小

  shell:
    enabled: true                 # 启用 Shell 执行工具
    workspace_only: true          # 限制命令在 workspace 内执行
    allowed_patterns: []          # 允许的命令模式
    denied_patterns: []           # 拒绝的命令模式
    timeout_sec: 120              # 命令超时时间
    shell: ~                      # 使用的 Shell（默认系统 Shell）
    sandbox_backend: none         # 沙箱后端（none / docker）

  web:
    enabled: true                 # 启用网络工具
    search_provider: ddg          # 搜索引擎（ddg = DuckDuckGo）
    fetch_timeout_sec: 30         # 抓取超时时间
    max_search_results: 5         # 最大搜索结果数
    user_agent: ~                 # 自定义 User-Agent

  image_generation:
    enabled: true                 # 启用图片生成工具
    provider: auto                # 图片生成服务提供商
    model: ~                      # 模型覆盖
    size: 1024x1024               # 默认图片尺寸
    quality: standard             # 图片质量

  mcp:
    enabled: true                 # 启用 MCP（Model Context Protocol）工具
    servers: {}                   # MCP 服务器配置

  cli_apps:
    enabled: true                 # 启用 CLI 应用集成
    apps: {}                      # 应用配置
```

### memory

记忆工具配置。

```yaml
memory:
  enabled: true                   # 启用记忆
  base_dir: memory                # 记忆存储目录（相对于 workspace）
  dream:                          # 记忆自动化（"梦境"机制）
    enabled: true
    interval_h: 2                 # 运行间隔（小时）
    cron: ~                       # Cron 表达式（优先级高于 interval_h）
    model_override: ~             # 模型覆盖
    max_batch_size: 20            # 每批最大处理条目数
    max_iterations: 15            # 最大迭代次数
    annotate_line_ages: true      # 是否标注行期限
```

### sessions

会话持久化配置。

```yaml
sessions:
  storage: file                   # 存储类型（memory / file）
  storage_path: sessions          # 存储路径（相对于 workspace，仅 file 模式有效）
```

- `memory` — 会话数据仅保存在内存中，重启后丢失（默认）
- `file` — 会话数据持久化到磁盘 JSON 文件

### logging

日志配置。

```yaml
logging:
  level: info                     # 日志级别：trace / debug / info / warn / error / fatal
  file_path: logs/kobot.log       # 日志文件路径（相对于 workspace）
  console_enabled: true           # 是否在控制台输出日志
```

### channels

渠道配置。

```yaml
channels:
  send_progress: true             # 发送进度信息
  send_tool_hints: false          # 发送工具提示
  show_reasoning: true            # 显示推理过程
  extract_document_text: true     # 自动提取文档文本
  send_max_retries: 3             # 消息发送最大重试次数
  transcription_provider: groq    # 语音转文字提供商
  transcription_language: ~       # 语音识别语言（如 zh / en）
```

### security

安全配置。

```yaml
security:
  workspace_access: allow         # 工作空间访问策略：allow / deny / ask
  network_access: true            # 是否允许网络访问
  pth_guard: true                 # 路径穿越防护
```

### transcription

语音转文字配置。

```yaml
transcription:
  enabled: true
  provider: ~                     # 提供商（覆盖 channels.transcription_provider）
  model: ~                        # 模型
  language: ~                     # 语言代码
  max_duration_sec: 120           # 最大音频时长（秒）
  max_upload_mb: 25               # 最大上传大小
```

### cron

定时任务配置。

```yaml
cron:
  enabled: true
  timezone: UTC                   # 定时任务时区
```

### gateway

Gateway 服务配置（用于 Web UI 等）。

```yaml
gateway:
  enabled: false
  host: 127.0.0.1
  port: 8765
  cors_origins:
    - http://localhost:5173
  auth_token: ~                   # 认证令牌
  webui_path: ~                   # Web UI 路径
```

### api

HTTP API 服务配置。

```yaml
api:
  enabled: false
  host: 127.0.0.1
  port: 8000
  api_keys: []                    # API 密钥列表
  cors_origins: []                # 允许的 CORS 来源
```

## 模型预设

模型预设可在运行时通过 `KOBOT_MODEL_PRESET` 环境变量或编程方式切换。

```yaml
agents:
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
      reasoning_effort: high
```

## 环境变量

Kobot 支持以下环境变量：

| 变量 | 说明 |
|------|------|
| `KOBOT_CONFIG_DIR` | 配置文件目录（默认为 `~/.kobot`） |
| `KOBOT_MODEL` | 默认模型 ID |
| `KOBOT_MODEL_PRESET` | 默认模型预设名称 |
| `KOBOT_LOG_CONSOLE` | 是否输出日志到控制台（`true` / `false`） |
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥 |
| `OPENAI_API_KEY` | OpenAI API 密钥 |
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 |
| `GROQ_API_KEY` | Groq API 密钥 |
| `GEMINI_API_KEY` | Google Gemini API 密钥 |
| `MISTRAL_API_KEY` | Mistral API 密钥 |
| `CEREBRAS_API_KEY` | Cerebras API 密钥 |
| `XAI_API_KEY` | xAI API 密钥 |
| `OPENROUTER_API_KEY` | OpenRouter API 密钥 |
| `TOGETHER_API_KEY` | Together AI API 密钥 |
| `FIREWORKS_API_KEY` | Fireworks API 密钥 |

API Key 也可通过交互式设置向导配置，会自动持久化到 `~/.kobot/.env` 文件。

## 配置加载流程

1. 确定配置文件路径（默认 `~/.kobot/config.yaml`，或 `KOBOT_CONFIG_DIR`）
2. 如果文件不存在，使用默认配置，并自动创建文件
3. 如果文件存在，使用 `js-yaml` 加载并经过 `Zod` 模式验证
4. 所有相对路径基于 `workspace` 解析为绝对路径
5. 加载 `~/.kobot/.env` 中的环境变量（不覆盖已有 shell 环境变量）
6. 初始化日志记录器
7. 注册默认工具集
