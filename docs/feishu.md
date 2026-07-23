# 飞书机器人接入指南

## 概述

Kobot 内置了飞书机器人渠道（`FeishuChannel`），可对接飞书开放平台的事件回调 API，实现与飞书用户的私聊和群聊交互。

## 前置准备

- 一个飞书**企业自建应用**的管理员权限（或能创建应用的权限）
- Kobot 已安装并能在本地运行
- （可选）内网穿透工具如 [ngrok](https://ngrok.com/)，用于本地开发时接收飞书回调

## 步骤

### 1. 在飞书开放平台创建自建应用

1. 登录 [飞书开放平台](https://open.feishu.cn/)，进入**开发者后台**
2. 点击**创建应用** → **企业自建应用**
3. 填写应用名称和描述，创建完成后进入应用详情页
4. 在**凭证与基础信息**页面，获取 **App ID** 和 **App Secret**（后续配置环境变量需要）

### 2. 开启机器人能力

1. 在左侧菜单选择**应用功能** → **机器人**
2. 将**机器人能力**开关打开
3. 在**消息卡片请求网址**中填入：`http://your-server:3000/webhook/event`（URL 格式参见第 4 步说明）

### 3. 配置事件回调 URL

1. 在左侧菜单选择**事件与回调** → **回调配置**
2. 设置**回调 URL**，格式为 `http://your-server:{port}{path}`：
   - 默认 `http://your-server:3000/webhook/event`
   - 可通过 `FEISHU_PORT` 和 `FEISHU_PATH` 环境变量自定义
3. 点击**保存**，飞书会发送 `url_verification` 请求验证地址
4. 验证通过后，页面会显示"回调配置成功"

### 4. 订阅消息事件

1. 在**事件与回调**页面，点击**添加事件**
2. 搜索并添加 `im.message.receive_v1`（接收消息事件）
3. 点击**确认添加**

### 5. 配置权限

1. 在左侧菜单选择**权限管理**
2. 添加以下权限：
   - `im:message` — 获取用户发给机器人的消息、给用户发送消息
   - `im:message:send_as_bot` — 以机器人身份发送消息
3. 点击**批量开通**

### 6. 创建应用版本并发布

1. 在左侧菜单选择**版本管理与发布**
2. 创建一个新版本，填写版本号和发布说明
3. 提交审核（企业自建应用通常自动通过）
4. 审核通过后，点击**发布**
5. 发布后，将机器人添加到需要的群聊或个人对话中

> 首次发布后，后续代码修改只需更新版本并重新发布即可。

## 配置 Kobot

### 环境变量

Kobot 通过以下环境变量启用飞书机器人渠道：

| 环境变量            | 说明                      | 默认值           | 是否必需 |
| ------------------- | ------------------------- | ---------------- | -------- |
| `FEISHU_APP_ID`     | 飞书自建应用的 App ID     | -                | 是       |
| `FEISHU_APP_SECRET` | 飞书自建应用的 App Secret | -                | 是       |
| `FEISHU_PORT`       | HTTP 服务监听端口         | `3000`           | 否       |
| `FEISHU_PATH`       | 事件回调路径              | `/webhook/event` | 否       |

同时需要配置至少一个 AI 模型的 API Key，例如：

| 环境变量            | 说明               |
| ------------------- | ------------------ |
| `DEEPSEEK_API_KEY`  | DeepSeek API 密钥  |
| `OPENAI_API_KEY`    | OpenAI API 密钥    |
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 |

### 配置方式

推荐将环境变量写入 `~/.kobot/.env` 文件（Kobot 启动时会自动加载，不覆盖已有的 shell 环境变量）：

```bash
# ~/.kobot/.env
FEISHU_APP_ID=cli_xxxxxxxxxxxxx
FEISHU_APP_SECRET=your-app-secret-here
FEISHU_PORT=3000
DEEPSEEK_API_KEY=your-deepseek-api-key
```

也可在启动时临时设置：

```bash
FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx npm run dev
```

## 启动

```bash
# 开发模式
npm run dev

# 生产模式
npm run build && npm start
```

启动后看到以下日志即表示飞书机器人运行成功：

```
Starting Kobot...
💬 [Feishu] Feishu channel started on http://localhost:3000/webhook/event
```

### 内网穿透（本地开发）

飞书回调 URL 需要 Kobot 服务能被飞书服务器访问。本地开发时推荐使用 [ngrok](https://ngrok.com/)：

```bash
ngrok http 3000
```

获取 ngrok 生成的公网 URL（如 `https://xxxx.ngrok.io`），然后在飞书开放平台的回调配置中填入：

```
https://xxxx.ngrok.io/webhook/event
```

## 消息处理流程

```
用户发送消息
    │
    ▼
飞书服务器 ──POST 回调──► Kobot (Express)
    │                           │
    │                    url_verification? ── 返回 challenge
    │                           │
    │                    im.message.receive_v1?
    │                           │
    │                    返回 { code: 0 } (立即响应)
    │                           │
    │                    异步处理消息
    │                           │
    │                    调用 Kobot.stream() 获取 AI 回复
    │                           │
    │                    POST 回复消息到飞书 API
    │                           │
    ◄──── 回复发送到聊天 ───────┘
```

关键点：

- 仅处理文本消息（`message_type === 'text'`），其他类型（图片、文件等）自动忽略
- 回复使用飞书消息 API 的 `reply` 模式，以纯文本（`msg_type: text`）格式发送
- 每个群聊/私聊使用独立的会话（session key 格式：`feishu:{chatId}`）

## 限制与注意事项

1. **仅支持文本消息**：图片、文件、语音等消息类型会被忽略
2. **不支 Markdown**：回复使用飞书 `text` 格式发送，不支持富文本或 Markdown
3. **异步处理**：消息事件会立即返回 `{ code: 0 }` 避免飞书超时重试，实际的 AI 处理在后台异步进行
4. **消息长度限制**：飞书单条消息有长度上限，超长回复可能会被截断
5. **网络要求**：Kobot 服务需要能被飞书服务器访问，生产环境需部署到公网可达的服务器

## 常见问题

### 回调配置验证失败

检查以下事项：

- Kobot 服务是否已启动并可访问（`curl http://localhost:3000/health` 应返回 `{"status":"ok"}`）
- 内网穿透（ngrok）是否运行正常
- 回调 URL 是否与 `FEISHU_PATH` 和 `FEISHU_PORT` 一致
- 防火墙是否放行了对应端口

### 机器人不回复消息

检查以下事项：

- 飞书应用是否已发布并添加到群聊/个人对话
- 环境变量 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 是否正确
- Kobot 启动日志中是否有错误信息
- AI 模型 API Key 是否配置正确且余额充足

### 回复内容异常

- 检查 Kobot 控制台日志中的 `💬 [Feishu]` 输出，确认消息接收和回复是否正常
- 如果看到 `❌ [Feishu] Processing error` 日志，检查 AI 模型 API 的可用性
