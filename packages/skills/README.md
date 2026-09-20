# @aipack-ai/skills

aipack Agent Skills 插件：对齐 Agent Skills 开放规范（`SKILL.md` + YAML frontmatter），通过 `@aipack-ai/agent` 的 **Extension 插件机制**零侵入接入 Runtime。

## 特性

- **开放规范格式**：`SKILL.md` + frontmatter（`name` / `description` / `disable-model-invocation`），与 pi / Claude Code 生态 skill 互通
- **渐进式披露**：system prompt 只注入 `<available_skills>` 目录（name + description），全文由模型经内置 `skill` 工具按需获取，避免 token 浪费
- **运行时零 fs 依赖**：loader 加载时把正文读入 `content` 字段，工具直接返回内容
- **多源加载**：user（`~/.aipack/skills`）→ project（`<cwd>/.aipack/skills`）→ `extraPaths`，同名先注册者胜，冲突产出诊断不中断
- **零开销向后兼容**：无 skill 时不注册工具、不注入 prompt

## 快速接入

```ts
import { createRuntime } from '@aipack-ai/agent';
import { createSkillsPlugin } from '@aipack-ai/skills';

// 一站式（推荐）：加载 + 装配
const plugin = createSkillsPlugin({ load: { cwd: process.cwd() } });
const runtime = createRuntime({ ..., extensions: plugin.extensions });

// DIY：程序化注册
const ext = new SkillsExtension([{ name: 'demo', description: '...', content: '...' }]);
createRuntime({ ..., extensions: [ext] });
```

## 目录结构约定

```
~/.aipack/skills/          # 用户级（优先）
<cwd>/.aipack/skills/      # 项目级
  pdf-export/
    SKILL.md               # 含 SKILL.md 的目录视为 skill 根（不递归）
  loose-skill.md           # 直接 .md 文件也可（name 缺省取文件名）
```

## SKILL.md 格式

```markdown
---
name: pdf-export
description: 导出 PDF 的专项指引（模型据此判断是否调用）
---

# PDF Export

1. 步骤一
2. 步骤二 …
```

## 设计说明

插件通过两个 agent 扩展点接入（均为通用能力）：

| 扩展点 | 用途 |
|---|---|
| `ExtensionContext.runtime` | apply 阶段注册内置 `skill` 工具（执行走 Runtime 统一工具通道，含权限/审批） |
| `hooks.beforeModelCall` | 每次模型调用前把目录段附加到 system prompt（基准 prompt 每次重建，不累积） |

上层显式触发可使用 `expandSkillCommand(text, skills)`（`/skill:name args` → XML 块展开）。

## License

MIT
