# agentpack-cli

基于 agentpack 框架的 AI 命令行助手。支持交互式聊天、继续历史会话、一次性提问、历史会话回放、会话管理、配置初始化等能力。

## 快速开始

```bash
# 首次使用：运行向导，选择提供商并输入 API Key（写入 ~/.agentpack/.env）
agentpack chat

# 初始化项目级配置文件（交互式生成 agentpack.config.js）
agentpack init --local

# 启动交互式聊天（默认命令）
agentpack chat

# 查看支持的提供商与模型
agentpack models
```

## 命令参考

| 命令                                     | 说明                                                       |
| ---------------------------------------- | ---------------------------------------------------------- |
| `agentpack chat`                         | 启动交互式聊天（默认命令）                                 |
| `agentpack continue <sessionKey>`        | 继续历史会话（恢复上下文后进入交互式聊天）                 |
| `agentpack run [message...]`             | 一次性提问；缺省从标准输入读取消息                         |
| `agentpack init`                         | 初始化配置文件（交互式向导）                               |
| `agentpack models`                       | 列出内置模型（标注 API Key 配置状态）                      |
| `agentpack replay <sessionKey>`          | 在原会话上按顺序重放用户消息以复现问题（结果追加到原会话） |
| `agentpack sessions list`                | 列出所有已持久化的会话                                     |
| `agentpack sessions clear`               | 清空所有会话（`-y` 跳过确认）                              |
| `agentpack sessions delete <sessionKey>` | 删除指定会话                                               |
| `agentpack reset all`                    | 重置所有数据（配置、日志、会话、记忆）                     |
| `agentpack reset config`                 | 重置用户级配置为默认值（删除 config.json 与 .env）         |
| `agentpack reset logs`                   | 清空所有日志文件                                           |
| `agentpack reset sessions`               | 清空所有会话数据                                           |
| `agentpack reset memory`                 | 清空所有记忆数据                                           |

`reset` 与 `sessions clear` 均支持 `-y/--yes` 跳过确认提示。

### 示例

```bash
# 一次性提问
agentpack run "用一句话介绍 agentpack"
echo "翻译成英文：你好" | agentpack run

# 指定提供商 / 模型
agentpack chat -p deepseek -m deepseek-chat
agentpack run -m gpt-4o-mini "1+1=?"

# 项目级 vs 全局配置文件
agentpack init --local       # 生成 <cwd>/agentpack.config.js
agentpack init --global      # 写入 ~/.agentpack/config.json
agentpack init --local --force   # 覆盖已存在的配置文件

# 会话管理
agentpack sessions list
agentpack continue agentpack-xxxxxxxx    # 恢复历史上下文继续对话
agentpack replay agentpack-xxxxxxxx      # 回放某次会话以复现问题
agentpack sessions delete agentpack-xxxxxxxx
```

## 全局选项

| 选项                        | 说明                                                    |
| --------------------------- | ------------------------------------------------------- |
| `-c, --config <path>`       | 指定配置文件路径（.js/.json）；不指定时按优先级自动合并 |
| `-p, --provider <provider>` | 模型提供商（如 deepseek / openai）                      |
| `-m, --model <model>`       | 模型 ID（如 deepseek-chat / gpt-4o-mini）               |
| `--system-prompt <text>`    | 系统提示词（定义 AI 助手角色与行为）                    |
| `-w, --workspace <path>`    | 工作区路径（日志/记忆/AI 上下文基目录）                 |
| `--no-persist`              | 禁用会话持久化（默认持久化）                            |

## 配置文件

支持三种位置，按优先级合并（**项目级高于全局**）：

1. **项目级**：`<cwd>/agentpack.config.js`（优先）或 `<cwd>/agentpack.config.json`
2. **全局**：`~/.agentpack/config.json`（目录可用环境变量 `AGENTPACK_CONFIG_DIR` 修改）

整体优先级（低 → 高）：

```
默认值 < 配置文件 < 环境变量（AGENTPACK_*）< CLI 参数
```

### 完整配置示例（agentpack.config.js）

```js
/**
 * @type {import('agentpack-cli').AgentpackConfigFile}
 */
export default {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  systemPrompt: '你是一名编程助手',

  // 工作区：日志(logs/)、记忆(memory/) 与 AI 上下文基目录，缺省为当前工作目录
  // workspace: '/path/to/project',

  // 会话持久化
  // sessions: {
  //   enabled: true,
  //   baseDir: './sessions',   // 缺省为当前工作目录
  //   maxAge: 30,
  // },

  // 高级：透传给 agentpack Runtime 的选项（.js 配置可 import 模块/类实例）
  // tools: [{ name: 'ping', description: '测试', execute: async () => 'pong' }],
  // extensions: [],
  // transformers: [],
  // pipeline: undefined,
  // sessionStorage: undefined,
};
```

> 推荐使用 `.js` 配置：可直接编写逻辑、import 模块（如 `agentpack` 的 `createFileSessionStorage`、
> `LoggingExtension`）；`.json` 配置只能写纯数据。
> 文件顶部加 `@type {import('agentpack-cli').AgentpackConfigFile}` 注解即可获得
> 字段补全、类型校验与悬停说明。

### 配置字段参考

| 字段               | 类型                 | 默认值          | 说明                                        |
| ------------------ | -------------------- | --------------- | ------------------------------------------- |
| `provider`         | string               | deepseek        | 模型提供商                                  |
| `model`            | string               | 提供商推荐模型  | 模型 ID                                     |
| `systemPrompt`     | string               | 空              | 系统提示词                                  |
| `workspace`        | string               | `process.cwd()` | 工作区路径（日志/记忆/上下文）              |
| `sessions.enabled` | boolean              | `true`          | 是否持久化会话                              |
| `sessions.baseDir` | string               | `process.cwd()` | 会话存储目录                                |
| `sessions.maxAge`  | number               | 不限            | 会话最长保留天数                            |
| `config`           | object               | -               | 透传给 Runtime 的配置对象                   |
| `tools`            | Tool[]               | -               | 自定义工具列表                              |
| `extensions`       | Extension[]          | -               | 扩展插件（如 `LoggingExtension`）           |
| `transformers`     | ContextTransformer[] | -               | 上下文转换器                                |
| `pipeline`         | Pipeline             | -               | 转换流水线                                  |
| `sessionStorage`   | SessionStorage       | 文件存储        | 自定义会话存储（优先于 `sessions.baseDir`） |

### 会话 Key 说明

`sessionKey` 由 CLI **每次启动时自动生成**（格式 `agentpack-<8 位 hex>`），无需也**不应**在配置文件中配置。
每次启动都是一次全新会话；key 会在启动时打印。

需要基于历史继续对话时：

- `agentpack continue <sessionKey>`：恢复该会话的历史上下文，进入交互式聊天，新消息继续追加到原会话；
- `agentpack replay <sessionKey>`：把原会话中所有用户消息按顺序重新发给模型，用于复现/诊断问题，结果同样追加到原会话（不会新建独立会话）。

## API Key 配置

API Key 属于**凭据**，放在环境变量或 `.env` 文件中，**不要**写入 `agentpack.config.js`。

方式一：`.env` 文件（启动时自动加载）

```bash
# 用户级：~/.agentpack/.env（所有项目生效）
# 项目级：<cwd>/.env（优先级更高）
DEEPSEEK_API_KEY=sk-xxxxxxxx
```

变量名规则：`<提供商ID大写>_API_KEY`，如 `DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`。

方式二：shell 环境变量

```bash
export DEEPSEEK_API_KEY="sk-xxx"
```

方式三：首次运行 `agentpack chat`（无任何 Key 时）自动进入设置向导，选择提供商并输入 Key，写入 `~/.agentpack/.env`。

优先级：**shell 环境变量 > `.env` 文件**（`.env` 不会覆盖已存在的环境变量）。

## 环境变量参考

| 变量                      | 说明                                      |
| ------------------------- | ----------------------------------------- |
| `<PROVIDER>_API_KEY`      | 各提供商 API Key（如 `DEEPSEEK_API_KEY`） |
| `AGENTPACK_PROVIDER`      | 默认提供商（覆盖配置文件）                |
| `AGENTPACK_MODEL`         | 默认模型 ID（覆盖配置文件）               |
| `AGENTPACK_SYSTEM_PROMPT` | 默认系统提示词（覆盖配置文件）            |
| `AGENTPACK_WORKSPACE`     | 默认工作区路径（覆盖配置文件）            |
| `AGENTPACK_CONFIG_DIR`    | 全局配置目录，默认 `~/.agentpack`         |

## 数据目录

默认所有数据落在**当前工作目录**（也可通过配置调整）：

| 数据     | 位置                                      |
| -------- | ----------------------------------------- |
| 日志     | `<workspace>/logs`                        |
| 记忆     | `<workspace>/memory`                      |
| 会话     | `<sessions.baseDir>/agentpack-<key>.json` |
| 全局配置 | `~/.agentpack/config.json`                |
| API Key  | `~/.agentpack/.env` 或 `<cwd>/.env`       |

## 编程式 API

agentpack-cli 同时提供 Node.js API（`import { ... } from 'agentpack-cli'`）：

- 配置：`loadConfig`、`getConfigDir`、`getConfigPath`、`generateSessionKey`、`resolveHome`
- 环境：`loadEnvFile`、`saveEnvFile`
- 向导：`hasAnyApiKey`、`runSetupWizard`
- Runtime：`createAgentpackRuntime`、`resolveAiModel`、`resolveModelForCli`
- 能力：`startChat`、`runOnce`、`replaySession`
- 会话：`listSessions`、`clearSessions`、`deleteSession`
- 模型：`listModels`、`listConfiguredProviders`
- 重置：`confirmAction`、`resetAll`、`resetConfig`、`resetLogs`、`resetSessions`、`resetMemory`

类型：`AgentpackConfig`、`AgentpackConfigFile`、`AgentpackRuntimeConfig`、`CliOptions`、`SessionsConfig`、`RuntimeOptions` 等均从入口导出。
