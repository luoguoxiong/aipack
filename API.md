# API 文档

本文档详细说明 Nanobot 的 HTTP API 和 WebSocket 协议。

## 基础信息

- **默认地址**: `http://localhost:8000`
- **API 前缀**: `/api`
- **认证**: 通过 `api_keys` 配置项启用 API Key 认证

## 一、HTTP API

### 1.1 OpenAI 兼容接口

#### 1.1.1 列出模型

**GET** `/api/v1/models`

返回可用的模型列表。

**响应示例**:

```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek/deepseek-v4-flash",
      "object": "model",
      "owned_by": "nanobot"
    }
  ]
}
```

#### 1.1.2 聊天补全

**POST** `/api/v1/chat/completions`

提供 OpenAI 兼容的聊天补全接口，支持流式和非流式响应。

**请求体**:

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `messages` | array | 是 | 消息数组，每条消息包含 `role` 和 `content` |
| `stream` | boolean | 否 | 是否流式响应，默认 `false` |
| `model` | string | 否 | 指定模型 |
| `temperature` | number | 否 | 温度参数 |
| `max_tokens` | number | 否 | 最大 token 数 |

**请求示例**:

```json
{
  "messages": [
    { "role": "system", "content": "你是一个助手" },
    { "role": "user", "content": "你好" }
  ],
  "stream": true,
  "model": "deepseek/deepseek-v4-flash"
}
```

**非流式响应示例**:

```json
{
  "id": "chat-xxx",
  "object": "chat.completion",
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "你好！有什么我可以帮你的？"
      },
      "finish_reason": "completed"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 15,
    "total_tokens": 25
  }
}
```

**流式响应**:

流式响应使用 Server-Sent Events (SSE)，每次返回一个 JSON 对象：

```
data: {"id":"chat-xxx","object":"chat.completion.chunk","choices":[{"delta":{"content":"你"},...}]}
data: {"id":"chat-xxx","object":"chat.completion.chunk","choices":[{"delta":{"content":"好"},...}]}
data: [DONE]
```

### 1.2 WebUI 接口

#### 1.2.1 获取设置

**GET** `/api/webui/settings`

返回 WebUI 设置。

**响应示例**:

```json
{
  "theme": "dark",
  "language": "zh-CN",
  "send_progress": true
}
```

#### 1.2.2 更新设置

**PUT** `/api/webui/settings`

更新 WebUI 设置。

**请求体**:

```json
{
  "theme": "light",
  "language": "en"
}
```

#### 1.2.3 获取技能列表

**GET** `/api/webui/skills`

返回可用技能列表。

**响应示例**:

```json
{
  "skills": [
    {
      "name": "github",
      "description": "GitHub 操作技能",
      "tags": ["github", "code"]
    }
  ]
}
```

#### 1.2.4 获取技能详情

**GET** `/api/webui/skills/:name`

返回指定技能的详细信息。

**路径参数**:

| 参数 | 类型 | 说明 |
|------|------|------|
| `name` | string | 技能名称 |

#### 1.2.5 获取会话列表

**GET** `/api/webui/sessions`

返回所有会话列表。

**响应示例**:

```json
{
  "sessions": [
    {
      "id": "chat-xxx",
      "title": "新对话",
      "updated_at": 1710000000
    }
  ]
}
```

#### 1.2.6 删除会话

**DELETE** `/api/webui/sessions/:id`

删除指定会话。

**路径参数**:

| 参数 | 类型 | 说明 |
|------|------|------|
| `id` | string | 会话 ID |

#### 1.2.7 获取会话转录

**GET** `/api/webui/sessions/:id/transcript`

获取指定会话的转录内容。

#### 1.2.8 获取 Token 使用情况

**GET** `/api/webui/token-usage`

返回 Token 使用统计。

**响应示例**:

```json
{
  "daily": {},
  "total": 125000,
  "last_updated": 1710000000
}
```

#### 1.2.9 记录 Token 使用

**POST** `/api/webui/token-usage`

记录 Token 使用量。

**请求体**:

```json
{
  "prompt_tokens": 1000,
  "completion_tokens": 500,
  "total_tokens": 1500,
  "source": "webui"
}
```

#### 1.2.10 获取侧边栏状态

**GET** `/api/webui/sidebar-state`

返回侧边栏状态。

#### 1.2.11 更新侧边栏状态

**PUT** `/api/webui/sidebar-state`

**POST** `/api/webui/sidebar-state/update`

更新侧边栏状态。

#### 1.2.12 版本检查

**GET** `/api/webui/version-check`

检查是否有新版本可用。

**响应示例**:

```json
{
  "updateAvailable": true,
  "currentVersion": "0.2.2",
  "latestVersion": "0.3.0"
}
```

#### 1.2.13 文件预览

**GET** `/api/webui/files/preview`

预览文件内容。

**查询参数**:

| 参数 | 类型 | 说明 |
|------|------|------|
| `path` | string | 文件路径 |

#### 1.2.14 附件上传

**POST** `/api/webui/attachments`

上传附件。

**请求体**: `multipart/form-data`

| 字段 | 类型 | 说明 |
|------|------|------|
| `file` | file | 文件 |

#### 1.2.15 获取附件

**GET** `/api/webui/attachments/:id`

获取指定附件。

#### 1.2.16 删除附件

**DELETE** `/api/webui/attachments/:id`

删除指定附件。

#### 1.2.17 获取工作区信息

**GET** `/api/webui/workspaces`

返回工作区信息。

#### 1.2.18 获取工作区文件列表

**GET** `/api/webui/workspaces/files`

**查询参数**:

| 参数 | 类型 | 说明 |
|------|------|------|
| `path` | string | 目录路径 |

#### 1.2.19 创建目录

**POST** `/api/webui/workspaces/mkdir`

**请求体**:

```json
{
  "path": "new-directory"
}
```

#### 1.2.20 删除文件/目录

**DELETE** `/api/webui/workspaces/files`

**查询参数**:

| 参数 | 类型 | 说明 |
|------|------|------|
| `path` | string | 文件或目录路径 |

#### 1.2.21 读取文件

**GET** `/api/webui/workspaces/files/read`

**查询参数**:

| 参数 | 类型 | 说明 |
|------|------|------|
| `path` | string | 文件路径 |

#### 1.2.22 写入文件

**POST** `/api/webui/workspaces/files/write`

**请求体**:

```json
{
  "path": "file.txt",
  "content": "文件内容",
  "append": false
}
```

#### 1.2.23 重命名文件

**POST** `/api/webui/workspaces/files/rename`

**请求体**:

```json
{
  "oldPath": "old-name.txt",
  "newPath": "new-name.txt"
}
```

### 1.3 自动化接口

#### 1.3.1 列出自动化任务

**GET** `/api/webui/automations`

返回所有自动化任务。

#### 1.3.2 创建自动化任务

**POST** `/api/webui/automations`

**请求体**:

```json
{
  "id": "daily-summary",
  "label": "每日总结",
  "message": "总结今天的工作",
  "schedule": "0 9 * * *",
  "enabled": true
}
```

#### 1.3.3 更新自动化任务

**PUT** `/api/webui/automations/:id`

**请求体**: 同上

#### 1.3.4 删除自动化任务

**DELETE** `/api/webui/automations/:id`

#### 1.3.5 手动触发自动化

**POST** `/api/webui/automations/:id/run`

手动运行指定的自动化任务。

### 1.4 媒体接口

#### 1.4.1 签名媒体路径

**GET** `/api/webui/media/sign`

**查询参数**:

| 参数 | 类型 | 说明 |
|------|------|------|
| `path` | string | 媒体文件路径 |

#### 1.4.2 获取媒体文件

**GET** `/api/webui/media/:signature/*`

通过签名路径获取媒体文件。

## 二、WebSocket 协议

### 2.1 连接地址

| 端点 | 用途 |
|------|------|
| `ws://localhost:8000/api/ws/chat` | 聊天会话 |
| `ws://localhost:8000/api/ws/logs` | 日志流 |
| `ws://localhost:8000/api/ws/transcription` | 语音转文字 |

### 2.2 聊天 WebSocket

#### 2.2.1 客户端发送消息

客户端发送 JSON 格式消息，支持以下类型：

##### `new_chat` - 创建新聊天

```json
{
  "type": "new_chat"
}
```

**服务端响应**:

```json
{
  "event": "attached",
  "chat_id": "chat-uuid"
}
```

##### `attach` - 连接到现有聊天

```json
{
  "type": "attach",
  "chat_id": "chat-uuid"
}
```

**服务端响应**:

```json
{
  "event": "attached",
  "chat_id": "chat-uuid"
}
```

##### `fork_chat` - 创建聊天分支

```json
{
  "type": "fork_chat"
}
```

**服务端响应**:

```json
{
  "event": "attached",
  "chat_id": "chat-new-uuid"
}
```

##### `set_workspace_scope` - 设置工作区范围

```json
{
  "type": "set_workspace_scope",
  "chat_id": "chat-uuid"
}
```

**服务端响应**:

```json
{
  "event": "session_updated",
  "chat_id": "chat-uuid",
  "scope": "metadata"
}
```

##### `message` - 发送消息给 Agent

这是最常用的消息类型，用于触发 Agent 处理。

```json
{
  "type": "message",
  "chat_id": "chat-uuid",
  "content": "帮我分析一下这个项目"
}
```

#### 2.2.2 服务端推送事件

服务端会推送以下事件：

##### `goal_status` - 目标状态变化

```json
{
  "event": "goal_status",
  "chat_id": "chat-uuid",
  "status": "running",
  "started_at": 1710000000
}
```

| status 值 | 说明 |
|-----------|------|
| `running` | Agent 正在处理 |
| `idle` | 处理完成 |

##### `delta` - 文本增量

```json
{
  "event": "delta",
  "chat_id": "chat-uuid",
  "text": "你好"
}
```

##### `reasoning_delta` - 思考过程增量

```json
{
  "event": "reasoning_delta",
  "chat_id": "chat-uuid",
  "text": "我需要分析用户的请求..."
}
```

##### `tool_started` - 工具开始执行

```json
{
  "event": "tool_started",
  "chat_id": "chat-uuid",
  "tool": "read_file",
  "args": {
    "file_path": "package.json"
  },
  "call_id": "call-xxx"
}
```

##### `tool_completed` - 工具执行完成

```json
{
  "event": "tool_completed",
  "chat_id": "chat-uuid",
  "tool": "read_file",
  "result": "{\"name\": \"nanobot-ai\", ...}",
  "call_id": "call-xxx",
  "is_error": false
}
```

##### `file_edit` - 文件编辑事件

```json
{
  "event": "file_edit",
  "chat_id": "chat-uuid",
  "edits": [
    {
      "call_id": "call-xxx",
      "tool": "write_file",
      "path": "test.txt",
      "absolute_path": "/path/to/test.txt",
      "phase": "start",
      "status": "editing",
      "operation": "edit",
      "added": 0,
      "deleted": 0
    }
  ]
}
```

| phase 值 | 说明 |
|----------|------|
| `start` | 开始编辑 |
| `end` | 编辑完成 |
| `error` | 编辑出错 |

##### `turn_end` - 轮次结束

```json
{
  "event": "turn_end",
  "chat_id": "chat-uuid"
}
```

##### `error` - 错误

```json
{
  "event": "error",
  "chat_id": "chat-uuid",
  "detail": "错误描述"
}
```

##### `transcription_error` - 转录错误

```json
{
  "event": "transcription_error",
  "request_id": "req-xxx",
  "detail": "transcription not available"
}
```

### 2.3 日志 WebSocket

连接到 `ws://localhost:8000/api/ws/logs` 可以实时接收服务端日志。

**消息格式**:

```json
{
  "level": "info",
  "message": "Log message",
  "timestamp": 1710000000
}
```

## 三、错误处理

### 3.1 HTTP 错误码

| 状态码 | 说明 |
|--------|------|
| 400 | 请求参数错误 |
| 401 | 未授权（API Key 无效） |
| 403 | 禁止访问 |
| 404 | 资源未找到 |
| 409 | 冲突（如自动化已禁用） |
| 500 | 服务器内部错误 |

### 3.2 错误响应格式

```json
{
  "error": "错误描述"
}
```

## 四、认证

### 4.1 API Key 认证

在 `config.json` 中配置 `api_keys` 后，请求时需要在请求头中携带 API Key：

```
Authorization: Bearer YOUR_API_KEY
```

或者作为查询参数：

```
?api_key=YOUR_API_KEY
```

## 五、CORS

在 `config.json` 的 `api.cors_origins` 中配置允许的来源：

```json
{
  "api": {
    "cors_origins": ["http://localhost:5173", "https://your-domain.com"]
  }
}
```

## 六、完整示例

### 6.1 使用 curl 调用聊天接口

**非流式**:

```bash
curl -X POST http://localhost:8000/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "你好"}
    ],
    "model": "deepseek/deepseek-v4-flash"
  }'
```

**流式**:

```bash
curl -X POST http://localhost:8000/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "你好"}
    ],
    "stream": true
  }'
```

### 6.2 使用 JavaScript 连接 WebSocket

```javascript
const ws = new WebSocket('ws://localhost:8000/api/ws/chat');

ws.onopen = () => {
  // 创建新聊天
  ws.send(JSON.stringify({ type: 'new_chat' }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  switch (data.event) {
    case 'attached':
      console.log('Connected to chat:', data.chat_id);
      // 发送消息
      ws.send(JSON.stringify({
        type: 'message',
        chat_id: data.chat_id,
        content: '帮我分析一下这个项目'
      }));
      break;
    case 'delta':
      console.log('Assistant:', data.text);
      break;
    case 'tool_started':
      console.log('Tool started:', data.tool);
      break;
    case 'tool_completed':
      console.log('Tool result:', data.result);
      break;
    case 'turn_end':
      console.log('Turn ended');
      break;
    case 'error':
      console.error('Error:', data.detail);
      break;
  }
};

ws.onclose = () => {
  console.log('Connection closed');
};
```