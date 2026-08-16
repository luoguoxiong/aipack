/**
 * packages/cli/src/approvals.ts
 *
 * CLI 审批集成（Human-in-the-loop）：
 * - setupApprovals：按配置构建 ApprovalManager（FileApprovalStore 持久化）+
 *   便捷 permissionPolicy（危险工具 → pending）；用户已显式配置 policy 时仅提供 manager
 * - attachApprovalPrompt：交互式审批提示（终端打印审批卡片，y/N 询问；串行队列防并发）
 * - 子命令操作：listPendingApprovals / settleApproval（aipack approvals 命令用，
 *   含进程重启恢复的孤儿审批单处理）
 */

import readline from 'readline';
import {
  createApprovalManager,
  FileApprovalStore,
} from '@aipack-ai/agent';
import type {
  ApprovalManager,
  PermissionPolicy,
  PermissionRequest,
} from '@aipack-ai/agent';
import type { ApprovalsConfig, AipackConfig } from './config';

/** 默认审批等待超时：5 分钟 */
const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;

export interface ApprovalSetup {
  approvals: ApprovalManager;
  timeoutMs: number;
  /** 便捷策略（危险工具 → pending）；undefined = 用户已显式配置 permissionPolicy */
  policy?: PermissionPolicy;
}

/** 工具是否命中审批规则：工具名精确匹配，或与 permissions 声明粒度互换匹配 */
function matchesApprovalRule(rule: string, req: PermissionRequest): boolean {
  if (req.toolName === rule) return true;
  return req.permissions.some(
    p => p === rule || p.startsWith(rule + ':') || rule.startsWith(p + ':'),
  );
}

/**
 * 按配置构建审批设施。approvals.enabled 为 false 时返回 undefined（行为不变）。
 */
export function setupApprovals(config: AipackConfig): ApprovalSetup | undefined {
  const approvalConfig: ApprovalsConfig = {
    ...config.approvals,
    timeoutMs: config.approvals?.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
  };
  if (!approvalConfig.enabled) return undefined;

  const approvals = createApprovalManager({
    store: new FileApprovalStore({ baseDir: approvalConfig.baseDir }),
  });

  const setup: ApprovalSetup = {
    approvals,
    timeoutMs: approvalConfig.timeoutMs,
  };

  // 用户已显式配置 permissionPolicy（aipack.config.js 透传）时尊重之，
  // 仅提供 manager（policy 可自行返回 pending 走审批通道）
  if (!config.runtime?.permissionPolicy) {
    const rules = approvalConfig.tools;
    setup.policy = {
      async check(req) {
        return rules.some(rule => matchesApprovalRule(rule, req)) ? 'pending' : 'allow';
      },
    };
  }

  return setup;
}

/** setup → createAipackRuntime 的 overrides（undefined 原样透传） */
export function approvalRuntimeOverrides(
  setup: ApprovalSetup | undefined,
): Record<string, unknown> | undefined {
  if (!setup) return undefined;
  return {
    approvals: setup.approvals,
    approvalTimeoutMs: setup.timeoutMs,
    ...(setup.policy ? { permissionPolicy: setup.policy } : {}),
  };
}

// ─── 交互式审批提示 ────────────────────────────────────────────────

export interface ApprovalPromptHooks {
  /** 询问前暂停其他 stdin 消费者（chat 主 readline；防 y/N 被当作聊天输入） */
  onPauseInput?(): void;
  /** 询问结束后恢复（chat：rl.resume + 重新 prompt） */
  onResumeInput?(): void;
}

/** 审批卡片摘要：args JSON 截断到 200 字符 */
function formatArgs(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args) ?? 'undefined';
  } catch {
    text = String(args);
  }
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

function askQuestion(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: !!process.stdin.isTTY,
    });
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * 附加交互式审批提示：
 * - onPending → 打印审批卡片 → y/N 询问（非 TTY 自动驳回，管道任务保守处理）
 * - onSettled → 打印结算结果（批准 / 驳回 / 超时 / 取消）
 * 多个审批单串行询问（promise 队列），避免终端交错。
 * 需在 approvals.restore() 之前附加，恢复的孤儿审批单也会进入询问队列。
 */
export function attachApprovalPrompt(
  approvals: ApprovalManager,
  hooks: ApprovalPromptHooks = {},
): void {
  let queue: Promise<void> = Promise.resolve();

  approvals.onPending(approval => {
    queue = queue
      .then(async () => {
        const { request } = approval;
        const age = Math.round((Date.now() - approval.createdAt) / 1000);
        const restoredTag = approval.restored ? '（重启恢复，原会话已丢失）' : '';
        console.log('');
        console.log(`┌─ ⏳ 待审批 ${restoredTag}`);
        console.log(`│  工具: ${request.toolName}`);
        console.log(`│  能力: ${request.permissions.join(', ') || '（无声明）'}`);
        console.log(`│  参数: ${formatArgs(request.args)}`);
        console.log(`│  会话: ${request.sessionKey}  等待: ${age}s  单号: ${approval.id}`);

        if (!process.stdin.isTTY) {
          console.log('└─ 非交互模式，自动驳回（可在配置 approvals.baseDir 目录人工处理）');
          approvals.resolve(approval.id, false);
          return;
        }

        hooks.onPauseInput?.();
        try {
          const answer = await askQuestion('└─ 批准执行？[y/N] ');
          const ok = /^y(es)?$/i.test(answer.trim());
          const effective = approvals.resolve(approval.id, ok);
          if (!effective) {
            console.log(`   （审批单 ${approval.id} 已失效：超时或已被处理）`);
          }
        } finally {
          hooks.onResumeInput?.();
        }
      })
      .catch(() => {});
  });

  approvals.onSettled(outcome => {
    const icon =
      outcome.status === 'approved' ? '✅' :
      outcome.status === 'timeout' ? '⏱️' :
      outcome.status === 'cancelled' ? '🚫' : '❌';
    const label =
      outcome.status === 'approved' ? '已批准' :
      outcome.status === 'timeout' ? '等待超时，已拒绝' :
      outcome.status === 'cancelled' ? '已取消' : '已驳回';
    console.log(`${icon} 审批 ${outcome.approval.request.toolName}（${outcome.approval.id}）: ${label}`);
  });
}

// ─── approvals 子命令操作 ─────────────────────────────────────────

/** 列出未决审批单（直接读存储，不依赖 Runtime） */
export async function listPendingApprovals(
  config: AipackConfig,
): Promise<{ id: string; toolName: string; createdAt: number; args: string }[]> {
  const store = new FileApprovalStore({ baseDir: config.approvals.baseDir });
  const stored = await store.load();
  return stored.map(s => ({
    id: s.id,
    toolName: s.toolName,
    createdAt: s.createdAt,
    args: formatArgs(s.args),
  }));
}

/**
 * 批准 / 驳回一条审批单（经 manager restore + resolve 完整链路，结算写审计）。
 * 注：仅对"孤儿"审批单（无存活等待方，如进程重启遗留）能真正生效——
 * 活进程挂起的审批单由其自身的交互提示处理（跨进程通道属 Phase 3）。
 */
export async function settleApproval(
  config: AipackConfig,
  id: string,
  approved: boolean,
): Promise<'settled' | 'not-found'> {
  const approvals = createApprovalManager({
    store: new FileApprovalStore({ baseDir: config.approvals.baseDir }),
  });
  try {
    await approvals.restore();
    if (approvals.list().every(a => a.id !== id)) return 'not-found';
    const ok = approvals.resolve(id, approved);
    if (!ok) return 'not-found';
    // 等待审计落盘（fire-and-forget 持久化）
    await new Promise(r => setTimeout(r, 50));
    return 'settled';
  } finally {
    approvals.close();
  }
}
