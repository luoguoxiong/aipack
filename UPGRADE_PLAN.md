# @aipack-ai/cli 升级方案（对标 pi coding-agent）

> 基线：2026-08-17 对比分析。目标：以最小成本补齐与 `pi/packages/coding-agent` 的关键差距。
> 原则：**优先复用 monorepo 已有底座（agent / compression / memory / observability），不照搬 pi 代码**。

## 一、现状基线

| 维度 | @aipack-ai/cli | pi coding-agent | 差距结论 |
|---|---|---|---|
| 规模 | 16 文件 / ~2.1k 行 | ~200 文件 / ~59k 行 | 约 1/28 |
| 内置工具 | read/write/edit/bash/find/grep/ls（7 个） | 同样 7 个 | **已对齐** |
| 运行模式 | interactive / print / json | + RPC / server+client | 缺 2 种 |
| 上下文压缩 | 未接入（compression 包已存在） | 自动 compaction + 分支摘要 | 只差接入 |
| 扩展系统 | 底座在 agent 包（ExtensionManager），CLI 无加载入口 | loader/runner + 60+ 示例 | 差产品化 |
| Skills/模板 | 无 | skills + prompt-templates | 整块缺失 |
| 会话 | 线性持久化 + continue/resume | 分支/树导航/HTML 导出 | 差结构升级 |
| 模型认证 | env api-key | OAuth×N 家 + 远程 catalog | 差认证体系 |
| TUI | readline REPL | 50+ 组件、主题、键位 | 差整层 |
| 遥测 | 未接入（observability 包已存在） | 遥测 + cache-stats + usage | 只差接入 |

**核心判断**：aipack 是"底座强、CLI 薄"。agent 包已有 Extension/Transformer/SessionManager/TaskGraph/Approval/Telemetry 契约，compression 包有 L1-L5，memory 包有混合检索插件，observability 包有 OTLP——大量差距本质是 **CLI 层未接入**，而非从零开发。

## 二、阶段划分

### Phase 1：上下文治理接入（最高性价比）

**目标**：长会话不爆 context；用户能看到 token 用量。

| # | 工作项 | 涉及模块 | 说明 |
|---|---|---|---|
| 1.1 | 接入 `createCompressionTransformer` 到 `buildRuntime` | `packages/cli/src/builder.ts` | 替换现有 `compaction: {enabled: true}` 占位；`transformers: [transformer]`；接 `setHandoffHook` → `runtime.switchSession` |
| 1.2 | CLI flag：`--no-compaction` / `--compaction-config <file>` | `args.ts` | 默认开启，允许关闭 |
| 1.3 | usage 统计展示：每次回复后输出累计 token（prompt/completion） | `modes/render.ts` | pi 对应 usage-totals.ts；数据源为 runtime done 事件的 message.usage（注：当前 done 事件 usage 为空，需先在 agent 流聚合层补齐，见已知问题） |
| 1.4 | `/compact` 斜杠命令：手动触发压缩 | `modes/interactive.ts` | 调 transformer 的压缩入口 |

**验收**：构造 100+ 轮会话不因 context 溢出报错；`/compact` 可手动触发并输出摘要。

### Phase 2：扩展系统产品化 + Skills

**目标**：把 agent 包的 Extension 底座暴露给用户，对齐 pi 的 `.pi/extensions` 体验。

| # | 工作项 | 涉及模块 | 说明 |
|---|---|---|---|
| 2.1 | 目录约定：`.aipack/extensions/*.ts`、`.aipack/skills/*.md`、`.aipack/prompts/*.md` | 新增 `packages/cli/src/extensions/loader.ts` | 参考 pi 的 resource-loader；用户扩展经 `createExtensionManager` 注册 |
| 2.2 | 扩展 API 收敛：导出 CLI 级 Extension 类型（拦截工具调用、注入自定义工具、改系统提示词） | `packages/cli/src/extensions/types.ts` | 底层复用 `createToolHookExtension` 等；先支持 3 个钩子：`onToolCall` / `registerTools` / `customizeSystemPrompt` |
| 2.3 | 热加载：文件变更时重载扩展 | extensions/ | fs.watch，参考 pi fs-watch |
| 2.4 | Skills：`.md` frontmatter 定义（name/description/触发条件），命中后注入提示 | `packages/cli/src/skills.ts` | pi 对应 core/skills.ts |
| 2.5 | 自定义斜杠命令：`.aipack/commands/*.md` → `/xxx` 展开为提示模板 | `modes/interactive.ts` | pi 对应 prompt-templates.ts + slash-commands.ts |
| 2.6 | 官方示例扩展 3 个：plan-mode（只读模式）、git-checkpoint、protected-paths | `.aipack/extensions/` 示例 | 既验证 API 又当文档 |

**验收**：第三方 TS 文件放进 `.aipack/extensions/` 能被加载并拦截工具调用；`.aipack/skills/` 的 md 能被模型按描述调用。

### Phase 3：会话结构升级 + 模型认证

**目标**：会话从"线性日志"升级为"可分支树"；模型接入去 env 化。

| # | 工作项 | 涉及模块 | 说明 |
|---|---|---|---|
| 3.1 | 会话消息树结构：message 增加 `parentId`，支持分支 | `packages/agent`（Session 存储格式 v2 + 迁移） | pi 对应 session-format 的树形 JSONL；**需 agent 包改造，是本方案唯一动底座的项** |
| 3.2 | 分支命令：`/branch`、`/tree`（树导航 UI）、`/rewind <n>` | `modes/interactive.ts` | pi 对应 tree-selector、agent-session-branching |
| 3.3 | 会话导出 HTML（含工具调用渲染） | 新增 `packages/cli/src/export-html.ts` | pi 有完整参考实现（marked + highlight.js vendor） |
| 3.4 | OAuth 设备码/PKCE 流程：anthropic / openai / deepseek / openrouter | `packages/agent/ai/credentials.ts` 扩展 | 新增 `aipack auth login <provider>` / `auth status` 子命令；参考 pi auth/oauth 目录（不抄实现，抄流程） |
| 3.5 | 远程模型 catalog：启动时拉取 + 本地缓存 + 失败回退内置 | `packages/cli/src/commands/models.ts` | pi 对应 models-store + remote-catalog-provider |

**验收**：同一会话可从任意历史节点开分支且互不污染；`aipack auth login anthropic` 走完 OAuth 后无需 env 即可使用。

### Phase 4：TUI 体验升级（最大工程，独立立项）

**目标**：从 readline 升级为组件化终端 UI。

技术选型建议（二选一，Phase 4 启动时决策）：
- **A. 手写轻量组件层**（延续零依赖风格，按需实现：diff 渲染、markdown、spinner、选择器）
- **B. 引入 ink（React for CLI）**（pi 同款路线的替代，生态成熟但引入 React 依赖）

最小组件集（按优先级）：`diff`（edit 工具输出）、`markdown 代码块高亮`、`footer 状态栏`（模型/会话/token）、`选择器泛化`（现有 select.ts 扩展）、`主题`（dark/light JSON + schema）。

### Phase 5：补全运行模式与生态（远期）

| # | 工作项 | 说明 |
|---|---|---|
| 5.1 | RPC 模式（`--mode rpc`）：JSON-RPC over stdio，供 IDE/编辑器插件驱动 | pi 对应 modes/rpc；依赖 Phase 4 的模式解耦 |
| 5.2 | server/client 模式：`aipack server` 常驻 + 多客户端共享会话 | pi 对应 client 包 |
| 5.3 | 遥测接入：observability 包 OTLP 上报 + `--telemetry` flag | 底座已有，接 CLI 即可 |
| 5.4 | 沙箱/容器化执行：bash 工具可选容器隔离 | pi 对应 sandbox 扩展 |
| 5.5 | memory 插件接入：`.aipack/memory` 跨会话记忆 | memory 包已有 BM25+向量检索 |

## 三、依赖关系与节奏

```
Phase 1（压缩接入）─────────┐
Phase 2（扩展+Skills）──────┼──→ Phase 4（TUI）──→ Phase 5（RPC/server）
Phase 3（会话树+OAuth）─────┘
```

- Phase 1/2/3 相互独立，可并行推进；均不依赖 Phase 4。
- Phase 3.1（会话树）是唯一需要改 agent 包底座的项，建议先出存储格式 RFC 再动手。
- 每个 Phase 完成发一个 minor 版本（0.1.x → 0.2.x → …），保持 npm 可独立升级。

## 四、明确不做（当前阶段）

- 不照搬 pi 的 TUI 组件代码（license 兼容但维护成本高，自建薄层）
- 不做 pi 的包管理器（`pi install` 安装扩展/skills，等扩展生态成型后再评估）
- 不做 llama.cpp 本地模型、Windows 自更新、mermaid/图片终端渲染等长尾能力
