> # Kobot Skill Runtime 技术方案 v2.1
>
> ## 1. 设计目标
>
> ## 核心目标
>
> | 能力       | 目标                           |
> | ---------- | ------------------------------ |
> | Skill 定义 | 支持 Claude Code SKILL.md 模式 |
> | 动态发现   | 根据任务自动选择 Skill         |
> | 上下文控制 | Skill 自己声明需要什么 Context |
> | 工具组合   | Skill 可以编排 Tool            |
> | 生命周期   | 支持 Hook 扩展                 |
> | MCP兼容    | Skill 和 MCP Tool 统一         |
> | 沙箱执行   | 保证稳定性                     |
> | 可观测     | 每次 Skill 可追踪              |
>
> ------
>
> # 2. 总体架构
>
> ```
>                  User Request
> 
>                       |
>                       v
> 
>               +---------------+
>               | Skill Router  |
>               +---------------+
> 
>                       |
>           +-----------+------------+
>           |                        |
>       Skill Match             Direct Tool
> 
>           |
>           v
> 
> +------------------------------------+
> |          Skill Runtime             |
> |                                    |
> |  +-------------+                   |
> |  | Skill Loader|                   |
> |  +-------------+                   |
> |                                    |
> |  +-------------+                   |
> |  | Context    |                   |
> |  | Manager    |                   |
> |  +-------------+                   |
> |                                    |
> |  +-------------+                   |
> |  | Executor    |                   |
> |  +-------------+                   |
> |                                    |
> +------------------------------------+
> 
>           |
> 
>           v
> 
> 
>       Tool Runtime
> 
>           |
> 
>    +------+-------+
>    |              |
>  Local Tool     MCP Tool
> ```
>
> ## 与现有 Agent Loop 的关系
>
> Skill 不替换 Agent Loop，而是**作为特殊 Tool Call 嵌入**：
>
> ```
> Agent Loop (现有)
>   │
>   ├── LLM 推理
>   ├── Tool Call ─────────────── 原有流程不变
>   │     └── BaseTool.execute()
>   │
>   └── Skill Call ← 新增：匹配到 Skill 时走这个分支
>         └── SkillRouter → SkillRuntime → Tool Call...
>                                          └── 可复用现有 ToolRegistry
> ```
>
> 旧 Tool 不需要改。Skill 命中时 SkillRuntime 接管执行流程，执行完返回结果给 Agent Loop 继续。
>
> ------
>
> # 3. 核心模块设计
>
> ## 3.1 Skill Registry
>
> 职责：
>
> 管理 Skill 元信息。
>
> ```
> interface SkillRegistry {
> 
>  register(skill: SkillDefinition)
> 
>  unregister(name:string)
> 
>  find(query:string): SkillMatch[]  // 返回优先级排序结果
> 
>  list()
> 
> }
> ```
>
> 存储：
>
> SQLite
>
> 表：
>
> ```
> skills
> 
> id          PRIMARY KEY
> name        UNIQUE INDEX    -- 按名称快速检索
> type        INDEX           -- type 列索引，支持按类型过滤
> version
> description
> manifest
> status
> created_at
> ```
>
> ------
>
> # 3.2 Skill Definition
>
> 采用：
>
> ```
> SKILL.md
> +
> skill.yaml
> +
> handler.ts
> ```
>
> 目录：
>
> ```
> skills/
> 
>  code-review/
> 
>     SKILL.md
> 
>     skill.yaml
> 
>     handler.ts
> 
> 
>  security-scan/
> 
>     SKILL.md
> 
>     skill.yaml
> ```
>
> ------
>
> # 4. Skill 类型设计
>
> 不要把 Skill 当 Tool。
>
> 定义 4 种类型：
>
> ------
>
> ## 4.1 Action Skill
>
> 单次动作。
>
> 例如：
>
> ```
> format-code
> 
> generate-test
> type: action
> 
> handler:
>  ./handler.ts
> ```
>
> ------
>
> ## 4.2 Workflow Skill
>
> 多个步骤。
>
> 例如：
>
> 代码审查：
>
> ```
> git diff
> 
> ↓
> 
> eslint
> 
> ↓
> 
> security
> 
> ↓
> 
> report
> type: workflow
> 
> 
> steps:
> 
>  - tool: git_diff
> 
>  - skill: security-check
> 
>  - skill: report
> ```
>
> ------
>
> ## 4.3 Knowledge Skill
>
> 知识增强。
>
> 例如：
>
> ```
> vue-best-practice
> 
> company-rule
> ```
>
> 作用：
>
> 注入 Context。
>
> ------
>
> ## 4.4 Agent Skill
>
> 子 Agent。
>
> 例如：
>
> ```
> frontend-agent
> 
> backend-agent
> ```
>
> 拥有：
>
> 自己的：
>
> - Prompt
> - Tool
> - Memory
>
> ------
>
> # 5. Skill Manifest
>
> skill.yaml
>
> ```
> name: code-review
> 
> version: 1.0.0
> 
> 
> type: workflow
> 
> 
> description:
>  自动代码审查
> 
> 
> trigger:
> 
>  keywords:
> 
>   - review
> 
>   - 审查
> 
> 
> context:
> 
>  include:
> 
>    - git.diff
> 
>    - changed_files
> 
> 
>  max_tokens: 8000
> 
> 
> 
> tools:
> 
>  allowed:
> 
>    - git
> 
>    - filesystem
> 
>    - eslint
> 
> 
> 
> runtime:
> 
>  timeout: 60000
> 
>  retry: 2
> 
> 
> 
> permission:
> 
>  filesystem:
> 
>    read:
> 
>     - src/**
> ```
>
> ------
>
> # 6. Skill Router
>
> 不要直接 embedding。
>
> 采用四级匹配。
>
> ## 匹配优先级规则
>
> - **Level 越高优先级越高**（Level 3 > Level 2 > ...）
> - **同 Level 内**：按 `priority` 字段降序（值越大越优先）
> - **同 Level + 同 priority**：按注册时间倒序（后注册的优先）
> - **冲突时**：取最高优先级的一个，不做合并
>
> ## Level 0 显式调用
>
> 例如：
>
> ```
> /review
> ```
>
> 最高优先级。
>
> ------
>
> ## Level 1 规则匹配
>
> 关键词：
>
> ```
> review
> bug
> 优化
> ```
>
> ------
>
> ## Level 2 Context Match
>
> 根据当前环境：
>
> 例如：
>
> 当前打开：
>
> ```
> xxx.vue
> ```
>
> 自动提高：
>
> ```
> vue-review
> ```
>
> ------
>
> ## Level 3 LLM Router
>
> 最后兜底。
>
> 输入：
>
> ```
> 用户:
> 帮我检查一下登录问题
> 
> 候选:
> 
> security
> debug
> frontend
> ```
>
> LLM选择。
>
> ------
>
> # 7. Context Manager（重点）
>
> 这是 Kobot 和普通 Agent 最大区别。
>
> Skill 不应该直接拿上下文。
>
> 应该声明：
>
> ```
> context:
> 
> 
> required:
> 
>  - git.diff
> 
> 
> optional:
> 
>  - package.json
> 
> 
> exclude:
> 
>  - node_modules
> 
> 
> 
> budget:
> 
>  max_tokens:8000
> ```
>
> 流程：
>
> ```
> Skill
> 
>  |
> 
> Context Request
> 
> 
>  |
> 
> Context Manager
> 
> 
>  |
> 
> Memory
> 
> Retriever
> 
> File Search
> 
> Compression
> 
> 
>  |
> 
> Context Package
> ```
>
> 输出：
>
> ```
> interface SkillContext {
> 
> 
>  files:File[]
> 
>  memory:string[]
> 
>  summary:string
> 
> 
>  tokens:number
> 
> 
>  size: number       // 文件大小
>  cost: number       // 上下文预算消耗
>  truncated: boolean // 是否被截断
> 
> }
> ```
>
> ------
>
> # 8. Prompt Compiler
>
> 类似 Claude Code。
>
> Skill 不直接写 Prompt。
>
> 而是：
>
> ```
> SKILL.md
> 
> 
>       |
> 
>  Prompt Compiler
> 
> 
>       |
> 
>  System Prompt
> ```
>
> 例如：
>
> SKILL.md
>
> ```
> # Code Review
> 
> 
> You are senior engineer.
> 
> 
> Rules:
> 
> 1. Check security
> 
> 2. Check performance
> 
> 3. Give suggestions
> ```
>
> 生成：
>
> ```
> system:
> 
> 你是高级工程师
> 
> 任务:
> 
> 代码审查
> 
> 
> 约束:
> 
> ...
> 
> Context:
> 
> git diff
> ```
>
> Compiler 处理阶段：
>
> 1. **Parse** — 解析 SKILL.md Frontmatter + Markdown 内容
> 2. **Inject Context** — 合并 Context Manager 的输出
> 3. **Bind Tools** — 按 `allowed_tools` 注入可用 Tool 列表
> 4. **Compile** — 组装为最终 System Prompt
>
> ------
>
> # 9. Skill Runtime
>
> ## 执行流程
>
> ```
> execute(skill)
> 
> 
>       |
> 
> [Hook] beforeExecute
> 
> 
>       |
> 
> validate
> 
> 
>       |
> 
> prepare context
> 
> 
>       |
> 
> [Hook] beforeContext
> 
> 
>       |
> 
> compile prompt
> 
> 
>       |
> 
> execute
> 
> 
>       |
> 
> [Hook] afterExecute
> 
> 
>       |
> 
> validate result
> 
> 
>       |
> 
> save trace
> ```
>
> ------
>
> # 10. Tool 统一模型
>
> Skill 调 Tool：
>
> 统一：
>
> ```
> interface Tool {
> 
> 
> name:string
> 
> 
> schema:JSONSchema
> 
> 
> execute(
>  input,
>  context
> )
> 
> }
> ```
>
> MCP：
>
> 转换：
>
> ```
> MCP Tool
> 
>     |
> 
> Adapter
> 
>     |
> 
> Kobot Tool
> ```
>
> 注：Tool 层直接复用现有 [ToolRegistry](file:///Users/kye/Documents/AI-NEW/kobot/src/tools/registry.ts) + [BaseTool](file:///Users/kye/Documents/AI-NEW/kobot/src/tools/base.ts)，不做额外封装。
>
> ------
>
> # 11. 生命周期 Hook
>
> ```
> interface SkillHook {
> 
> 
>  beforeMatch()
> 
> 
>  beforeLoad()
> 
> 
>  beforeContext()
> 
> 
>  beforeExecute()
> 
> 
>  afterExecute()
> 
> 
>  onError()
> 
> 
> }
> ```
>
> ## 执行规则
>
> - 多个 Hook 默认**串行执行**（按注册顺序）
> - 若某 Hook 标记 `parallel: true`，则该阶段的所有 parallel Hook 并行执行
> - 任一 Hook 返回 `{ abort: true }`，终止当前流程
> - Hook 崩溃不影响 Skill 执行（catch 后继续），但记录错误到 Trace
>
> ```
> beforeExecute
> 
>  ↓
> 
> Tool Call
> 
>  ↓
> 
> afterExecute
> ```
>
> ------
>
> # 12. 沙箱方案
>
> 不要一开始 Docker。
>
> 三阶段。
>
> ## V1 — Worker Thread（Phase 1-2）
>
> ```
> Agent
> 
>  |
> 
> Worker Pool
> 
>  |
> 
> Skill
> ```
>
> 优点：共享内存、低延迟。
> 限制：无法隔离原生模块崩溃。
>
> ------
>
> ## V2 — Child Process（Phase 3）
>
> ```
> fork()
> 
> resource limit
> ```
>
> 触发条件：Skill 包含非 JS 依赖（Python、Shell 等）或需要强隔离。
>
> ------
>
> ## V3 — Docker（Phase 4）
>
> 用于：
>
> Skill Store 的第三方不可信 Skill。
>
> ------
>
> # 13. Cache
>
> 只需要两级。
>
> ## L1 — Memory
>
> 缓存：
>
> - Skill Definition（Manifest + 编译后代码）
> - Compiled Prompt
> - 最近 50 次执行结果（幂等操作）
>
> 驱逐：LRU。
>
> ------
>
> ## L2 — SQLite
>
> 缓存：
>
> - execution result（TTL 5min）
> - embedding（TTL 7d）
> - history
>
> 结构：
>
> ```
> skill_cache         -- Skill 定义持久化
> execution_cache     -- 执行结果缓存
> context_cache       -- Context 组装结果缓存
> ```
>
> ------
>
> # 14. 可观测
>
> 统一 Trace。
>
> ```
> SkillTrace {
> 
> 
>  traceId
> 
> 
>  skill
> 
> 
>  duration
> 
> 
>  tokens
> 
> 
>  tools
> 
> 
>  status
> 
> 
>  error
> 
> 
> }
> ```
>
> 接入：
>
> OpenTelemetry。
>
> ------
>
> # 15. 稳定性（Phase 3 补充）
>
> 前期不做完整熔断，只需：
>
> - **超时控制** — 按 Manifest 声明的 timeout 强制终止
> - **连续失败计数** — 同一 Skill 连续失败 5 次自动禁用（可通过 registry 命令重新启用）
> - **错误分类** — 复用现有 BaseTool 的 `RETRYABLE_ERRORS` / `NON_RETRYABLE_ERRORS`
>
> 完整熔断器（Hystrix 状态机）留到 Phase 3 按需补充。
>
> ------
>
> # 16. 与现有 Kobot 集成
>
> 你的现有：
>
> ```
> src/tools
> 
> BaseTool
> 
> ToolRegistry
> 
> Agent Loop
> ```
>
> 改造：
>
> 现在：
>
> ```
> Agent
> 
>  |
> 
> ToolRegistry
> 
>  |
> 
> Tool
> ```
>
> 升级：
>
> ```
> Agent
> 
>  |
> 
> SkillRouter ← 嵌入 Agent Loop 的 Tool Call 分支
> 
>  |
> 
> SkillRuntime
> 
>  |
> 
> ToolRegistry ← 复用现有
> ```
>
> 兼容：
>
> 旧 Tool 不需要改。BaseTool、ToolRegistry 直接复用，Skill 只在上层新增一层路由。
>
> ------
>
> # 17. 开发路线
>
> ## Phase 1（4周）
>
> 实现核心链路：
>
> ✅ SKILL.md + skill.yaml 定义格式
> ✅ Skill Registry（SQLite 存储）
> ✅ Skill Loader（目录扫描 + 文件加载）
> ✅ Level 0-2 Router（显式 / 规则 / Context Match）
> ✅ Skill Runtime 基础执行流程
> ✅ Agent Loop 集成（Skill 作为 Tool Call 分支）
>
> 目标：
>
> ```
> 用户:
> 
> 帮我review代码
> 
> 
> 自动:
> 
> 加载 code-review skill
> ```
>
> ------
>
> ## Phase 2（4周）
>
> 加入：
>
> ✅ Context Manager
> ✅ Prompt Compiler
> ✅ Workflow Skill（步骤编排）
> ✅ Hook 系统
> ✅ SQLite Cache（L1 + L2）
> ✅ Level 3 LLM Router
>
> ------
>
> ## Phase 3（6周）
>
> 加入：
>
> ✅ MCP 协议兼容（stdio + 远程）
> ✅ Child Process 沙箱
> ✅ 熔断与自动恢复
> ✅ Permission 系统
> ✅ Plugin 打包分发
>
> ------
>
> ## Phase 4
>
> 平台化：
>
> ```
> Skill Marketplace
> 
> Skill Evaluation
> 
> Skill Auto Generate
> 
> Skill A/B Test
> 
> Docker 沙箱（第三方 Skill）
> ```
>
> ------
>
> # 最终架构定位
>
> Kobot 最终应该不是：
>
> > 一个支持 Skill 的 Agent
>
> 而应该是：
>
> > 一个 Skill Runtime 驱动的 Agent OS
>
> 类似：
>
> ```
> Claude Code
>        +
> Cursor Agent
>        +
> MCP Runtime
>        +
> LangGraph Workflow
> ```
>
> 这版方案比原方案少掉大量企业级复杂度，但保留未来扩展能力，更适合 Kobot 从 0 到 1 演进。你现有的 `ToolRegistry / BaseTool / Agent Loop / Context Compression / Loop Detector` 都可以自然接进去。
