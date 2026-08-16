# @aipack-ai/cli

基于 [`@aipack-ai/agent`](../agent) 的终端 AI 编程助手。支持交互 REPL、非交互管道与 JSON 事件流三种模式,内置文件读写与 shell 工具,默认权限策略对正常操作零打断、仅危险命令需确认。

```bash
npm install -g @aipack-ai/cli
aipack "帮我看看这个项目"
```

## 快速开始

```bash
# 任选一个提供商设置 API Key
export DEEPSEEK_API_KEY=sk-xxx

# 交互模式（REPL）
aipack

# 非交互：单次提问（支持管道）
aipack -p "总结 README.md"
cat src/index.ts | aipack -p "这段代码有什么问题？"

# 指定模型（provider/id 组合写法）
aipack --model deepseek/deepseek-chat "你好"
aipack --model anthropic/claude-sonnet-4-20250514 "重构这个函数"

# 附带文件上下文（图片自动走多模态通道）
aipack @package.json "分析依赖"
aipack @screenshot.png "这个报错怎么修"

# 继续当前目录最近的会话
aipack -c "我们刚才聊到哪里了？"
```

## 三种运行模式

| 模式 | 用法 | 说明 |
|------|------|------|
| 交互（默认） | `aipack` | REPL,支持斜杠命令、Ctrl+C 中断运行（双击退出） |
| 非交互 | `aipack -p "..."` | 处理一次提示后退出；回复写 stdout（可管道），工具信息写 stderr |
| JSON 事件流 | `aipack --mode json "..."` | 全部流式事件按 JSON 行输出，供程序消费 |

JSON 模式输出示例：

```json
{"type":"text","content":"你好","timestamp":1730000000000}
{"type":"tool_start","toolName":"bash","timestamp":1730000000100}
{"type":"tool_end","isError":false,"timestamp":1730000000300}
{"type":"done","timestamp":1730000000400}
```

## 命令行选项

### 模型

| 选项 | 说明 |
|------|------|
| `--provider <名称>` | 提供商：openai / deepseek / anthropic / google / groq / moonshot ... |
| `--model <id>` | 模型 ID,支持 `provider/id` 组合写法；目录外模型自动按提供商 API 推断 |
| `--api-key <key>` | 覆盖环境变量 |
| `--thinking <级别>` | 思考级别：off / minimal / low / medium / high / max |
| `--list-models [搜索]` | 列出内置模型目录（标注 API Key 配置状态） |

未指定模型时自动探测第一个已配置 `*_API_KEY` 的提供商并使用其默认模型。

### 会话

| 选项 | 说明 |
|------|------|
| `-c, --continue` | 继续当前目录最近的会话 |
| `-r, --resume` | 列出当前目录历史会话供选择 |
| `--session <key>` | 使用指定会话 |
| `-n, --name <名称>` | 为新会话命名 |
| `--session-dir <目录>` | 自定义会话存储目录 |
| `--no-session` | 临时会话，不持久化 |

会话按工作目录分组存储于 `~/.aipack/cli-sessions/<cwd编码>/`。

### 工具与权限

| 选项 | 说明 |
|------|------|
| `-t, --tools <列表>` | 工具白名单（逗号分隔） |
| `-xt, --exclude-tools <列表>` | 工具黑名单 |
| `-nt, --no-tools` | 禁用全部工具 |
| `--safe` | 保守模式：写文件与 shell 全部人工确认 |

内置工具：

| 工具 | 能力 | 说明 |
|------|------|------|
| `read` | `fs:read` | 读文件，支持 offset/limit,超长截断 |
| `write` | `fs:write` | 写文件，自动建父目录 |
| `edit` | `fs:write` | 精确替换（oldString 唯一匹配） |
| `bash` | `shell:exec` | 执行 shell 命令，60s 超时，输出截断 |

所有文件工具限制在工作区内（越界路径直接拒绝）。

### 其他

| 选项 | 说明 |
|------|------|
| `--system-prompt <文本>` | 替换默认系统提示词 |
| `--append-system-prompt <文本>` | 追加系统提示词（可多次） |
| `-h, --help` / `-v, --version` | 帮助 / 版本 |

## 默认权限策略

正常操作零打断,仅真正危险的命令需确认:

| 操作 | 默认行为 |
|------|---------|
| 读文件 | 静默放行 |
| 写文件 / 编辑 | 静默放行（工作区越界防护兜底） |
| bash 普通命令 | 静默放行 |
| bash 危险命令 | 弹出选择器,标注危险原因 |

危险命令识别:`sudo` 提权、`rm -rf /` `rm -rf ~`(根/家目录递归删除)、`mkfs` / `dd of=/dev/` / `> /dev/sdX`(磁盘写入)、`curl ... \| sh`(管道执行远程脚本)、`chmod -R 777 /`、`shutdown` / `reboot`、fork 炸弹。指定子目录的正常删除(如 `rm -rf dist`)不受影响。

确认时使用**方向键选择器**(非输入式):

```
? 危险命令（提权执行）：sudo rm -rf /usr/local/foo
  ❯ 允许
    总是允许（本会话）
    拒绝
```

选择"总是允许"后,同一能力本会话内不再重复询问。

## 交互模式斜杠命令

| 命令 | 说明 |
|------|------|
| `/model [provider/id]` | 切换模型(无参显示当前) |
| `/thinking <级别>` | 调整思考级别 |
| `/system <文本>` | 替换系统提示词 |
| `/session` | 当前会话信息 |
| `/sessions` | 列出历史会话 |
| `/clear` | 清空当前会话(仅内存) |
| `/approvals` | 列出未决审批单 |
| `/approve <id>` / `/deny <id>` | 结算审批单 |
| `/help` / `/quit` | 帮助 / 退出 |

## approvals 子命令(跨进程审批)

配合 `aipack.config.js` 的 `approvals.enabled: true` 使用。运行中的进程产生 pending 审批单落盘后,可在另一个终端结算:

```bash
aipack approvals list          # 列出未决审批单
aipack approvals approve <id>  # 批准
aipack approvals deny <id>     # 驳回
```

## 配置文件 `aipack.config.js`

放在项目根目录(可选):

```js
export default {
  // 异步审批（默认关闭：内联确认）
  approvals: {
    enabled: true,
    // 触发审批的能力（默认 ['fs:write', 'shell:exec']）
    capabilities: ['shell:exec'],
  },
  // 自定义权限规则（优先于内置规则）
  permissionRules: [
    { toolName: 'write', decision: 'confirm' },   // write 工具全部确认
    { permission: 'fs:write', decision: 'allow' }, // 按能力放行
  ],
};
```

优先级:`approvals`(pending) > `--safe`(confirm) > 智能默认;`permissionRules` 永远最先匹配。

## 环境变量

| 变量 | 说明 |
|------|------|
| `<PROVIDER>_API_KEY` | 提供商 API Key,如 `DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` |
| `AIPACK_CONFIG_DIR` | 配置目录(默认 `~/.aipack`) |

## 可编程 API

```ts
import { parseArgs, buildRuntime, runPrintMode, BUILTIN_TOOLS, isDangerousCommand } from '@aipack-ai/cli';

const args = parseArgs(['-p', '你好']);
const built = await buildRuntime({ args, cwd: process.cwd() });
// built.runtime → @aipack-ai/agent Runtime
// built.sessionKey / built.storage / built.approvalManager
```

## 开发

```bash
pnpm build:cli        # 构建（自动先构建 agent）
pnpm --filter @aipack-ai/cli typecheck
pnpm cli:dev          # tsx 直跑源码
pnpm cli              # 运行构建产物

# 冒烟
pnpm cli --list-models
printf '/help\n/quit\n' | pnpm cli
```

## License

MIT
