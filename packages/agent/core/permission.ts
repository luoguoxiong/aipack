/**
 * PermissionPolicy - 框架级工具权限层
 *
 * 安全底线：Runtime 在执行任意工具前经 PermissionPolicy 裁决，不依赖工具自身自觉。
 * 默认行为（兼容优先）：RuntimeOptions 未配置 permissionPolicy 时放行（保持向后兼容），
 * 生产环境应显式配置策略（createPermissionPolicy / createAllowListPolicy / denyAll）。
 *
 * 决策模型（deny-by-default）：
 * - 规则顺序匹配 → allow / deny / confirm / pending
 * - confirm：内联人工确认，Runtime 随后调 policy.confirm()，未提供或返回 false → deny
 *   （适合审批人在场的交互式场景，如 CLI 终端 y/n 提示）
 * - pending：异步审批，Runtime 挂起工具调用并注册审批单（ApprovalManager），
 *   等外部批准 / 驳回后继续；未配置审批管理器 → deny（保守）。
 *   （适合审批人不在场的场景：Web 审批面板、远程 / 跨进程审批）
 * - 无规则匹配 → 默认 deny
 */

import type { Request } from './request';

// ─── 决策类型 ─────────────────────────────────────────────────────

export type PermissionDecision = 'allow' | 'deny' | 'confirm' | 'pending';

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

// ─── 异步审批（Human-in-the-loop）──────────────────────────────────

/** 审批单结算状态 */
export type ApprovalOutcomeStatus = 'approved' | 'denied' | 'timeout' | 'cancelled';

/** 审批单：一次挂起中的工具调用，等待外部批准（UI / 遥测据此展示） */
export interface PendingApproval {
  /** 审批单 id（全局唯一，外部以 id 批准 / 驳回） */
  readonly id: string;
  /** 触发审批的权限请求（含工具名 / 参数 / 能力声明） */
  readonly request: PermissionRequest;
  /** 创建时刻（epoch ms） */
  readonly createdAt: number;
  /** 过期时刻（epoch ms；未配置超时则无限等待） */
  readonly expiresAt?: number;
  /** 重启恢复标记：true = 经 restore() 从存储恢复的孤儿审批单（原 run 已丢失，
   *  可批准 / 驳回（结果持久化供审计），但无等待方会被唤醒） */
  readonly restored?: boolean;
}

/** 审批结算结果（wait() 的 resolve 值） */
export interface ApprovalOutcome {
  readonly status: ApprovalOutcomeStatus;
  /** 挂起总时长 ms */
  readonly waitedMs: number;
  /** 结算来源描述（'resolved' / 'timeout' / 'cancelled'，日志用） */
  readonly reason: string;
  readonly approval: PendingApproval;
}

export interface ApprovalCreateOptions {
  /** 审批等待超时（毫秒；未配置则无限等待，由调用方自行取消） */
  timeoutMs?: number;
  /** 取消信号（如 run 的 AbortSignal；触发时审批单以 cancelled 结算） */
  signal?: AbortSignal;
}

/**
 * 内存审批管理器：pending 决策的审批单生命周期管理。
 *
 * 解耦关键：发起 run 的调用栈与批准人之间以审批单 id 通信——
 * Runtime 挂起等待 wait()，外部任意时机调 resolve()，两者无需共享调用栈。
 *
 * 持久化（Phase 2）：配置 store 后审批单落盘（create 时写入、结算时清理 + 审计），
 * 进程重启后经 restore() 恢复未决列表。恢复的是"孤儿"审批单——原 run 已丢失，
 * 可批准 / 驳回（结果持久化供审计），但无等待方会被唤醒。
 */
export interface ApprovalManager {
  /** 创建审批单（同步登记，随后应调 wait() 挂起等待） */
  create(request: PermissionRequest, options?: ApprovalCreateOptions): PendingApproval;
  /** 挂起等待结算：approved → status 'approved'，deny/超时/取消 → 其他 status */
  wait(approval: PendingApproval): Promise<ApprovalOutcome>;
  /** 当前未决审批单（UI 拉取待审批列表） */
  list(): PendingApproval[];
  /** 批准 / 驳回（返回是否生效：审批单存在且未决才生效） */
  resolve(id: string, approved: boolean): boolean;
  /** 取消审批单（run abort 收尾时调用；已结算则无操作） */
  cancel(id: string): void;
  /**
   * 从存储恢复未决审批单（进程重启后调用），返回恢复条数。
   * 恢复的审批单标记 restored: true 并触发 onPending 事件；
   * 已过期的在恢复时立即以 timeout 结算。需配置 store，否则返回 0。
   */
  restore(): Promise<number>;
  /**
   * 优雅关闭：清理全部超时计时器与取消信号监听。
   * 未决审批单不结算、不写审计——保留在存储中供下次 restore（跨进程存活的语义）；
   * 调用方需确保已无挂起的 wait()。
   */
  close(): void;
  /** 订阅审批单创建事件（UI / 遥测）；返回取消订阅函数 */
  onPending(cb: (approval: PendingApproval) => void): () => void;
  /** 订阅审批结算事件（含批准 / 驳回 / 超时 / 取消）；返回取消订阅函数 */
  onSettled(cb: (outcome: ApprovalOutcome) => void): () => void;
}

// ─── 审批持久化（Phase 2）─────────────────────────────────────────

/**
 * 审批单的可序列化形态（存储 / 网络传输 DTO）。
 * 不含 PermissionRequest 中的 request / shared（运行时对象，不可序列化）。
 */
export interface StoredApproval {
  readonly id: string;
  readonly toolName: string;
  readonly permissions: readonly string[];
  readonly args: unknown;
  readonly sessionKey: string;
  readonly createdAt: number;
  readonly expiresAt?: number;
}

/** 结算审计记录（轻量：不含 args，落 history 供追溯） */
export interface ApprovalAuditRecord {
  readonly id: string;
  readonly toolName: string;
  readonly status: ApprovalOutcomeStatus;
  readonly waitedMs: number;
  readonly reason: string;
  readonly settledAt: number;
}

/** 审批存储契约：实现方保证 save / settle 幂等可行（重复调用不抛错） */
export interface ApprovalStore {
  /** 加载全部未决审批单（进程重启恢复用） */
  load(): Promise<StoredApproval[]>;
  /** 新审批单落盘 */
  save(stored: StoredApproval): Promise<void>;
  /** 结算：从未决集合移除，并追加审计记录 */
  settle(id: string, record: ApprovalAuditRecord): Promise<void>;
}

/** PendingApproval → 可序列化 DTO */
export function toStoredApproval(approval: PendingApproval): StoredApproval {
  const { request } = approval;
  return {
    id: approval.id,
    toolName: request.toolName,
    permissions: [...request.permissions],
    args: request.args,
    sessionKey: request.sessionKey,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
  };
}

/** DTO → PendingApproval（restored: true；request/shared 以占位对象重建） */
export function fromStoredApproval(stored: StoredApproval): PendingApproval {
  return {
    id: stored.id,
    createdAt: stored.createdAt,
    expiresAt: stored.expiresAt,
    restored: true,
    request: {
      toolName: stored.toolName,
      permissions: stored.permissions,
      args: stored.args,
      sessionKey: stored.sessionKey,
      // 原始 Request 与 shared Map 不可序列化；恢复后仅占位（孤儿审批单无等待方）
      request: {} as PermissionRequest['request'],
      shared: new Map(),
    },
  };
}

interface ApprovalEntry {
  readonly approval: PendingApproval;
  readonly promise: Promise<ApprovalOutcome>;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  detachAbort?: () => void;
  /** 结算（幂等：首个结算生效，后续调用无操作） */
  settle(status: ApprovalOutcomeStatus, reason: string): void;
}

/** createApprovalManager 配置 */
export interface CreateApprovalManagerOptions {
  /** 持久化存储（可选）。配置后：create 落盘、结算清理 + 审计、restore() 可恢复 */
  store?: ApprovalStore;
}

/** 内存审批管理器实现（可选持久化：配置 store 后支持进程重启恢复） */
export function createApprovalManager(
  options: CreateApprovalManagerOptions = {},
): ApprovalManager {
  const store = options.store;
  const entries = new Map<string, ApprovalEntry>();
  /** 已结算记录（wait() 迟到调用兜底；仅存轻量结果不保留 args 引用） */
  const settled = new Map<string, { status: ApprovalOutcomeStatus; waitedMs: number }>();
  const pendingCbs = new Set<(a: PendingApproval) => void>();
  const settledCbs = new Set<(o: ApprovalOutcome) => void>();
  let seq = 0;

  /** 持久化写入失败不影响审批主流程（审批本身在内存中仍一致） */
  function persistSave(approval: PendingApproval): void {
    if (!store) return;
    void store.save(toStoredApproval(approval)).catch(err => {
      console.warn(`[approval] save failed for ${approval.id}:`, err);
    });
  }

  function persistSettle(entry: ApprovalEntry, outcome: ApprovalOutcome): void {
    if (!store) return;
    const record: ApprovalAuditRecord = {
      id: entry.approval.id,
      toolName: entry.approval.request.toolName,
      status: outcome.status,
      waitedMs: outcome.waitedMs,
      reason: outcome.reason,
      settledAt: Date.now(),
    };
    void store.settle(record.id, record).catch(err => {
      console.warn(`[approval] settle persist failed for ${record.id}:`, err);
    });
  }

  /**
   * 登记 entry（create 与 restore 共用）：挂超时计时器、监听取消信号、
   * 触发 onPending 通知。已过期的（expiresAt <= now）登记后立即以 timeout 结算。
   */
  function registerEntry(
    approval: PendingApproval,
    extra?: { signal?: AbortSignal; startTimer?: boolean },
  ): ApprovalEntry {
    let resolvePromise!: (outcome: ApprovalOutcome) => void;
    const promise = new Promise<ApprovalOutcome>(res => {
      resolvePromise = res;
    });

    const entry: ApprovalEntry = {
      approval,
      promise,
      settled: false,
      settle(status, reason) {
        if (this.settled) return;
        this.settled = true;
        if (this.timer) clearTimeout(this.timer);
        this.detachAbort?.();
        const waitedMs = Date.now() - approval.createdAt;
        entries.delete(approval.id);
        settled.set(approval.id, { status, waitedMs });
        const outcome: ApprovalOutcome = { status, waitedMs, reason, approval };
        persistSettle(this, outcome);
        for (const cb of settledCbs) {
          try {
            cb(outcome);
          } catch {
            // 订阅回调失败不影响审批流程
          }
        }
        resolvePromise(outcome);
      },
    };

    entries.set(approval.id, entry);

    const timeoutAt = approval.expiresAt;
    if (extra?.startTimer !== false && timeoutAt !== undefined) {
      const remaining = timeoutAt - Date.now();
      if (remaining <= 0) {
        // 恢复时已过期：立即结算（waitedMs 按真实等待时长计）
        entry.settle('timeout', 'approval expired before restore');
      } else {
        entry.timer = setTimeout(() => entry.settle('timeout', 'approval wait timeout'), remaining);
      }
    }
    if (extra?.signal) {
      const signal = extra.signal;
      if (signal.aborted) {
        entry.settle('cancelled', 'signal already aborted');
      } else {
        const onAbort = () => entry.settle('cancelled', 'run aborted');
        signal.addEventListener('abort', onAbort, { once: true });
        entry.detachAbort = () => signal.removeEventListener('abort', onAbort);
      }
    }

    for (const cb of pendingCbs) {
      try {
        cb(approval);
      } catch {
        // 订阅回调失败不影响审批流程
      }
    }
    return entry;
  }

  return {
    create(request, createOptions) {
      const id = `apr_${Date.now().toString(36)}_${++seq}`;
      const createdAt = Date.now();
      const timeoutMs = createOptions?.timeoutMs;
      const approval: PendingApproval = {
        id,
        request,
        createdAt,
        expiresAt: timeoutMs !== undefined ? createdAt + timeoutMs : undefined,
      };

      const entry = registerEntry(approval, { signal: createOptions?.signal });
      if (!entry.settled) persistSave(approval);
      return approval;
    },

    async restore() {
      if (!store) return 0;
      let restoredCount = 0;
      const storedList = await store.load();
      for (const stored of storedList) {
        if (entries.has(stored.id)) continue; // 内存中已存在（如同进程重复 restore）
        const approval = fromStoredApproval(stored);
        registerEntry(approval); // 已过期的在此立即以 timeout 结算并写回存储
        if (entries.has(stored.id)) restoredCount++;
      }
      return restoredCount;
    },

    close() {
      for (const entry of entries.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.detachAbort?.();
      }
      entries.clear();
    },

    wait(approval) {
      const entry = entries.get(approval.id);
      if (entry) return entry.promise;
      // 迟到调用：结算记录兜底；完全未知 id 视为已取消
      const record = settled.get(approval.id);
      if (record) {
        return Promise.resolve({
          status: record.status,
          waitedMs: record.waitedMs,
          reason: 'resolved',
          approval,
        });
      }
      return Promise.resolve({
        status: 'cancelled',
        waitedMs: 0,
        reason: 'unknown approval id',
        approval,
      });
    },

    list() {
      return [...entries.values()].map(e => e.approval);
    },

    resolve(id, approved) {
      const entry = entries.get(id);
      if (!entry || entry.settled) return false;
      entry.settle(approved ? 'approved' : 'denied', approved ? 'approved by human' : 'denied by human');
      return true;
    },

    cancel(id) {
      entries.get(id)?.settle('cancelled', 'cancelled by caller');
    },

    onPending(cb) {
      pendingCbs.add(cb);
      return () => pendingCbs.delete(cb);
    },

    onSettled(cb) {
      settledCbs.add(cb);
      return () => settledCbs.delete(cb);
    },
  };
}
