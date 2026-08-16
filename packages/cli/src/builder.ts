/**
 * Runtime 构建器：把 CLI 参数解析结果组装成可运行的 Runtime。
 *
 * 职责：
 * 1. 加载 aipack.config.js（可选：approvals.enabled 等）
 * 2. 解析模型（--model 支持 provider/id；未配置时自动探测有 API Key 的提供商）
 * 3. 会话存储与 sessionKey 选择（--continue 找最新 / --session / --name / 自动生成）
 * 4. 权限策略（fs:read 放行；fs:write / shell:exec 按配置走 confirm 或 pending 审批）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createRuntime,
  adaptAiModel,
  createStreamFnFromAi,
  getBuiltinModel,
  getBuiltinModels,
  getBuiltinProviders,
  BUILTIN_PROVIDERS,
  hasProviderConfigured,
  createFileSessionStorage,
  createPermissionPolicy,
  createApprovalManager,
  FileApprovalStore,
} from '@aipack-ai/agent';
import type {
  Runtime,
  Tool,
  SessionStorage,
  ApprovalManager,
  PermissionRequest,
  AiModel,
  PermissionPolicy,
} from '@aipack-ai/agent';
import type { Args } from './args.js';
import { selectTools } from './tools.js';
import { defaultSessionDir, defaultConfigDir, VERSION } from './version.js';

// ─── 配置文件 ─────────────────────────────────────────────────────

export interface AipackCliConfig {
  approvals?: {
    /** 是否启用异步审批（pending 决策 + ApprovalManager）。默认 false（内联 confirm） */
    enabled?: boolean;
    /** 触发审批的能力列表（默认 fs:write 与 shell:exec） */
    capabilities?: string[];
  };
  /** 额外权限规则（追加在内置规则之前，优先裁决） */
  permissionRules?: Array<{
    toolName?: string;
    permission?: string;
    decision: 'allow' | 'deny' | 'confirm' | 'pending';
  }>;
}

export async function loadConfig(cwd: string): Promise<AipackCliConfig> {
  for (const file of ['aipack.config.js', 'aipack.config.mjs']) {
    const full = path.join(cwd, file);
    try {
      await fs.access(full);
      const mod = await import(pathToFileURL(full).href);
      const config = (mod.default ?? mod) as AipackCliConfig;
      return config ?? {};
    } catch {
      // 文件不存在或加载失败 → 继续尝试 / 返回空配置
    }
  }
  return {};
}

// ─── 模型解析 ─────────────────────────────────────────────────────

export interface ResolvedModel {
  aiModel: AiModel;
  /** 是否为目录外自定义模型 */
  custom: boolean;
}

/** 从 --model "provider/id" 或 --provider + --model 解析 */
function splitModelSpec(args: Args): { provider?: string; modelId?: string } {
  if (args.model && args.model.includes('/')) {
    const idx = args.model.indexOf('/');
    return { provider: args.model.slice(0, idx), modelId: args.model.slice(idx + 1) };
  }
  return { provider: args.provider, modelId: args.model };
}

/** 第一个已配置 API Key 的内置提供商 */
function detectDefaultProvider(): { id: string; modelId: string } {
  for (const p of getBuiltinProviders()) {
    if (hasProviderConfigured(p.id)) {
      const models = getBuiltinModels(p.id);
      if (models.length > 0) return { id: p.id, modelId: models[0].id };
    }
  }
  return { id: 'openai', modelId: 'gpt-4o-mini' };
}

/** 为目录外模型构造最小可用的 ai Model（推断 API 类型与 baseUrl） */
function buildCustomModel(providerId: string, modelId: string): AiModel {
  const meta = BUILTIN_PROVIDERS.find(p => p.id === providerId);
  const api = providerId === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
  return {
    id: modelId,
    name: modelId,
    provider: providerId,
    api,
    baseUrl: meta?.baseUrl,
    reasoning: false,
    input: ['text'],
    contextWindow: 128000,
    maxTokens: 16384,
  } as AiModel;
}

export function resolveModel(args: Args): ResolvedModel {
  const spec = splitModelSpec(args);
  const fallback = detectDefaultProvider();
  const providerId = spec.provider ?? fallback.id;
  const modelId = spec.modelId ?? fallback.modelId;

  const builtin = getBuiltinModel(providerId, modelId);
  if (builtin) return { aiModel: builtin, custom: false };
  return { aiModel: buildCustomModel(providerId, modelId), custom: true };
}

// ─── 会话解析 ─────────────────────────────────────────────────────

export interface SessionChoice {
  sessionKey: string;
  /** 是否复用了已存在的会话（--continue / --session） */
  resumed: boolean;
}

/** 列出存储中按 updatedAt 降序的会话 key（最多 50 个） */
export async function listSessionsByRecency(storage: SessionStorage): Promise<string[]> {
  const keys = await storage.list();
  const entries = await Promise.all(
    keys.slice(0, 200).map(async key => {
      const s = await storage.load(key);
      return { key, updatedAt: s?.updatedAt ?? '' };
    }),
  );
  return entries
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(e => e.key);
}

export async function resolveSessionKey(
  args: Args,
  storage: SessionStorage | undefined,
): Promise<SessionChoice> {
  if (args.noSession) return { sessionKey: `ephemeral-${Date.now().toString(36)}`, resumed: false };
  if (args.session) return { sessionKey: sanitizeKey(args.session), resumed: true };
  if (args.name) return { sessionKey: sanitizeKey(args.name), resumed: false };

  if (args.continue && storage) {
    const recent = await listSessionsByRecency(storage);
    if (recent.length > 0) return { sessionKey: recent[0], resumed: true };
    // 没有历史会话 → 落到新建
  }

  return { sessionKey: `s-${Date.now().toString(36)}`, resumed: false };
}

function sanitizeKey(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-:.]/g, '_');
}

// ─── 权限策略 ─────────────────────────────────────────────────────

export interface BuildRuntimeOptions {
  args: Args;
  cwd: string;
  /** 内联人工确认回调（confirm 决策时调用；返回 true 放行） */
  confirmFn?: (req: PermissionRequest) => Promise<boolean>;
  /** 覆盖审批是否启用（默认读配置文件） */
  approvalsEnabled?: boolean;
}

export interface BuiltRuntime {
  runtime: Runtime;
  sessionKey: string;
  storage?: SessionStorage;
  approvalManager?: ApprovalManager;
  model: ResolvedModel;
  config: AipackCliConfig;
}

const DEFAULT_APPROVAL_CAPABILITIES = ['fs:write', 'shell:exec'];

export async function buildRuntime(options: BuildRuntimeOptions): Promise<BuiltRuntime> {
  const { args, cwd } = options;
  const config = await loadConfig(cwd);

  // ── 模型与 streamFn ──
  const model = resolveModel(args);
  const streamFn = createStreamFnFromAi(model.aiModel, {
    apiKey: args.apiKey,
  });

  // ── 工具 ──
  const tools: Tool[] = selectTools({
    tools: args.tools,
    excludeTools: args.excludeTools,
    noTools: args.noTools,
  });

  // ── 会话存储 ──
  const storage = args.noSession
    ? undefined
    : createFileSessionStorage({
        baseDir: args.sessionDir ?? defaultSessionDir(cwd),
      });
  const session = await resolveSessionKey(args, storage);

  // ── 审批与权限 ──
  const approvalsEnabled = options.approvalsEnabled ?? config.approvals?.enabled === true;
  const approvalCaps = new Set(config.approvals?.capabilities ?? DEFAULT_APPROVAL_CAPABILITIES);

  let approvalManager: ApprovalManager | undefined;
  if (approvalsEnabled) {
    approvalManager = createApprovalManager({
      store: new FileApprovalStore({
        baseDir: path.join(defaultConfigDir(), 'approvals'),
      }),
    });
    await approvalManager.restore();
  }

  const policy = buildPermissionPolicy({
    config,
    approvalCaps,
    approvalsEnabled,
    safe: args.safe === true,
    confirmFn: options.confirmFn,
  });

  // ── 系统提示词 ──
  const systemPrompt = buildSystemPrompt(args);

  // ── 组装 Runtime ──
  const runtime = await createRuntime({
    model: adaptAiModel(model.aiModel),
    streamFn,
    systemPrompt,
    tools,
    workspace: cwd,
    config: { cli: true, version: VERSION, cwd },
    sessionStorage: storage,
    thinkingLevel: args.thinking,
    permissionPolicy: policy,
    approvals: approvalManager,
    maxTurns: 50,
    compaction: { enabled: true },
  });

  return {
    runtime,
    sessionKey: session.sessionKey,
    storage,
    approvalManager,
    model,
    config,
  };
}

function buildPermissionPolicy(opts: {
  config: AipackCliConfig;
  approvalCaps: Set<string>;
  approvalsEnabled: boolean;
  safe: boolean;
  confirmFn?: (req: PermissionRequest) => Promise<boolean>;
}): PermissionPolicy {
  const { config, approvalCaps, approvalsEnabled, safe, confirmFn } = opts;

  const customRules = (config.permissionRules ?? []).map(r => ({
    name: `config:${r.permission ?? r.toolName ?? '*'}`,
    toolName: r.toolName ? new RegExp(`^${r.toolName}$`) : undefined,
    permission: r.permission,
    decision: r.decision,
  }));

  /**
   * 高风险能力默认决策（优先级：approvals > safe > 智能默认）：
   * - approvals.enabled → pending（异步审批）
   * - --safe → confirm（全部人工确认）
   * - 默认 → fs:write 放行（工作区防护兜底）、shell:exec 走 confirm，
   *   由 confirmFn 自动放行非危险命令（危险命令才弹选择器）
   */
  const highRiskRules = [...approvalCaps].flatMap(cap => {
    let decision: 'pending' | 'confirm' | 'allow';
    if (approvalsEnabled) decision = 'pending';
    else if (safe) decision = 'confirm';
    else decision = cap === 'fs:write' ? 'allow' : 'confirm';
    return [{ name: `builtin:${cap}:${decision}`, permission: cap, decision }];
  });

  return createPermissionPolicy({
    rules: [
      ...customRules,
      ...highRiskRules,
      { name: 'builtin:read', permission: 'fs:read', decision: 'allow' as const },
      // 未声明 permissions 的安全工具放行
      { name: 'builtin:safe-tools', decision: 'allow' as const },
    ],
    confirmFn,
    defaultDecision: 'deny',
  });
}

function buildSystemPrompt(args: Args): string {
  const base = args.systemPrompt ?? [
    '你是 aipack，一个终端里的 AI 编程助手。',
    '你可以使用工具读写文件、执行命令来完成用户的任务。',
    '回答保持简洁、技术化，使用与用户相同的语言。',
  ].join('\n');

  const appended = args.appendSystemPrompt ?? [];
  return [base, ...appended].join('\n\n');
}
