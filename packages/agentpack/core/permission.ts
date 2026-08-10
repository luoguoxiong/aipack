/**
 * PermissionPolicy - 框架级工具权限层
 *
 * 安全底线：Runtime 在执行任意工具前经 PermissionPolicy 裁决，不依赖工具自身自觉。
 * 默认行为（兼容优先）：RuntimeOptions 未配置 permissionPolicy 时放行（保持向后兼容），
 * 生产环境应显式配置策略（createPermissionPolicy / createAllowListPolicy / denyAll）。
 *
 * 决策模型（deny-by-default）：
 * - 规则顺序匹配 → allow / deny / confirm
 * - confirm：需要人工确认，Runtime 随后调 policy.confirm()，未提供或返回 false → deny
 * - 无规则匹配 → 默认 deny
 */

import type { Request } from './request';

// ─── 决策类型 ─────────────────────────────────────────────────────

export type PermissionDecision = 'allow' | 'deny' | 'confirm';

/** 一次工具调用的权限请求（框架构造，传给 policy 裁决） */
export interface PermissionRequest {
  /** 工具名 */
  readonly toolName: string;
  /** 工具声明的权限能力（来自 Tool.permissions，如 'shell:exec' / 'fs:write'） */
  readonly permissions: readonly string[];
  /** 经 prepareArguments 处理后的参数（policy 可基于参数二次裁决） */
  readonly args: unknown;
  /** 会话标识 */
  readonly sessionKey: string;
  /** 本次 run 的请求 */
  readonly request: Request;
  /** Runtime 级共享状态 */
  readonly shared: Map<string, unknown>;
}

/**
 * 权限策略接口。
 * check() 返回 allow/deny/confirm；confirm 后由 Runtime 调 confirm() 完成人工确认。
 */
export interface PermissionPolicy {
  check(req: PermissionRequest): Promise<PermissionDecision>;
  /** 人工确认回调：返回 true 放行本次、false 拒绝。未提供时 confirm 决策视为 deny */
  confirm?(req: PermissionRequest): Promise<boolean>;
}

// ─── 规则型策略 ───────────────────────────────────────────────────

export interface PermissionRule {
  /** 规则名（调试 / 日志用） */
  name: string;
  /** 匹配工具名（正则，可选；缺省匹配任意工具） */
  toolName?: RegExp;
  /** 匹配能力：权限包含该能力即命中（支持前缀：'shell' 命中 'shell:exec'） */
  permission?: string;
  /** 参数谓词（可选，基于 args 二次裁决，如按命令内容判定） */
  matchArgs?: (args: unknown) => boolean;
  /** 命中后的决策 */
  decision: PermissionDecision;
}

export interface CreatePermissionPolicyOptions {
  rules: PermissionRule[];
  /** 人工确认回调（confirm 决策时调用；未提供则 confirm → deny） */
  confirmFn?: (req: PermissionRequest) => Promise<boolean>;
  /** 无规则匹配时的默认决策（默认 deny，保守） */
  defaultDecision?: PermissionDecision;
}

/** 按规则顺序裁决的通用策略（deny-by-default） */
export function createPermissionPolicy(
  options: CreatePermissionPolicyOptions,
): PermissionPolicy {
  const defaultDecision = options.defaultDecision ?? 'deny';
  return {
    async check(req: PermissionRequest): Promise<PermissionDecision> {
      for (const rule of options.rules) {
        if (rule.toolName && !rule.toolName.test(req.toolName)) continue;
        if (rule.permission && !hasPermission(req.permissions, rule.permission)) continue;
        if (rule.matchArgs && !rule.matchArgs(req.args)) continue;
        return rule.decision;
      }
      return defaultDecision;
    },
    confirm: options.confirmFn,
  };
}

/** 工具名白名单策略：白名单内 allow，其余 deny / confirm */
export function createAllowListPolicy(options: {
  allow: readonly string[];
  confirmFn?: (req: PermissionRequest) => Promise<boolean>;
}): PermissionPolicy {
  return {
    async check(req: PermissionRequest): Promise<PermissionDecision> {
      if (options.allow.includes(req.toolName)) return 'allow';
      return options.confirmFn ? 'confirm' : 'deny';
    },
    confirm: options.confirmFn,
  };
}

/** 全拒绝策略（严格模式：显式配置后所有工具被拒，需逐条放行） */
export function createDenyAllPolicy(): PermissionPolicy {
  return { check: async () => 'deny' };
}

/** 全放行策略（与"未配置"等价，用于测试或信任环境） */
export function createAllowAllPolicy(): PermissionPolicy {
  return { check: async () => 'allow' };
}

// ─── 能力匹配 ─────────────────────────────────────────────────────

/** permissions 是否含目标能力（支持前缀：目标 'shell' 命中 'shell:exec'） */
export function hasPermission(
  permissions: readonly string[],
  target: string,
): boolean {
  return permissions.some(
    p => p === target || (target.endsWith(':') ? p.startsWith(target) : p.startsWith(target + ':')),
  );
}
