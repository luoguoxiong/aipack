# 📊 AI Office Agent

基于 [aipack](../../packages/agent) 的 Office 文档智能体 Web 应用,用 TypeScript + 原生 http 实现,零运行时框架依赖。支持 **Excel / Word / PPT 的增删改查**,全部操作经 [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) 完成,生成文件落在隔离的工作区目录,可在线下载。

## 特性

- **意图 → officecli 参数,不写死模板**(5 个工具):
  - `office_read`(查):用 OfficeCLI `view` 读取任意文档——xlsx 输出单元格文本,docx/pptx 输出结构大纲(标题/段落/表格/每页内容)
  - `office_help`(查):用 OfficeCLI `help` 按需查询能力参考(元素清单 / 元素完整属性语法,随版本自动更新)。生成命令前不确定语法时先查再写,OfficeCLI 新增能力无需改代码或提示词
  - `office_exec`(增/改/删):LLM 识别用户意图,动态生成 OfficeCLI `batch` 命令数组(`create` 空文档 → `add`/`set`/`remove` 元素 → `close` 刷盘),覆盖创建/修改/删除全场景,不依赖任何预置版式
  - `file_list`(查工作区)/ `file_delete`(删,移入 `.trash` 回收站而非硬删除)
- **OfficeCLI 渲染引擎**:`officecli` 单二进制(Apache-2.0、跨平台、无需安装 Office),`npm i -g @officecli/officecli` 或 `brew install officecli` 即可。LLM 按用户输入自由组合任意元素:文本/标题/列表/表格/图表/图片/自定义每页布局/页眉页脚等,生成质量远优于手写 docx/pptxgenjs 库
- **工作区间切换**:前端点击「选择文件夹」用系统文件夹选择器选取本地目录,经上传导入切换为工作区(持久化到 `.aipack/workspace-state.json`,重启后沿用);也可经 `POST /api/workspace` 指定任意本地目录。所有工具/文件面板/下载都跟随当前工作区
- **选中文件修改**:文件面板「选中修改」后,发送的消息会自动附带目标文件上下文,Agent 默认先读取该文件再按提示修改
- **安全边界**:所有工具路径强制限制在当前工作区内(`resolveInWorkspace` 拒绝绝对路径与 `..` 逃逸),删除前须向用户确认(系统提示词约束),回收站机制防误删
- **并发安全**:同一文件的「读-改-写」整文件操作经 per-file 互斥锁串行化,避免并发覆盖;覆盖写前自动备份 `.bak`
- **流式对话**:SSE 实时推送回答增量与工具执行阶段(`tool_start`/`tool_end`),前端工具进度条 + 文件面板即时刷新
- **多 LLM 提供商**:默认 DeepSeek,可切换 OpenAI / Anthropic / Google / Groq 等;API Key 可前端输入(localStorage 持久化)或服务器配置
- **会话持久化**:基于 aipack `FileSessionStorage`,同一 sessionKey 历史可恢复

## 架构

```
用户消息(自然语言,如"把销售报表.xlsx 的 B3 改成 999")
        │
        ▼
┌───────────────────────────┐   意图 → officecli 参数    ┌──────────────────────────┐
│ Office Runtime            │ ─────────────────────────▶│ 文件工作区 office-        │
│ (systemPrompt + 5 工具)   │ office_read / office_help │ workspace/(含 .trash)    │
│                           │ / office_exec             │                          │
│                           │ ◀── OfficeCLI 读写 ───────│                          │
└───────────────────────────┘                           └──────────────────────────┘
        │ SSE 流式(text / tool_start / tool_end / done)
        ▼
   前端聊天渲染 + 文件面板(/api/files 下载)
```

## 快速开始

### 1. 安装依赖

在仓库根目录执行:

```bash
pnpm install
```

### 2. 安装 OfficeCLI 渲染引擎(所有 Office 操作必需)

```bash
npm i -g @officecli/officecli   # 或 brew install officecli
officecli --version             # 验证
```

### 3. 配置环境变量

```bash
cd apps/ai_office_agent
cp .env.example .env
# 编辑 .env,至少配置一个 LLM API Key
```

| 变量                | 说明                            | 默认               |
| ------------------- | ------------------------------- | ------------------ |
| `LLM_PROVIDER`      | LLM 提供商                      | `deepseek`         |
| `LLM_MODEL`         | 模型 id(留空按 provider 取默认) | —                  |
| `DEEPSEEK_API_KEY`  | DeepSeek Key                    | —                  |
| `OPENAI_API_KEY`    | OpenAI Key                      | —                  |
| `ANTHROPIC_API_KEY` | Anthropic Key                   | —                  |
| `GOOGLE_API_KEY`    | Google Gemini Key               | —                  |
| `GROQ_API_KEY`      | Groq Key                        | —                  |
| `OFFICE_WORKSPACE`  | 文件工作区目录(相对本 app)      | `office-workspace` |
| `PORT`              | Web 服务端口                    | `3001`             |

> LLM API Key 可在 `.env` 配置(供所有用户共用),也可由前端用户输入(localStorage 持久化,服务器不存储)。
> 完整 provider 与 envVar 对照见 [`packages/agent/ai/catalog.ts`](../../packages/agent/ai/catalog.ts) 的 `BUILTIN_PROVIDERS`。

### 4. 启动

```bash
# 开发(后端热重载 + 前端自动刷新)
pnpm --filter ai-office-agent dev

# 或带 Key
DEEPSEEK_API_KEY=sk-xxx pnpm --filter ai-office-agent dev

# 生产构建
pnpm --filter ai-office-agent build
pnpm --filter ai-office-agent serve
```

打开浏览器访问 `http://localhost:3001`,直接发消息即可,例如:

- 「新建一个 Excel 文件 output/销售报表.xlsx,包含 3 月和 4 月两个 sheet…」
- 「读取 销售报表.xlsx,总结每月总销售额并对比」
- 「把 销售报表.xlsx 中 3 月 sheet 的 B3 单元格改成 999,再追加一行」
- 「把 销售报表.xlsx 的表头(A1:K1)改成红色加粗并填充浅红」
- 「生成一份 Word 周报 output/周报.docx,含标题、本周总结和下周计划表格」
- 「生成一个 5 页的产品发布会 PPT output/发布会.pptx」

### 5. 桌面端(Tauri)

`src-tauri/` 是一个 Tauri 2 桌面外壳:应用启动时由 Rust 主进程拉起本机 Node 服务(`dist/server.js`,动态空闲端口),窗口直接加载 `http://127.0.0.1:<port>`,退出时自动清理服务子进程。

```bash
# 前置:Rust 工具链(rustup default stable)+ pnpm --filter ai-office-agent install
pnpm --filter ai-office-agent tauri:dev    # tsc 构建 dist + tauri dev 启动窗口
```

桌面端与网页版差异:

- 「选择文件夹」走 **Tauri 原生目录选择器**(`pick_workspace_dir` 命令)直接拿到本地绝对路径,`POST /api/workspace` 直连切换工作区,**免上传、无浏览器信任弹窗**;网页版仍走系统文件夹选择器上传导入
- 环境变量可用 `AIPACK_OFFICE_NODE`(node 可执行文件)与 `AIPACK_OFFICE_SERVER_ENTRY`(服务入口)覆盖

## 工作原理

### 单 Agent 编排([src/runtime.ts](src/runtime.ts))

一个 Runtime 挂载 5 个通用工具,LLM 根据用户意图自主组合。系统提示词明确:修改前先读原文、路径一律相对工作区、删除前先与用户确认、Word/PPT 覆盖时给完整内容。`maxTurns=15` 满足多步链路。

### 意图 → officecli 参数

代码不预置任何文档模板,全部由 LLM 识别意图并生成 officecli 参数,工具只负责执行。**能力语法不写死在提示词里**——agent 不确定某元素/属性时,先经 `office_help` 查询 OfficeCLI 自带的 schema 能力参考,再生成命令,因此 OfficeCLI 新增能力无需改动代码:

- **读取**:`office_read` → `officecli view <file> <outline|text> --max-lines N`(xlsx 用 text 模式输出单元格文本,docx/pptx 用 outline 模式输出结构大纲),超大文档按字符截断防上下文溢出
- **语法查询**:`office_help` → `officecli help <xlsx|docx|pptx> [元素|操作]`,返回元素清单或某元素的支持路径/属性/示例(如 `cell` 的样式属性、`autofilter` 的表头筛选、`sort` 排序)
- **写入**:`office_exec` → `officecli create` 建空文档 → `batch --commands '<JSON>'` 逐元素执行(add/set/remove,单次 open→save 周期,任一失败整体回滚)→ `close` 刷盘。支持 Excel 单元格完整样式(`set` 指向单元格/范围路径,如 `/Sheet1/A1:K1` 设置 `font.color` 字体颜色、`fill` 背景填充、`font.bold` 加粗、`halign` 对齐、`border.*` 边框)、表头筛选/排序下拉(`add autofilter`)、按列排序(`set sheet --prop sort`)等
- **依赖外部二进制**:所有 Office 操作要求本机装有 `officecli`(`npm i -g @officecli/officecli` 或 `brew install officecli`),未安装时工具返回明确错误提示

### 安全与容错

- 路径越界防护:`resolveInWorkspace` 拒绝绝对路径与 `..` 逃逸([src/tools/workspace.ts](src/tools/workspace.ts));`office_exec` 的 props 中携带文件路径的键(`src`/`image`/`out`)同样校验
- 覆盖备份:写入前自动备份 `.bak`(文件已存在时),`create=true` 重建前同样备份
- 删除回收站:删除 = 移动 `.trash/<文件名>.<时间戳>`,可手动恢复
- 读取截断:超长文档截断并提示,防上下文溢出
- 工具报错返回结构化文本 + `details.error`,LLM 可感知并修正

## API

| 方法   | 路径                   | 说明                                                                     |
| ------ | ---------------------- | ------------------------------------------------------------------------ |
| `GET`  | `/`                    | 单页 UI                                                                  |
| `GET`  | `/api/config`          | 当前模型、工作区、可用工具列表                                           |
| `POST` | `/api/chat`            | SSE 流式对话;body `{ message, model?, apiKey?, sessionKey?, filePath? }` |
| `GET`  | `/api/workspace`       | 当前工作区信息(`root` / `name` / `defaultRoot`)                          |
| `POST` | `/api/workspace`       | 切换工作区;body `{ path }`(持久化,重启沿用)                              |
| `PUT`  | `/api/import-file?path=` | 导入工作区文件(body=原始字节;配合页面拖拽文件夹导入)                   |
| `DELETE` | `/api/import-folder`  | 清空导入目录                                                              |
| `POST` | `/api/import-folder/commit` | 导入完成,将工作区切换为导入目录                                      |
| `GET`  | `/api/files`           | 当前工作区文件列表(JSON)                                                 |
| `GET`  | `/api/files/<relpath>`   | 下载工作区文件(路径校验防越界)                                            |
| `GET`  | `/api/preview/<relpath>` | 在线预览工作区文件:Office(xlsx/docx/pptx)经 `officecli watch` 所见即所得渲染(与 Office 排版一致,iframe 嵌入);文本/图片/PDF 原生预览 |

> `filePath` 为选中的目标文件(相对工作区路径),会注入到请求上下文,引导 Agent 先读取该文件再修改。

### SSE 事件序列(`/api/chat`)

```
event: text    data: {"delta":"回答增量..."}
event: tool    data: {"state":"start","toolName":"office_exec"}
event: tool    data: {"state":"end","toolName":"office_exec","isError":false}
event: done    data: {}
event: error   data: {"message":"..."}   # 出错时
```

## 开发

```bash
# 类型检查
pnpm --filter ai-office-agent typecheck

# 边改边预览:dev 模式下修改 public/ 前端或 src/ 后端代码,浏览器页面会自动刷新;
# 静态资源带 Cache-Control: no-cache,不会出现改了看不见的情况。设 NODE_ENV=production 可关闭自动刷新
# 目录结构
# src/
#   config.ts              环境变量、模型装配与工作区解析
#   runtime.ts             Office Runtime 构建与流式编排
#   server.ts              原生 http + SSE + 文件下载
#   tools/workspace.ts     工作区路径校验 / 备份
#   tools/officecli.ts     OfficeCLI 封装(create/batch/close/view)
#   tools/office-tools.ts  office_read(查)/ office_help(语法查询)/ office_exec(增删改,LLM 生成命令)
#   tools/file-tools.ts    文件列表 / 删除(回收站)
#   utils/mutex.ts         per-file 互斥锁
# public/
#   index.html / app.js / style.css   单页前端
```

## License

MIT
