# 配置指南

本文档详细说明 Nanobot 配置文件的所有配置项。配置文件位于 `~/.nanobot/config.json`（首次启动自动创建）。

## 配置文件结构概览

```json
{
  "schema_version": 1,
  "agents": { ... },
  "providers": { ... },
  "channels": { ... },
  "tools": { ... },
  "memory": { ... },
  "transcription": { ... },
  "cron": { ... },
  "gateway": { ... },
  "api": { ... },
  "security": { ... }
}
```

## 一、`agents` - Agent 配置

### 1.1 `agents.defaults` - 默认 Agent 配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `workspace` | string | `.nanobot/workspace` | Agent 的工作目录 |
| `model_preset` | string \| null | null | 使用的模型预设名称 |
| `model` | string | `anthropic/claude-opus-4-5` | 默认使用的模型 |
| `provider` | string | `auto` | Provider 类型（auto/openai/anthropic/deepseek/...） |
| `max_tokens` | number | 8192 | 单次响应最大 token 数 |
| `context_window_tokens` | number | 200000 | 上下文窗口大小 |
| `temperature` | number | 0.1 | 温度参数（0-1，越高越随机） |
| `fallback_models` | array | [] | 降级模型列表 |
| `max_tool_iterations` | number | 200 | ReAct 循环最大迭代次数 |
| `max_concurrent_subagents` | number | 1 | 最大并发子 Agent 数量 |
| `fail_on_tool_error` | boolean | true | 工具执行失败是否终止任务 |
| `max_tool_result_chars` | number | 16000 | 工具结果最大字符数 |
| `provider_retry_mode` | string | `standard` | 重试模式（standard/persistent） |
| `tool_hint_max_length` | number | 40 | 工具提示最大长度 |
| `timezone` | string | `UTC` | 时区 |
| `bot_name` | string | `nanobot` | Bot 名称 |
| `bot_icon` | string | `🐈` | Bot 图标（Emoji） |
| `unified_session` | boolean | false | 是否所有渠道共用一个会话 |
| `disabled_skills` | array | [] | 禁用的技能列表 |

### 1.2 `agents.model_presets` - 模型预设

可以定义多个模型预设，通过 `model_preset` 字段引用：

```json
{
  "model_presets": {
    "fast": {
      "label": "快速响应",
      "model": "deepseek/deepseek-v4-flash",
      "provider": "deepseek",
      "max_tokens": 8192,
      "context_window_tokens": 64000,
      "temperature": 0.1
    },
    "quality": {
      "label": "高质量",
      "model": "deepseek/deepseek-v4",
      "provider": "deepseek",
      "max_tokens": 8192,
      "context_window_tokens": 128000,
      "temperature": 0.7
    }
  }
}
```

### 1.3 `agents.instances` - Agent 实例

可以定义多个 Agent 实例，每个实例可以覆盖默认配置：

```json
{
  "instances": {
    "code-assistant": {
      "model": "deepseek/deepseek-v4-coder",
      "workspace": "~/projects",
      "max_tool_iterations": 50
    }
  }
}
```

## 二、`providers` - LLM Provider 配置

### 2.1 `providers.defaults` - 默认 Provider 配置

```json
{
  "defaults": {}
}
```

### 2.2 `providers.items` - Provider 列表

每个 Provider 支持以下配置：

| 配置项 | 类型 | 说明 |
|--------|------|------|
| `name` | string | Provider 名称（必填） |
| `base_url` | string | API 基础 URL |
| `api_key` | string | API Key |
| `api_base` | string | 备用 API 基础 URL |
| `default_model` | string | 默认模型 |
| `extra_headers` | object | 额外请求头 |
| `extra_query` | object | 额外查询参数 |
| `extra_body` | object | 额外请求体参数 |

**示例配置：**

```json
{
  "providers": {
    "items": [
      {
        "name": "deepseek",
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "your-api-key",
        "default_model": "deepseek-v4-flash"
      },
      {
        "name": "openai",
        "base_url": "https://api.openai.com/v1",
        "api_key": "your-openai-key",
        "default_model": "gpt-4o-mini"
      },
      {
        "name": "anthropic",
        "base_url": "https://api.anthropic.com/v1",
        "api_key": "your-anthropic-key",
        "default_model": "claude-3-5-sonnet-20241022"
      }
    ]
  }
}
```

## 三、`channels` - 渠道配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `send_progress` | boolean | true | 是否发送进度事件 |
| `send_tool_hints` | boolean | false | 是否发送工具提示 |
| `show_reasoning` | boolean | true | 是否显示思考过程 |
| `extract_document_text` | boolean | true | 是否提取文档文本 |
| `send_max_retries` | number | 3 | 发送最大重试次数 |
| `transcription_provider` | string | `groq` | 语音转文字 Provider |
| `transcription_language` | string | null | 语音转文字语言（如 zh、en） |

## 四、`tools` - 工具配置

### 4.1 `tools.filesystem` - 文件系统工具

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | true | 是否启用 |
| `workspace_only` | boolean | true | 是否仅限工作目录 |
| `allowed_patterns` | array | [] | 允许的文件路径模式 |
| `denied_patterns` | array | [] | 禁止的文件路径模式 |
| `max_file_size_mb` | number | 10 | 最大文件大小（MB） |

### 4.2 `tools.shell` - Shell 执行工具

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | true | 是否启用 |
| `workspace_only` | boolean | true | 是否仅限工作目录 |
| `allowed_patterns` | array | [] | 允许的命令模式 |
| `denied_patterns` | array | [] | 禁止的命令模式 |
| `timeout_sec` | number | 120 | 超时时间（秒） |
| `shell` | string | null | 指定 shell 类型 |
| `sandbox_backend` | string | `none` | 沙箱后端（none/docker） |

### 4.3 `tools.web` - Web 工具

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | true | 是否启用 |
| `search_provider` | string | `ddg` | 搜索 Provider（ddg/serper/tavily） |
| `fetch_timeout_sec` | number | 30 | 抓取超时时间（秒） |
| `max_search_results` | number | 5 | 最大搜索结果数 |
| `user_agent` | string | null | 自定义 User-Agent |

### 4.4 `tools.image_generation` - 图像生成工具

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | true | 是否启用 |
| `provider` | string | `auto` | Provider 类型 |
| `model` | string | null | 指定模型 |
| `size` | string | `1024x1024` | 图像尺寸 |
| `quality` | string | `standard` | 图像质量 |

### 4.5 `tools.mcp` - MCP 工具

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | true | 是否启用 |
| `servers` | object | {} | MCP Server 配置 |

**MCP Server 配置示例：**

```json
{
  "mcp": {
    "servers": {
      "weather": {
        "type": "stdio",
        "command": ["python", "weather_mcp_server.py"]
      }
    }
  }
}
```

### 4.6 `tools.my` - 自省工具

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | true | 是否启用 |

### 4.7 `tools.cli_apps` - CLI 应用工具

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | true | 是否启用 |
| `apps` | object | {} | CLI 应用配置 |

**CLI 应用配置示例：**

```json
{
  "cli_apps": {
    "apps": {
      "gh": {
        "command": "gh",
        "description": "GitHub CLI"
      }
    }
  }
}
```

## 五、`memory` - 记忆系统配置

### 5.1 基础配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | true | 是否启用记忆系统 |
| `base_dir` | string | `.nanobot/memory` | 记忆存储目录 |

### 5.2 `memory.dream` - Dream 模式（记忆整理）

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | true | 是否启用 Dream 模式 |
| `interval_h` | number | 2 | 整理间隔（小时） |
| `cron` | string | null | 自定义 cron 表达式 |
| `model_override` | string | null | 覆盖使用的模型 |
| `max_batch_size` | number | 20 | 单次最大批量处理数 |
| `max_iterations` | number | 15 | 最大迭代次数 |
| `annotate_line_ages` | boolean | true | 是否标注行龄 |

## 六、`transcription` - 语音转文字配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | true | 是否启用 |
| `provider` | string | null | 指定 Provider |
| `model` | string | null | 指定模型 |
| `language` | string | null | 指定语言 |
| `max_duration_sec` | number | 120 | 最大时长（秒） |
| `max_upload_mb` | number | 25 | 最大上传大小（MB） |

## 七、`cron` - 定时任务配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | true | 是否启用定时任务 |
| `timezone` | string | `UTC` | 时区 |

## 八、`gateway` - 网关配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | false | 是否启用网关 |
| `host` | string | `127.0.0.1` | 网关监听地址 |
| `port` | number | 8765 | 网关监听端口 |
| `cors_origins` | array | `["http://localhost:5173"]` | CORS 允许的来源 |
| `auth_token` | string | null | 认证 Token |
| `webui_path` | string | null | WebUI 路径 |

## 九、`api` - API 服务配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | false | 是否启用 API 服务 |
| `host` | string | `127.0.0.1` | API 监听地址 |
| `port` | number | 8000 | API 监听端口 |
| `api_keys` | array | [] | API Key 列表（用于认证） |
| `cors_origins` | array | [] | CORS 允许的来源 |

## 十、`security` - 安全配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `workspace_access` | string | `allow` | 工作区访问权限（allow/deny/ask） |
| `network_access` | boolean | true | 是否允许网络访问 |
| `pth_guard` | boolean | true | 是否启用路径遍历防护 |

## 完整配置示例

```json
{
  "schema_version": 1,
  "agents": {
    "defaults": {
      "workspace": ".nanobot/workspace",
      "model": "deepseek/deepseek-v4-flash",
      "provider": "auto",
      "max_tokens": 4096,
      "context_window_tokens": 64000,
      "temperature": 0.3,
      "max_tool_iterations": 30,
      "max_concurrent_subagents": 3,
      "timezone": "Asia/Shanghai",
      "bot_name": "我的助手",
      "bot_icon": "🤖"
    },
    "model_presets": {
      "coding": {
        "label": "代码助手",
        "model": "deepseek/deepseek-v4-coder",
        "provider": "deepseek",
        "temperature": 0.1
      }
    }
  },
  "providers": {
    "items": [
      {
        "name": "deepseek",
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "sk-your-key",
        "default_model": "deepseek-v4-flash"
      }
    ]
  },
  "channels": {
    "send_progress": true,
    "show_reasoning": true
  },
  "tools": {
    "filesystem": {
      "enabled": true,
      "workspace_only": true
    },
    "shell": {
      "enabled": true,
      "timeout_sec": 60
    },
    "web": {
      "enabled": true
    }
  },
  "memory": {
    "enabled": true,
    "dream": {
      "enabled": true,
      "interval_h": 24
    }
  },
  "api": {
    "enabled": true,
    "port": 8000
  },
  "security": {
    "workspace_access": "allow",
    "network_access": true
  }
}
```

## 配置文件位置

| 位置 | 说明 |
|------|------|
| `~/.nanobot/config.json` | 用户级配置（优先） |
| `.nanobot/config.json` | 项目级配置 |

系统会合并多个配置文件，用户级配置优先于项目级配置。

## 热更新

配置文件修改后，部分配置需要重启服务才能生效，部分配置会自动热加载。

| 配置项 | 热加载 |
|--------|--------|
| `agents.defaults.*` | ❌ 需要重启 |
| `providers.items` | ❌ 需要重启 |
| `tools.*` | ✅ 部分支持 |
| `channels.*` | ✅ 支持 |
| `memory.*` | ✅ 支持 |
| `security.*` | ❌ 需要重启 |
| `api.*` | ❌ 需要重启 |