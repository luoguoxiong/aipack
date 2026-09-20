/**
 * Skills - 核心类型定义
 *
 * 对齐 Agent Skills 开放规范（SKILL.md + YAML frontmatter），
 * 与 pi / Claude Code 生态的 skill 格式互通。
 */

// ─── Skill ────────────────────────────────────────────────────────

export interface Skill {
  /**
   * 唯一名称。规则：^[a-z0-9]+(-[a-z0-9]+)*$，≤64 字符。
   * 文件加载时缺省取 skill 根目录名。
   */
  name: string;
  /** 必填，≤1024 字符。模型据此判断是否调用（system prompt 目录唯一可见字段）。 */
  description: string;
  /** SKILL.md 正文（不含 frontmatter）。加载器读盘时填入，运行时零 fs 依赖。 */
  content: string;
  /** 来源文件路径（文件加载时填充，供提示中标注资源基准目录） */
  filePath?: string;
  /** 资源解析基准目录（默认 filePath 的 dirname） */
  baseDir?: string;
  /**
   * true 时不进 system prompt 目录、skill 工具拒绝调用，
   * 仅支持显式展开（expandSkillCommand / 手动触发）。
   */
  disableModelInvocation?: boolean;
  /** 来源标识：'user' | 'project' | 'path' | 'inline'（诊断用） */
  source?: string;
}

// ─── 诊断 ─────────────────────────────────────────────────────────

export interface SkillDiagnostic {
  /** error: 校验失败被跳过；warning: 非致命问题；collision: 同名冲突（先注册者胜） */
  type: 'error' | 'warning' | 'collision';
  message: string;
  path?: string;
}

// ─── 加载选项 ──────────────────────────────────────────────────────

export interface LoadSkillsOptions {
  /** 工作目录（默认 process.cwd()），项目级 skill 的解析基准 */
  cwd?: string;
  /** 用户级 skill 目录（默认 ~/.aipack/skills），不存在时静默跳过 */
  userDir?: string;
  /** 项目级 skill 目录名（默认 '.aipack/skills'，相对 cwd） */
  projectDirName?: string;
  /** 显式补充路径（文件或目录，按声明顺序加载） */
  extraPaths?: string[];
  /** 是否加载默认来源（user + project，默认 true） */
  includeDefaults?: boolean;
}
