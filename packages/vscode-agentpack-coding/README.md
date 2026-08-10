# vscode-agentpack-coding

基于 [`agentpack-coding`](../agentpack-coding) 的 VSCode AI coding 助手扩展。

在 VSCode 内提供一个 Webview 聊天面板，复用 agentpack-coding 的 7 个 coding 工具（read_file / write_file / edit_file / list_directory / run_command / grep / glob）、命令权限策略与跨会话记忆（agentpack-memory）。扩展层只负责 UI + 配置 + 生命周期桥接，不重写任何 agent 逻辑。

## 特性

- **Webview Panel 自定义聊天**：流式输出、思考过程折叠、工具调用卡片
- **QuickPick 命令确认**：变更性命令（git commit / npm install 等）执行前弹三选项（本次允许 / 始终允许 / 拒绝）
- **跨会话记忆**：自动 capture/recall 项目约定与决策（agentpack-memory）
- **VSCode Settings 配置**：provider / model / apiKey / memory 全部在 Settings 配置
- **会话持久化**：agentpack-coding sessionDir 落 globalStorage/sessions，跨重启恢复

## 前置条件

- VSCode 1.85+
- Node.js 18+
- 至少配置一个提供商的 API Key（在 Settings → Agentpack Coding）

## 配置

在 VSCode Settings（`Ctrl+,`）搜索 `agentpack`：

| 配置项 | 说明 | 默认 |
|--------|------|------|
| `agentpack.provider` | 模型提供商 | `deepseek` |
| `agentpack.model` | 模型 ID（留空取推荐） | `""` |
| `agentpack.apiKey.{provider}` | 各提供商 API Key（machine scope） | `""` |
| `agentpack.memory.enabled` | 启用跨会话记忆 | `true` |
| `agentpack.memory.baseDir` | 记忆存储目录（默认 `~/.agentpack/memory`） | `""` |
| `agentpack.sessionDir` | 会话持久化目录（默认 globalStorage/sessions） | `""` |
| `agentpack.enabledTools` | 启用的工具子集（空=全部 7 个） | `[]` |

支持的 provider：openai / deepseek / anthropic / groq / google(Gemini) / openrouter / mistral / xai / cerebras / together / fireworks / nvidia / moonshot。

API Key 会按 provider 的 envVar（如 google → `GOOGLE_API_KEY`）同步到 `process.env`，复用 agentpack 的 `getEnvApiKey` 兜底逻辑。

## 用法

1. 打开一个工作区文件夹
2. `Ctrl+Shift+P` → `Agentpack Coding: Open Chat`（或点击活动栏图标）
3. 在面板输入消息，如 `读 package.json 并总结有哪些 script`
4. agent 流式输出文本，工具调用显示为卡片；变更性命令会弹 QuickPick 确认

命令：
- `Agentpack Coding: Open Chat` — 打开聊天面板
- `Agentpack Coding: Stop Run` — 停止当前运行
- `Agentpack Coding: Clear History` — 清空当前会话历史

## 开发调试

```bash
# 1. 构建依赖（agentpack / agentpack-memory / agentpack-coding）
pnpm --filter agentpack build
pnpm --filter agentpack-memory build
pnpm --filter agentpack-coding build

# 2. 构建扩展（esbuild bundle → dist/extension.js）
pnpm --filter vscode-agentpack-coding build

# 3. 类型检查 / 单测
pnpm --filter vscode-agentpack-coding typecheck
pnpm --filter vscode-agentpack-coding test
```

F5 调试：在 VSCode 打开 `packages/vscode-agentpack-coding`，按 F5 启动 Extension Development Host（`preLaunchTask` 自动执行 `npm: build`）。

打包 vsix：

```bash
pnpm --filter vscode-agentpack-coding package:vsix
```

## 架构

```
src/
├── extension.ts        # activate/deactivate + 配置变更监听
├── agent.ts            # AgentService：createCodingAgent 包装 + 流式运行 + allowedAlways 保留
├── config.ts           # readAgentConfig() + syncApiKeysToEnv()
├── config-env.ts       # 纯函数（expandHome / syncApiKeysToEnv），可单测
├── confirm.ts          # QuickPick confirmFn 适配器
├── commands.ts         # openChat / stop / clearHistory
├── types.ts            # Webview 消息协议 + serializeMessages
└── webview/
    ├── panel.ts        # CodingChatPanel：createWebviewPanel + 订阅 stream 转 postMessage
    └── html.ts         # HTML 模板（CSP nonce）
media/
├── main.js             # 前端（原生 JS：postMessage 收发 + 流式渲染 + 极简 Markdown）
├── reset.css           # 基础重置
└── icon.svg            # 活动栏图标
```

**数据流**：

```
用户输入 → Webview postMessage(send) → Panel.runStream
  → AgentService.streamRun(message, sessionKey)
    → createCodingAgent({runtime}).stream(createRequest(...))
      → ResultChunk {text|thinking|tool_start|tool_end|error|done}
  ← forwardChunk → postMessage(WebviewOutbound) → 前端渲染
```

**命令确认流**：

```
run_command 工具执行 → PermissionManager.check(command)
  → 命中 confirm 规则 → confirmFn(ctx)
    → QuickPick 三选项
      → true(本次) / 'allow-always'(始终,自动累加 allowedAlways) / false(拒绝)
```

## 许可证

MIT
