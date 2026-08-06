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
    if (!this.confirmFn) return 'deny';
    const result = await this.confirmFn({
      command,
      cwd: '',
      matchedRule: rule.name,
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
