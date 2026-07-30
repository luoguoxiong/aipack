# Kobot 开发指南

## 项目结构

```
kobot/
├── src/
│   ├── agent/           # Agent 生命周期管理
│   │   ├── context.ts   # 系统提示词构建
│   │   ├── hook.ts      # 事件钩子系统
│   │   └── types.ts     # 钩子接口定义
│   ├── channels/        # 交互渠道
│   │   ├── cli.ts       # 命令行界面 (CLI)
│   │   ├── webhook.ts   # Webhook HTTP 服务
│   │   └── types.ts     # 渠道接口和配置类型
│   ├── config/          # 配置子系统
│   │   ├── schema.ts    # Zod 配置模式
│   │   ├── loader.ts    # 配置加载/保存
│   │   └── paths.ts     # 路径解析
│   ├── storage/         # 持久化存储
│   │   ├── file.ts      # 文件存储（含文件锁、原子写入）
│   │   ├── memory.ts    # 内存存储
│   │   ├── session-manager.ts  # 会话管理器
│   │   └── types.ts     # 存储接口定义
│   ├── tools/           # 工具集
│   │   ├── base.ts      # 工具基类（容错、重试、健康监控）
│   │   ├── types.ts     # 工具类型定义
│   │   ├── registry.ts  # 工具注册中心
│   │   ├── filesystem.ts    # 文件系统操作
│   │   ├── shell.ts     # Shell 命令
│   │   ├── web.ts       # 网络搜索和抓取
│   │   ├── search.ts    # 内容搜索
│   │   ├── memory.ts    # 记忆管理
│   │   ├── cron.ts      # 定时任务
│   │   ├── apply_patch.ts  # 代码补丁
│   │   ├── scheduler.ts    # 任务调度
│   │   ├── self.ts      # 运行时自省
│   │   ├── message.ts   # 消息推送
│   │   └── utilities.ts # 通用工具
│   ├── utils/
│   │   └── logger.ts    # 日志系统（pino）
│   ├── kobot.ts         # 核心 Kobot 类
│   ├── cli.ts           # CLI 入口
│   ├── setup-wizard.ts  # 首次设置向导
│   ├── index.ts         # 公共导出
│   └── types.ts         # 全局类型
├── tests/
│   └── kobot.test.ts    # 测试用例
├── package.json
├── tsconfig.json
└── README.md
```

## 开发环境

### 要求

- Node.js >= 18.0.0
- npm >= 8.0.0

### 本地开发

```bash
# 克隆并安装
git clone git@github.com:your/kobot.git
cd kobot
npm install

# 开发模式运行（tsx 热加载）
npm run dev

# 编译
npm run build

# 运行测试
npm test

# 类型检查
npm run lint
```

### 调试

使用 VS Code 调试配置（`.vscode/launch.json`）：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Kobot",
      "runtimeArgs": ["--import", "tsx"],
      "program": "${workspaceFolder}/src/cli.ts"
    }
  ]
}
```

## 架构概览

### 核心数据流

```
用户输入
  │
  ▼
Channel (CLI / Webhook)
  │
  ▼
Kobot.stream() ───► Agent.prompt()
  │                       │
  │                       ▼
  │                  Agent 核心
  │                  (消息循环、工具调用)
  │                       │
  │                       ▼
  │                  ToolRegistry
  │                  (工具查找、参数校验、执行)
  │                       │
  │                       ▼
  │                  BaseTool.safeExecute()
  │                  (重试、健康监控)
  │
  ▼
AsyncGenerator<StreamEvent>
  │
  ▼
Channel 输出（控制台 / HTTP 响应）
```

### 核心模块详解

#### Kobot 类（[src/kobot.ts](../src/kobot.ts)）

`Kobot` 是框架的入口和核心协调器。

```typescript
class Kobot {
  // 从配置文件初始化
  static async fromConfig(options?: KobotOptions): Promise<Kobot>

  // 同步运行（等待完整结果）
  async run(message: string, options?: RunOptions): Promise<RunResult>

  // 流式运行（逐事件推送）
  stream(message: string, options?: RunOptions): AsyncGenerator<StreamEvent>

  // 会话管理
  listSessions(): Promise<string[]>
  getSessionDetail(key: string): Promise<SessionDetail | null>
  deleteSession(key: string): Promise<boolean>
}
```

**关键设计点：**

- `fromConfig()` 负责完整初始化流程：加载配置 → 初始化日志 → 注册工具 → 初始化模型
- `stream()` 使用 Agent 的事件订阅机制，将 Agent 内部事件转换为 Kobot 的 `StreamEvent`
- 会话管理通过 `SessionManager` 委托给具体的 `StorageAdapter`

#### BaseTool（[src/tools/base.ts](../src/tools/base.ts)）

所有工具的抽象基类，提供统一的容错机制。

```typescript
abstract class BaseTool<TParameters extends TSchema> {
  abstract name: string
  abstract label: string
  abstract description: string
  abstract parameters: TParameters

  // 容错配置
  retryConfig: RetryConfig = {
    maxRetries: 3,
    initialDelay: 1000,
    backoffFactor: 2,
  }

  // 核心执行方法
  abstract execute(
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback,
  ): Promise<AgentToolResult>

  // 带容错的执行包装
  async safeExecute(
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback,
  ): Promise<AgentToolResult>
}
```

**容错机制：**

1. **自动重试** — 对网络超时、429、5xx 等可恢复错误进行指数退避重试
2. **错误分类** — 区分可重试错误（timeout、429、5xx）和不可重试错误（permission、404、400）
3. **健康监控** — 跟踪每个工具的成功/失败率，连续 5 次失败标记为不健康
4. **友好错误** — 将原始错误转换为用户友好的中文提示

#### ToolRegistry（[src/tools/registry.ts](../src/tools/registry.ts)）

工具的注册中心和执行调度器：

```typescript
class ToolRegistry {
  register(tool: BaseTool): void
  registerMany(tools: BaseTool[]): void
  getAgentTools(): AgentTool<TSchema>[]
  executeTool(toolName, toolCallId, args, context, options?): Promise<ToolResult>
  getExecutionHistory(): ToolExecutionRecord[]
}
```

#### SessionManager（[src/storage/session-manager.ts](../src/storage/session-manager.ts)）

会话管理，支持内存和文件两种存储后端：

```
SessionManager
  ├── MemoryStorageAdapter    # 内存存储（易失）
  └── FileStorage             # 文件存储（JSON 文件，带文件锁）
```

#### Channel（[src/channels/](../src/channels/)）

交互渠道接口，将 Kobot 连接到不同的用户界面：

```typescript
interface Channel {
  id: string
  name: string
  start(bot: Kobot): Promise<void>
  stop(): Promise<void>
  sendMessage(chatId: string, content: string): Promise<ChannelResponse>
}
```

内置渠道：
- **CLIChannel** — 交互式命令行界面，支持 readline 历史、会话管理命令
- **WebhookChannel** — HTTP 服务，通过 POST 接收消息并返回 AI 回复

## 添加新工具

### 1. 创建工具类

在 `src/tools/` 下创建工具文件，继承 `BaseTool`：

```typescript
// src/tools/weather.ts
import { Type } from "../pi/ai";
import { BaseTool, createToolResult, createToolError } from './base';

export class GetWeatherTool extends BaseTool<typeof GetWeatherTool.parameters> {
  name = 'get_weather';
  label = 'Get Weather';
  description = '获取指定城市的天气信息';
  static parameters = Type.Object({
    city: Type.String({ description: '城市名称' }),
  });
  parameters = GetWeatherTool.parameters;

  async execute(toolCallId: string, params: { city: string }) {
    try {
      const response = await fetch(
        `https://api.weather.com/current?city=${params.city}`
      );
      const data = await response.json();
      return createToolResult(JSON.stringify(data));
    } catch (err) {
      return createToolError(`Failed to get weather: ${(err as Error).message}`);
    }
  }
}

export function getWeatherTools(): BaseTool[] {
  return [new GetWeatherTool()];
}
```

### 2. 注册工具

在 `src/tools/registry.ts` 中注册：

```typescript
import { getWeatherTools } from './weather';

// 在 createDefaultToolRegistry 中添加：
if (opts.weather) registry.registerMany(getWeatherTools());
```

## 添加新渠道

实现 `Channel` 接口：

```typescript
// src/channels/slack.ts
import type { Channel, ChannelResponse } from './types';
import type { Kobot } from '../kobot';

interface SlackConfig {
  id: string;
  name: string;
  token: string;
  channel: string;
}

export class SlackChannel implements Channel {
  id: string;
  name: string;
  private config: SlackConfig;
  private bot: Kobot | null = null;

  constructor(config: SlackConfig) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
  }

  async start(bot: Kobot): Promise<void> {
    this.bot = bot;
    // 初始化 Slack 客户端并订阅消息
  }

  async stop(): Promise<void> {
    // 清理资源
  }

  async sendMessage(chatId: string, content: string): Promise<ChannelResponse> {
    // 发送消息到 Slack
    return { status: 'success' };
  }
}
```

## 测试

### 运行测试

```bash
# 运行所有测试
npm test

# 运行特定测试文件
node --import tsx --test tests/kobot.test.ts
```

### 测试约定

测试使用 Node.js 内置的 `node:test` 和 `node:assert`。测试文件位于 `tests/` 目录，使用 `.test.ts` 后缀。

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Kobot } from '../src/kobot';

describe('Kobot', () => {
  it('should create instance from config', async () => {
    const bot = await Kobot.fromConfig();
    assert.ok(bot);
    assert.ok(bot.tools.length > 0);
    await bot.close();
  });
});
```

## 打包发布

```bash
# 编译
npm run build

# 发布到 npm
npm publish
```

包名为 `kobot-pi`，提供全局 `kobot` 命令：

```bash
kobot  # 启动 Kobot CLI
```

## 常见任务

### 自定义系统提示词

修改 `src/agent/context.ts` 中的 `buildSystemPrompt()` 方法：

```typescript
buildSystemPrompt(): string {
  return `你是 ${this.botIcon} ${this.botName}，一个有用的 AI 助手。
  
自定义规则：
- 始终使用中文回复
- 对代码问题提供详细解释
- ...`;
}
```

### 添加模型提供商

在 `config.yaml` 的 `providers` 中添加：

```yaml
providers:
  items:
    - name: my-provider
      base_url: https://api.myprovider.com/v1
      api_key: "${MY_PROVIDER_API_KEY}"
      default_model: my-model
```

支持的提供商会自动通过内置的 `builtinModels()` 发现。

### 切换模型运行时

```typescript
const bot = await Kobot.fromConfig({ model: 'gpt-4o-mini' });
// 或使用预设
const bot = await Kobot.fromConfig({ modelPreset: 'fast' });
```

## 错误处理

Kobot 实现了一个多层次的错误处理系统：

1. **工具层** — `BaseTool.safeExecute()` 自动重试和错误分类
2. **Agent 层** — Agent 的事件订阅和错误传递
3. **渠道层** — CLI/Webhook 对 `STREAM_EVENT_RUN_FAILED` 做出响应
4. **用户层** — 友好的错误提示和排查建议

### 错误分类

| 错误类型 | 示例 | 处理方式 |
|---------|------|---------|
| 可重试 | timeout, 429, 5xx | 指数退避重试（最多 3 次） |
| 不可重试 | permission, 404, 400 | 直接返回错误，不重试 |
| 未知 | 其他异常 | 重试仍失败后返回友好提示 |
