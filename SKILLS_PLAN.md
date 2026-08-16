# @aipack-ai/agent Skills 支持方案

> 状态：待评审
> 范围：`packages/agent`（可选附带 `packages/cli` 接线）
> 参考：Agent Skills 开放规范（SKILL.md + YAML frontmatter）、`pi/packages/coding-agent/src/core/skills.ts` 既有实现

---

## 1. 目标与原则

- **对齐 Agent Skills 开放规范**（SKILL.md + YAML frontmatter），与 pi / Claude Code 生态的 skill 格式互通
- **渐进式披露（progressive disclosure）**：system prompt 只注入 name + description 目录，全文由模型按需通过内置 `skill` 工具获取，避免 token 浪费
- **库的纯粹性**：契约层零 fs 依赖；文件加载器独立成模块（对齐 `core/session.ts` 契约 + `session/file.ts` 实现的现有分层约定）
- **零侵入向后兼容**：不配置 skills 时行为与现在完全一致（对齐 compaction 的接入模式：`RuntimeOptions` 可选项，未配置零开销）

## 2. 现状分析

`AgentRuntime` 持有单一 `_systemPrompt` 字符串，`buildContext()`（`packages/agent/runtime/index.ts`）组装 `Context`：

```ts
private buildContext(messages: Message[]): Context {
  const tools = Array.from(this._globalTools.values());
  return {
    systemPrompt: this._systemPrompt,
    messages: ...,
    tools: tools.length > 0 ? tools : undefined,
  };
}
```

- 工具：`registerTool/registerTools` 注册进 `_globalTools`（Map），`Tool` 带 `permissions` 声明
- 扩展：Tapable hooks（beforeRun / beforeTransform / afterTransform / beforeToolCall / afterToolCall 等），但**没有直接改 systemPrompt 的钩子**
- 权限：`PermissionPolicy` + `ApprovalManager`，工具执行层统一裁决
- 仓库内 `pi` 已有一套成熟 SKILL.md 实现：frontmatter（name/description/disable-model-invocation）、目录扫描（SKILL.md 为根不递归）、多源加载（user → project → path）、`<available_skills>` 目录注入、`/skill:name` 展开，可直接对标

## 3. 三层设计

```
┌─ 契约层  core/skills.ts      Skill 类型 + 校验 + prompt 段渲染 + skill 工具工厂（纯函数，零 fs）
├─ 加载层  skills/loader.ts    SKILL.md 目录扫描 / frontmatter 解析 / 多源合并（Node only）
└─ 运行时  runtime 集成        RuntimeOptions.skills + registerSkill + buildContext 拼接
```

### 3.1 契约层（core/skills.ts）

```ts
export interface Skill {
  /** ^[a-z0-9-]+$，≤64 字符，无连续/首尾连字符 */
  name: string;
  /** 必填，≤1024 字符，模型据此判断是否调用 */
  description: string;
  /** SKILL.md 正文（不含 frontmatter），程序化注册必填 */
  content: string;
  /** 来源文件路径（文件加载时填充，供提示中标注相对资源基准目录） */
  filePath?: string;
  /** 资源解析基准目录（默认 filePath 的 dirname） */
  baseDir?: string;
  /** true 时不进 system prompt 目录、skill 工具拒绝，仅 /skill: 显式展开 */
  disableModelInvocation?: boolean;
  /** 来源标识：'user' | 'project' | 'path' | 'inline'（诊断用） */
  source?: string;
}

export interface SkillDiagnostic {
  type: 'error' | 'warning' | 'collision';
  message: string;
  path?: string;
}

// 纯函数
export function validateSkill(skill): string[];            // name/description 规则校验
export function formatSkillsSection(skills): string;       // <available_skills> 目录段
export function createSkillTool(registry): Tool;           // 独立工具工厂，供 DIY 消费者
```

**关键差异点（相对 pi）**：pi 只存 `filePath`，靠通用 `read` 工具二次读盘；agent 作为通用框架不能假设消费者有 read 工具 / fs 权限，因此 **loader 在加载时把正文读入内存（`content` 字段）**，`skill` 工具直接返回内容，运行时零 fs 依赖。

### 3.2 skill 工具（内置，按需注册）

```ts
// 工具名固定 'skill'，parameters:
{ name: { type: 'string', description: '要加载的 skill 名称' } }
// execute: 查 registry → 命中返回 content（含 "References are relative to {baseDir}" 提示）
//         未命中 / disableModelInvocation → isError: true
// permissions: []  （只读注册表，安全工具，不走审批）
```

system prompt 注入段格式（对齐 pi 的 XML 风格，但去掉 location、引导改用 skill 工具）：

```
The following skills provide specialized instructions for specific tasks.
Use the skill tool to load a skill when the task matches its description.
When a skill references relative paths, resolve them against its baseDir.

<available_skills>
  <skill>
    <name>pdf-export</name>
    <description>…</description>
  </skill>
</available_skills>
```

### 3.3 文件加载器（skills/loader.ts，Node only）

```ts
export interface LoadSkillsOptions {
  cwd?: string;                 // 默认 process.cwd()
  userDir?: string;             // 默认 ~/.aipack/skills
  projectDirName?: string;      // 默认 '.aipack/skills'（相对 cwd）
  extraPaths?: string[];        // 显式补充路径（文件或目录）
  includeDefaults?: boolean;    // 默认 true
}
export function loadSkills(options): { skills: Skill[]; diagnostics: SkillDiagnostic[] };
export function parseSkillMarkdown(text): { skill?: Skill; errors: string[] };  // 手写 frontmatter 解析，零新依赖
```

发现规则（对齐 pi / Anthropic 规范）：

- 目录含 `SKILL.md` → 视为 skill 根，**不再递归**；name 缺省取目录名
- 否则扫描根下直接 `.md` 子文件；再递归子目录寻找 `SKILL.md`
- 跳过 `.` 开头目录、`node_modules`；尊重 `.gitignore` / `.ignore`
- **多源优先级**：user → project → extraPaths，同名**先注册者胜**（user 优先，与 pi 一致），败者产出 `collision` 诊断

### 3.4 Runtime 集成

```ts
// RuntimeOptions 新增
skills?: Skill[];

// Runtime 接口新增
registerSkill(skill: Skill): this;      // 校验失败 throw（显式调用早暴露）
registerSkills(skills: Skill[]): this;
getSkills(): Skill[];
```

内部实现（改动集中在 `AgentRuntime`）：

1. 新增 `private _skills: Map<string, Skill>`，构造时灌入 `options.skills`
2. `buildContext()`：
   - `systemPrompt = this._systemPrompt + formatSkillsSection(visibleSkills)`（**每次动态计算，不改 `_systemPrompt`**，运行中 `registerSkill` 下一回合即生效）
   - tools 数组：有可见 skill 且用户未注册同名 `skill` 工具时，动态附加内置工具（用户工具优先，不动 `_globalTools`）
3. `SessionManagerOptions` 透传 `skills`

## 4. 上层消费方式（CLI 等）

```ts
// 一站式（推荐）
const { skills, diagnostics } = loadSkills({ cwd });
const runtime = createRuntime({ ..., skills });

// DIY：只用工具工厂 + 手动拼 prompt
runtime.registerTool(createSkillTool(skillMap));
runtime.setSystemPrompt(base + formatSkillsSection(skills));

// 显式触发（CLI /skill:name args）——框架导出纯函数，展开决策留给上层
export function expandSkillCommand(text: string, skills: Skill[]): string;
// 命中即替换为 <skill name="…" location="…">…全文…</skill>\n\n{args}
```

## 5. 安全与边界

- skill 全文引导模型执行的危险操作，由**现有 PermissionPolicy / ApprovalManager** 在工具执行层管控，skills 不新增权限面
- `disable-model-invocation: true` 支持纯人工触发场景
- v1 **不做** skill 携带可执行脚本/工具注册（frontmatter `tools:` 声明 + JS 模块加载留作 v2，风险高需单独评审）
- 加载失败 / 校验失败只产诊断不中断（对齐 Extension apply 失败不中断的健壮性风格）

## 6. 测试计划

| 层 | 用例 |
|---|---|
| 契约 | name/description 校验规则、formatSkillsSection 渲染、disableModelInvocation 过滤 |
| 加载器 | frontmatter 解析（含 malformed）、SKILL.md 目录不递归、根 .md、嵌套发现、ignore 规则、多源同名冲突 |
| runtime 集成 | mock 模型验证 prompt 含目录段、`skill` 工具返回 content、未知名报错、运行中 registerSkill 增量生效、用户重名 `skill` 工具优先 |
| 兼容回归 | 不配置 skills 时 `buildContext` 输出与现状逐字节一致 |

## 7. 实施步骤

1. `core/skills.ts`：契约 + 三个纯函数 + 工具工厂
2. `skills/loader.ts` + `skills/index.ts`：fs 加载器
3. runtime 集成：options / registerSkill / buildContext 拼接与工具附加
4. 根 `index.ts` 导出；`SessionManagerOptions` 透传
5. 新增 `test/skills.test.ts` + `test/skills-runtime.test.ts`
6. （可选）`packages/cli` 接线：启动时 `loadSkills` + `/skill:` 命令展开
7. README 补充 Skills 章节

## 8. 待确认决策点

| # | 决策 | 推荐 | 备选 |
|---|---|---|---|
| 1 | 全文获取方式 | 内置 `skill` 工具按需返回 | 小 skill（<N token）直接内联 + 大的走工具（混合，v2 优化项） |
| 2 | 同名优先级 | user > project（随 pi/规范） | project > user（直觉上项目覆盖个人） |
| 3 | loader 读盘时机 | eager 读入内存 | lazy（存 filePath，工具调用时再读，省内存但引入运行时 fs 依赖） |
| 4 | 是否本期做 CLI 接线 | 随本次一起做（端到端可用） | 仅发库，CLI 后续单独做 |
