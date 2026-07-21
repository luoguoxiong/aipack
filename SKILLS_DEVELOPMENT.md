# 技能开发指南

本文档详细说明如何为 Nanobot 创建自定义技能（Skill）。

## 一、什么是技能

技能（Skill）是一种文档化的「行为指南」，它不是工具，而是将 `SKILL.md` 文档拼进系统提示词，让模型学会「在什么场景下用哪些工具组合完成任务」。

**工具 vs 技能**:
- **工具（Tool）**: Agent 可直接调用的函数（如 `shell_exec`、`read_file`）
- **技能（Skill）**: 引导 Agent 使用工具的文档，告诉模型「在什么场景下应该调用哪些工具组合」

## 二、技能文件结构

每个技能是一个目录，包含以下文件：

```
skills/
└── my-skill/
    ├── SKILL.md           # 必需：技能主文档
    └── references/        # 可选：参考文档目录
        └── examples.md    # 可选：示例文档
```

### 2.1 SKILL.md 文件格式

技能文件采用 Markdown 格式，包含 YAML front matter 和正文内容：

```markdown
---
name: skill-name
description: "简短描述技能的用途"
metadata: {"nanobot":{"emoji":"🎯","requires":{"bins":["curl"]}}}
tags: github, automation
version: 1.0.0
homepage: https://example.com
---

# 技能标题

技能正文内容...
```

### 2.2 Front Matter 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 技能名称（必须与目录名一致） |
| `description` | string | 是 | 技能描述，会被注入到系统提示词中 |
| `metadata` | string (JSON) | 否 | 元数据，包含 emoji、依赖等信息 |
| `tags` | string | 否 | 逗号分隔的标签列表 |
| `version` | string | 否 | 技能版本 |
| `homepage` | string | 否 | 技能主页 URL |

### 2.3 Metadata 字段

`metadata` 是一个 JSON 字符串，包含以下字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `emoji` | string | 技能图标（Emoji） |
| `requires.bins` | array | 需要的系统命令行工具（如 `gh`, `curl`） |
| `install` | array | 安装指南列表 |

**install 数组项结构**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 安装方式 ID |
| `kind` | string | 安装类型（`brew`, `apt`, `npm`, `pip`, `manual`） |
| `formula/package` | string | 包名或公式名 |
| `bins` | array | 安装后产生的二进制文件 |
| `label` | string | 显示给用户的标签 |

## 三、技能加载机制

### 3.1 加载流程

1. `SkillLoader` 遍历所有注册的技能目录
2. 每个目录下查找 `SKILL.md` 文件
3. 解析 YAML front matter（`name` / `description` / `tags` / `version`）和正文
4. `buildSkillPrompt(skillNames)` 把指定技能的完整 Markdown 拼成一段 `# Skills\n\n## <name>\n\n<content>` 注入系统提示词

### 3.2 技能目录注册

技能目录在 `SkillLoader.addSkillDir()` 中注册：

```typescript
const skillLoader = new SkillLoader();
skillLoader.addSkillDir('./skills');  // 默认技能目录
skillLoader.addSkillDir('./custom-skills');  // 自定义技能目录
await skillLoader.load();
```

### 3.3 技能注入

技能在 `ContextBuilder.buildSystemPrompt()` 中被注入系统提示词。模型读到这段提示词后，会学会「在 X 场景下应该调用 Y 工具组合」。

## 四、创建自定义技能

### 4.1 步骤 1：创建技能目录

```bash
mkdir -p skills/my-skill
```

### 4.2 步骤 2：创建 SKILL.md

```markdown
---
name: my-skill
description: "我的自定义技能，用于执行特定任务"
metadata: {"nanobot":{"emoji":"🎯","requires":{"bins":["node"]}}}
tags: custom, tool
version: 1.0.0
---

# My Skill

这是我的自定义技能。

## 使用场景

当用户需要执行以下任务时使用此技能：
- 任务描述 1
- 任务描述 2

## 工具调用示例

使用 `shell_exec` 工具执行命令：

```bash
node script.js --arg value
```

## 最佳实践

1. 先检查环境是否满足要求
2. 再执行主命令
3. 最后验证结果
```

### 4.3 步骤 3：测试技能

启动 Nanobot，在对话中测试技能是否生效。技能会自动加载并注入到系统提示词中。

### 4.4 步骤 4：禁用技能（可选）

如果需要临时禁用某个技能，可以在 `config.json` 中配置：

```json
{
  "agents": {
    "defaults": {
      "disabled_skills": ["my-skill"]
    }
  }
}
```

## 五、技能编写最佳实践

### 5.1 文档结构

技能文档应该包含以下部分：

1. **标题**: 清晰描述技能的用途
2. **使用场景**: 明确说明何时应该使用此技能
3. **工具调用示例**: 提供具体的工具调用命令或代码示例
4. **最佳实践**: 提供使用建议和注意事项
5. **常见问题**: 解答常见问题

### 5.2 语言规范

- 使用清晰、简洁的语言
- 避免过于技术性的术语，除非必要
- 提供具体的示例，而不是抽象的描述
- 使用 Markdown 格式，保持文档易读

### 5.3 工具调用

技能应该明确指出需要调用哪些工具：

```markdown
## 工具调用

使用 `shell_exec` 工具执行命令：

```bash
gh issue list --repo owner/repo
```

使用 `write_file` 工具保存结果：

```
file_path: issues.txt
content: <输出内容>
```
```

### 5.4 代码示例

提供具体的代码示例，包括：
- 命令行命令
- 参数说明
- 预期输出

```markdown
## 示例

列出最近的 PR：

```bash
gh pr list --repo myorg/myrepo --limit 5
```

输出示例：
```
#55  Fix bug       feature-branch  2 hours ago
#54  Add feature  main            1 day ago
```
```

### 5.5 错误处理

提供错误处理建议：

```markdown
## 错误处理

如果命令失败，检查：
1. 是否安装了必要的工具
2. 是否有正确的权限
3. 参数是否正确
```

## 六、内置技能参考

### 6.1 技能列表

| 技能名称 | 说明 | 依赖工具 |
|----------|------|----------|
| `github` | GitHub 操作（Issue、PR、CI） | `shell_exec` |
| `weather` | 天气查询 | `shell_exec` |
| `image-generation` | 图像生成 | `generate_image` |
| `memory` | 长期记忆管理 | memory 工具 |
| `summarize` | 摘要生成 | `web_fetch`, `read_file` |
| `cron` | 定时任务管理 | cron 工具 |
| `tmux` | tmux 会话管理 | `shell_exec` |
| `my` | Agent 自省 | `my` 工具 |
| `skill-creator` | 创建和更新技能 | 文件系统工具 |
| `update-setup` | 技能设置向导 | 多种工具 |
| `clawhub` | 公共技能仓库 | `web_search` |

### 6.2 示例：GitHub 技能

```markdown
---
name: github
description: "Interact with GitHub using the `gh` CLI."
metadata: {"nanobot":{"emoji":"🐙","requires":{"bins":["gh"]}}}
---

# GitHub Skill

Use the `gh` CLI to interact with GitHub.

## Pull Requests

Check CI status:
```bash
gh pr checks 55 --repo owner/repo
```

## Issues

List issues:
```bash
gh issue list --repo owner/repo --json number,title
```
```

### 6.3 示例：天气技能

```markdown
---
name: weather
description: Get current weather and forecasts.
metadata: {"nanobot":{"emoji":"🌤️","requires":{"bins":["curl"]}}}
---

# Weather

Two free services, no API keys needed.

## wttr.in

Quick one-liner:
```bash
curl -s "wttr.in/London?format=3"
```

## Open-Meteo

JSON format:
```bash
curl -s "https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.12&current_weather=true"
```
```

## 七、技能打包工具

项目提供了技能打包工具，位于 `src/skills/skill-creator/scripts/`：

### 7.1 初始化技能

```bash
node src/skills/skill-creator/scripts/init_skill.ts --name my-skill --description "我的技能"
```

### 7.2 打包技能

```bash
node src/skills/skill-creator/scripts/package_skill.ts --dir skills/my-skill --output my-skill.zip
```

### 7.3 验证技能

```bash
node src/skills/skill-creator/scripts/quick_validate.ts --dir skills/my-skill
```

## 八、技能发布

### 8.1 发布到公共仓库

可以将技能发布到 ClawHub 公共技能仓库，供其他用户使用。使用 `clawhub` 技能可以搜索和安装公共技能。

### 8.2 私有技能

将技能放在项目的 `skills/` 目录中，或者通过 `SkillLoader.addSkillDir()` 添加自定义目录。

## 九、调试技能

### 9.1 查看加载的技能

在 WebUI 中访问 `/api/webui/skills` 可以查看所有已加载的技能。

### 9.2 查看技能详情

```bash
curl http://localhost:8000/api/webui/skills/my-skill
```

### 9.3 查看系统提示词

技能会被注入到系统提示词中，可以通过 `my` 工具查看当前的系统提示词：

```
my check system_prompt
```

## 十、技能版本管理

### 10.1 版本号

使用语义化版本号（Semantic Versioning）：

- `1.0.0`: 初始版本
- `1.1.0`: 新增功能
- `1.0.1`: Bug 修复

### 10.2 更新技能

直接修改 `SKILL.md` 文件，重启服务后自动加载新版本。

### 10.3 兼容性

保持技能向后兼容，避免破坏性变更。如果需要重大变更，使用新版本号。

## 十一、示例：创建一个完整的技能

### 11.1 创建项目分析技能

```bash
mkdir -p skills/project-analyzer
```

创建 `skills/project-analyzer/SKILL.md`：

```markdown
---
name: project-analyzer
description: "分析项目结构、依赖和代码质量"
metadata: {"nanobot":{"emoji":"📊","requires":{"bins":["node"]}}}
tags: code, analysis
version: 1.0.0
---

# Project Analyzer

分析项目结构、依赖和代码质量。

## 使用场景

当用户要求：
- "分析这个项目"
- "查看项目结构"
- "检查项目依赖"
- "评估代码质量"

## 步骤

1. **列出目录结构**
   ```bash
   ls -la
   ```

2. **读取 package.json**
   ```
   read_file package.json
   ```

3. **分析依赖**
   - 列出所有依赖
   - 检查是否有过时的依赖
   - 检查是否有安全漏洞

4. **搜索关键文件**
   ```
   find_files --pattern "*.ts" --limit 20
   ```

5. **读取关键源代码**
   ```
   read_file src/index.ts
   ```

6. **生成分析报告**
   - 项目结构概述
   - 技术栈说明
   - 依赖状态
   - 代码质量评估

## 示例输出

```
## 项目分析报告

### 基本信息
- 项目名称: nanobot-ai
- 版本: 0.2.2
- 描述: 轻量级个人 AI 助手框架

### 技术栈
- Node.js >= 18.0.0
- TypeScript
- Express
- React (WebUI)

### 依赖
- axios: ^1.7.0
- commander: ^12.1.0
- zod: ^3.23.0

### 项目结构
src/
├── agent/          # Agent 核心逻辑
├── api/            # HTTP API
├── channels/       # 渠道适配器
└── providers/      # LLM Provider

### 代码质量评估
- TypeScript 类型覆盖率: 高
- 测试覆盖率: 中等
- 代码复杂度: 中等
```

## 最佳实践

1. 先列出目录结构，了解项目概貌
2. 读取 package.json 了解依赖
3. 搜索关键源代码文件
4. 重点读取核心文件
5. 生成结构化报告
```

### 11.2 测试技能

启动 Nanobot，在对话中测试：

```
帮我分析一下这个项目
```

Agent 应该根据技能文档，自动调用相关工具进行项目分析。

---

*版本：v0.2.2*