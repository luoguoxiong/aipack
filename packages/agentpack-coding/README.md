# agentpack-coding

agentpack 的 **coding 工具集 + coding agent 工厂 + CLI**。

提供 7 个零依赖 coding 工具（文件读写、命令执行、代码搜索），双形态对外：
- `createCodingPlugin()` — 工具集插件，注入 `agentpack.config.js`
- `createCodingAgent()` — 开箱即用工厂，封装模型解析 + Runtime + 工具集 + system prompt
- `agentpack-coding` CLI — 交互式 coding REPL + 一次性 run

run_command 内置权限策略（白名单 allow/deny/confirm + 确认回调），所有文件操作经 workspace 沙箱校验。

## 安装

```bash
npm install agentpack-coding
# 或
pnpm add agentpack-coding
```

## 快速开始

### 方式一：工厂（开箱即用）

```ts
import { createRequest } from 'agentpack';
import { createCodingAgent } from 'agentpack-coding';

const agent = await createCodingAgent({
  provider: 'deepseek',       // 需配置 DEEPSEEK_API_KEY
  model: 'deepseek-chat',
  workspace: process.cwd(),
});

const result = await agent.runtime.run(
  createRequest('读 package.json 并总结有哪些 script'),
);
console.log(result.content);
await agent.close();
```

### 方式二：插件（注入 agentpack.config.js）

```js
import { createCodingPlugin } from 'agentpack-coding';

const coding = createCodingPlugin({ workspace: process.cwd() });
const r = coding.install();

export default {
  provider: 'deepseek',
  model: 'deepseek-chat',
  systemPrompt: coding.systemPrompt,
  tools: r.tools,
};
```

### 方式三：CLI

```bash
# 交互式 coding REPL（默认命令）
agentpack-coding chat

# 一次性执行
agentpack-coding run "给 src/utils.ts 加上 JSDoc 注释"

# 指定模型与工作区
agentpack-coding -p openai -m gpt-4o-mini -w /path/to/repo

# 启用记忆集成
agentpack-coding --memory chat
agentpack-coding --memory run "总结项目结构"
```

`--memory` 标志会动态加载 `agentpack-memory` 插件，为会话注入持久化记忆能力（需已安装 `agentpack-memory`）。

## 内置工具

| 工具 | 说明 |
| --- | --- |
| `read_file` | 读取文件，返回 cat -n 风格带行号内容；支持 offset/limit 分页；二进制检测 |
| `write_file` | 整体覆盖写入文件；自动创建父目录；原子写（tmp+rename） |
| `edit_file` | 字符串精确替换（old_string → new_string）；要求 old_string 唯一匹配；`replace_all` 兜底 |
| `list_directory` | 列出目录内容（不递归）；区分文件/目录；默认隐藏 dotfiles |
| `run_command` | 执行 shell 命令；经权限策略校验；stdout/stderr 截断；超时控制 |
| `grep` | 正则搜索文件内容；返回 `path:line:content`；默认忽略 node_modules/.git/dist |
| `glob` | 通配符查找文件（支持 `*` `**` `?` `{a,b}`）；递归遍历 |

## 权限策略

`run_command` 执行前调用 `PermissionManager.check(command)`，按规则决策：

- **allow**：只读命令（`git status/log/diff`、`ls/cat/pwd/find`、`node -v`、`tsc --noEmit` 等）
- **deny**：危险命令（`rm`、写系统路径 `/etc/`、`curl | sh`、`sudo`）
- **confirm**：变更性命令（`git push/commit`、`npm install`、`mv/cp/mkdir`）需确认回调批准
- **无规则匹配 → deny**（保守）

确认回调返回 `allow-always` 时，该命令永久放行（加入 allow-always 集合）。

```ts
import { createCodingAgent, PermissionManager } from 'agentpack-coding';

const agent = await createCodingAgent({
  provider: 'deepseek',
  model: 'deepseek-chat',
  permission: {
    rules: [{ name: 'allow-docker', match: (c) => c.startsWith('docker'), decision: 'allow' }],
    confirmFn: async (ctx) => {
      // 自定义确认逻辑
      return true;
    },
  },
});
```

## 启用工具子集

```ts
const agent = await createCodingAgent({
  provider: 'deepseek',
  model: 'deepseek-chat',
  enabledTools: ['read_file', 'grep', 'glob'],  // 只读模式
});
```

## 与 agentpack-memory 集成

coding agent + 记忆是天然组合（记住项目约定/决策）。通过 `memory` 选项动态注入（不硬依赖）：

```ts
const agent = await createCodingAgent({
  provider: 'deepseek',
  model: 'deepseek-chat',
  memory: { baseDir: '~/.agentpack/memory' },  // 动态 import agentpack-memory
});
```

或显式合并 memory 插件：

```ts
import { createMemoryPlugin } from 'agentpack-memory';
const mem = createMemoryPlugin({ baseDir: '~/.agentpack/memory' });
const memInstalled = mem.install();

const agent = await createCodingAgent({
  provider: 'deepseek',
  model: 'deepseek-chat',
  extraTools: memInstalled.tools,
  extensions: memInstalled.extensions,
  transformers: memInstalled.transformers,
});
```

## API

### `createCodingAgent(options): Promise<CodingAgent>`

| 选项 | 说明 |
| --- | --- |
| `provider` / `model` | 模型提供商与 ID（缺省按 API Key 自动选择） |
| `aiModel` | 已解析的 ai 模型（优先级高于 provider/model） |
| `streamFn` | 自定义 streamFn（优先级最高） |
| `systemPrompt` | 系统提示词（默认用内置 coding system prompt） |
| `workspace` | 工作区根目录（默认 `process.cwd()`） |
| `sessionDir` | 会话存储目录（不传则不持久化） |
| `extraTools` | 额外工具（与 coding 工具合并） |
| `extensions` / `transformers` | 额外扩展与转换器 |
| `permission` | 权限策略选项（rules / confirmFn） |
| `enabledTools` | 启用的工具名子集 |
| `memory` | 启用 agentpack-memory 集成 |

返回 `{ runtime, permission, tools, close() }`。

### `createCodingPlugin(options): CodingPlugin`

返回 `{ tools, permission, systemPrompt, transformers, install() }`，`install()` 返回 `{ tools, transformers }` 供 config.js 展开。

## 沙箱安全

所有文件路径经 `resolveWithin(workspace, rel)` 校验，必须在 workspace 之内，防止 `../../` 逃逸。`run_command` 的 cwd 也限定在 workspace 内。

## 开发

```bash
pnpm install
pnpm --filter agentpack-coding typecheck   # 类型检查
pnpm --filter agentpack-coding build       # 构建（产出 dist/index.js + dist/cli.js）
pnpm --filter agentpack-coding example     # 零依赖往返验证
```

## 相关项目

- [agentpack](../agentpack/README.md) — Agent 框架
- [agentpack-cli](../agentpack-cli/README.md) — 通用 CLI
- [agentpack-memory](../agentpack-memory/README.md) — 持久化记忆插件

## 许可证

MIT
