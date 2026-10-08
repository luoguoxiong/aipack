/**
 * 子 agent / Task 工具：模型通过 task 工具启动隔离上下文的子 agent。
 *
 * 设计（对标 Claude Code 的 Task 工具）：
 * - 每次 task 调用创建一个独立子 Runtime（独立消息历史 + 独立系统提示词），
 *   以 ephemeral 请求运行到结束，仅把最终报告返回主对话 —— 检索/分析产生的
 *   大量工具输出不污染主上下文
 * - 同一回合的多个 task 调用由框架并行执行（parallelToolCalls 默认开启），
 *   天然获得并行子任务能力
 * - 防递归：子 agent 工具集永远不含 task 自身（固定一层，无嵌套子 agent）
 * - 权限复用：子 agent 的工具调用走与主 agent 相同的 PermissionPolicy /
 *   审批管理器（写文件、shell 仍需确认/审批）
 *
 * 子 agent 定义来源：
 * - 内置 general-purpose（继承主 agent 当前工具集），始终可用
 * - aipack.config.js 的 agents 字段（description/prompt 必填，tools/model/maxTurns 可选）
 */
import {
  adaptAiModel,
  createRequest,
  createRuntime,
  createStreamFnFromAi,
} from '@aipack-ai/agent';
import type {
  AiModel,
  ApprovalManager,
  PermissionPolicy,
  Runtime,
  RuntimeOptions,
  ThinkingLevel,
  Tool,
  ToolResult,
} from '@aipack-ai/agent';

/** task 工具名（selectTools 白/黑名单校验用） */
export const TASK_TOOL_NAME = 'task';

/** 内置通用子 agent 名称（同名自定义定义可覆盖） */
export const GENERAL_PURPOSE_AGENT = 'general-purpose';

/** 子 agent 默认最大对话回合数（短生命周期任务，低于主 agent 默认 50） */
export const DEFAULT_SUBAGENT_MAX_TURNS = 30;

/** 子 agent 报告长度上限（字符）：超长截断，防止撑爆主对话上下文 */
export const MAX_TASK_RESULT_CHARS = 30_000;

/**
 * task 工具启用时主 runtime 的单工具超时兜底（毫秒）。
 * 子 agent 完整运行发生在 task 工具的 execute 内，受主 runtime 单工具超时约束；
 * 默认 120s 对子 agent 不够，抬高到 10 分钟（与 bash 超时上限对齐）。
 */
export const TASK_TOOL_TIMEOUT_MS = 600_000;

/** agent 名称约束：字母数字下划线连字符（模型按名调用，禁空格/特殊字符） */
const AGENT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** 子 agent 定义（aipack.config.js 的 agents 字段值） */
export interface SubagentDefinition {
  /** 描述（注入 task 工具描述，供主模型选择 agent 类型） */
  description: string;
  /** 子 agent 系统提示词（人设/职责） */
  prompt: string;
  /** 工具白名单（内置工具名子集；缺省继承主 agent 当前工具集） */
  tools?: string[];
  /** 模型覆盖（provider/id；缺省跟随主 agent 当前模型，/model 切换后跟随） */
  model?: string;
  /** 子 agent 最大对话回合数（默认 30） */
  maxTurns?: number;
}

// ─── 定义加载与校验 ───────────────────────────────────────────────

export interface LoadedSubagents {
  definitions: Map<string, SubagentDefinition>;
  warnings: string[];
}

const GENERAL_PURPOSE_DEFINITION: SubagentDefinition = {
  description: '通用任务执行：检索/分析/修改文件等（继承主 agent 当前工具集）',
  prompt: '你是通用任务执行 agent。专注完成分配的任务，可使用工具检索与操作文件，最终输出清晰完整的结果报告。',
};

/**
 * 加载子 agent 定义：内置 general-purpose + aipack.config.js 的 agents 字段。
 * 校验失败的定义跳过并给出告警（不阻塞启动）；同名定义覆盖内置 general-purpose。
 * validToolNames：用于 tools 白名单校验（内置工具名，不含 task 自身）。
 */
export function loadSubagentConfigs(
  agentsConfig: Record<string, SubagentDefinition> | undefined,
  validToolNames: string[],
): LoadedSubagents {
  const definitions = new Map<string, SubagentDefinition>();
  const warnings: string[] = [];
  definitions.set(GENERAL_PURPOSE_AGENT, { ...GENERAL_PURPOSE_DEFINITION });

  if (agentsConfig === undefined) return { definitions, warnings };
  if (typeof agentsConfig !== 'object' || Array.isArray(agentsConfig)) {
    warnings.push('agents 配置必须是对象（{ [名称]: { description, prompt } }），已忽略');
    return { definitions, warnings };
  }

  for (const [name, value] of Object.entries(agentsConfig)) {
    if (!AGENT_NAME_RE.test(name)) {
      warnings.push(`agent 名称 "${name}" 非法（仅允许字母数字_-），已忽略`);
      continue;
    }
    if (typeof value !== 'object' || value === null) {
      warnings.push(`agent "${name}" 配置必须是对象，已忽略`);
      continue;
    }
    const raw = value as Partial<SubagentDefinition>;
    if (typeof raw.description !== 'string' || !raw.description.trim()) {
      warnings.push(`agent "${name}" 缺少 description，已忽略`);
      continue;
    }
    if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) {
      warnings.push(`agent "${name}" 缺少 prompt，已忽略`);
      continue;
    }

    const def: SubagentDefinition = {
      description: raw.description.trim(),
      prompt: raw.prompt.trim(),
    };

    if (raw.tools !== undefined) {
      if (!Array.isArray(raw.tools) || raw.tools.some(t => typeof t !== 'string')) {
        warnings.push(`agent "${name}" 的 tools 必须是字符串数组，已忽略（继承全部工具）`);
      } else {
        const requested = raw.tools.map(t => t.trim()).filter(Boolean);
        const unknown = requested.filter(t => !validToolNames.includes(t));
        if (unknown.length > 0) {
          warnings.push(`agent "${name}" 的 tools 含未知工具名（已忽略）: ${unknown.join(', ')}`);
        }
        const known = requested.filter(t => validToolNames.includes(t));
        if (known.length === 0) {
          warnings.push(`agent "${name}" 的 tools 过滤后为空，该 agent 将没有任何工具（纯文本任务）`);
        }
        def.tools = known;
      }
    }

    if (raw.model !== undefined) {
      if (typeof raw.model === 'string' && raw.model.trim()) {
        def.model = raw.model.trim();
      } else {
        warnings.push(`agent "${name}" 的 model 必须是非空字符串，已忽略`);
      }
    }

    if (raw.maxTurns !== undefined) {
      const n = Number(raw.maxTurns);
      if (Number.isInteger(n) && n > 0) {
        def.maxTurns = n;
      } else {
        warnings.push(`agent "${name}" 的 maxTurns 必须是正整数，已忽略`);
      }
    }

    definitions.set(name, def);
  }

  return { definitions, warnings };
}

// ─── task 工具 ────────────────────────────────────────────────────

export interface TaskToolDeps {
  /** 主 agent 当前模型（getter：/model 切换后子 agent 跟随；definition.model 优先） */
  getModel: () => AiModel;
  /** definition.model 的解析器（provider/id → AiModel）；缺省则忽略 model 覆盖 */
  resolveModelSpec?: (spec: string) => AiModel | undefined;
  /** API Key 透传（--api-key） */
  apiKey?: string;
  /** 工作区目录 */
  cwd: string;
  /** 子 agent 可用工具集（主 agent 当前内置工具，不含 task） */
  tools: Tool[];
  /** 子 agent 定义表（运行时读取，支持热态更新） */
  definitions: Map<string, SubagentDefinition>;
  /** 与主 agent 共用的权限策略（写文件/shell 仍走确认/审批） */
  permissionPolicy?: PermissionPolicy;
  /** 与主 agent 共用的审批管理器 */
  approvals?: ApprovalManager;
  /** 项目记忆内容（注入子 agent 系统提示词；无记忆文件时为空） */
  memoryContent?: string;
  /** 思考级别（继承主 agent 配置；仅对 reasoning 模型生效） */
  thinkingLevel?: ThinkingLevel;
  /** 测试注入：替换 createRuntime */
  createRuntimeFn?: (options: RuntimeOptions) => Promise<Runtime>;
}

/** 模块内自增计数器：sessionKey 去重（同 agent 并行调用互不串历史） */
let taskCounter = 0;

function textResult(text: string, details?: unknown): ToolResult {
  return { content: [{ type: 'text', text }], details: details ?? {} };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: `错误: ${message}` }], details: { error: message } };
}

/** task 工具描述：列出可用子 agent（主模型据此选择类型与拆分任务） */
function buildTaskDescription(definitions: Map<string, SubagentDefinition>): string {
  const lines = [
    '启动子 agent 在隔离上下文中执行独立任务，运行结束后返回其最终报告。',
    '子 agent 拥有独立的消息历史，看不到主对话内容；prompt 必须包含完成任务所需的全部信息。',
    '适用场景：大范围文件检索与分析（海量工具输出不进入主对话）、可并行的独立子任务（同一回合多次调用 task 自动并行执行）。',
    '',
    '可用子 agent:',
  ];
  for (const [name, def] of definitions) {
    lines.push(`- ${name}: ${def.description}`);
  }
  return lines.join('\n');
}

/** 子 agent 系统提示词：人设 + 输出契约（报告返回主 agent，不面向用户） */
function buildSubagentPrompt(def: SubagentDefinition, memoryContent: string | undefined): string {
  const parts = [
    '你是 aipack 的子 agent，在隔离上下文中执行单一任务。',
    def.prompt,
    [
      '运行规则:',
      '- 你看不到主对话，不要向用户提问；基于任务 prompt 中的信息完成工作。',
      '- 你的最终回复会被原样返回给主 agent 作为任务报告：结论先行、结构清晰、附关键证据（文件路径、行号、命令输出摘要）。',
    ].join('\n'),
  ];
  if (memoryContent?.trim()) {
    parts.push(
      '以下项目记忆来自记忆文件（AIPACK.md / AGENTS.md / CLAUDE.md），是项目既定约定，请遵循:',
      memoryContent.trim(),
    );
  }
  return parts.filter(s => s !== '').join('\n\n');
}

/** 构建 task 工具（每次 CLI 启动构建一次；每次工具调用创建独立子 Runtime） */
export function createTaskTool(deps: TaskToolDeps): Tool {
  const create = deps.createRuntimeFn ?? createRuntime;

  return {
    name: TASK_TOOL_NAME,
    description: buildTaskDescription(deps.definitions),
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: '子 agent 类型（见描述中的可用列表）' },
        prompt: { type: 'string', description: '给子 agent 的完整任务指令（子 agent 看不到主对话）' },
      },
      required: ['agent', 'prompt'],
    },
    // task 自身无需权限门禁：真正的写文件/shell 由子 agent 的工具各自裁决
    async execute(_id, rawArgs, signal) {
      const args = rawArgs as { agent?: unknown; prompt?: unknown };
      const definitions = deps.definitions;
      const available = [...definitions.keys()].join(', ');

      if (typeof args.agent !== 'string' || !args.agent.trim()) {
        return errorResult(`缺少 agent 参数（可用: ${available}）`);
      }
      if (typeof args.prompt !== 'string' || !args.prompt.trim()) {
        return errorResult('缺少 prompt 参数（子 agent 看不到主对话，需提供完整任务指令）');
      }
      const agentName = args.agent.trim();
      const def = definitions.get(agentName);
      if (!def) {
        return errorResult(`未知子 agent "${agentName}"（可用: ${available}）`);
      }

      // 模型：definition.model 覆盖 > 主 agent 当前模型（getter 保证 /model 切换后跟随）
      let aiModel = deps.getModel();
      if (def.model) {
        const overridden = deps.resolveModelSpec?.(def.model);
        if (overridden) aiModel = overridden;
      }

      // 工具：定义白名单过滤；永远排除 task 自身（防递归）
      const baseTools = deps.tools.filter(t => t.name !== TASK_TOOL_NAME);
      const tools = def.tools ? baseTools.filter(t => def.tools!.includes(t.name)) : baseTools;

      const sessionKey = `task-${agentName}-${Date.now().toString(36)}-${taskCounter++}`;
      const startedAt = Date.now();
      let subRuntime: Runtime | undefined;

      // 中止传播：主回合 Ctrl+C / 工具超时 → 同步终止子 agent 运行
      const onAbort = (): void => subRuntime?.abort(sessionKey);
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        subRuntime = await create({
          model: adaptAiModel(aiModel),
          streamFn: createStreamFnFromAi(aiModel, { apiKey: deps.apiKey }),
          systemPrompt: buildSubagentPrompt(def, deps.memoryContent),
          tools,
          workspace: deps.cwd,
          maxTurns: def.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS,
          permissionPolicy: deps.permissionPolicy,
          approvals: deps.approvals,
          config: { cli: true, subagent: agentName },
          thinkingLevel: deps.thinkingLevel,
          // 子 agent 会话短且 ephemeral，无需内置摘要压缩（硬截断兜底足够）
          compaction: { enabled: false },
        });
        const result = await subRuntime.run(
          createRequest(args.prompt.trim(), {
            channel: 'cli',
            sessionKey,
            ephemeral: true,
          }),
        );

        if (!result.success || result.error) {
          return errorResult(`子 agent "${agentName}" 运行失败: ${result.error ?? '未知错误'}`);
        }

        const truncated = result.content.length > MAX_TASK_RESULT_CHARS;
        const content = truncated
          ? result.content.slice(0, MAX_TASK_RESULT_CHARS)
            + `\n...[子 agent 报告超过 ${MAX_TASK_RESULT_CHARS} 字符，已截断]`
          : result.content;
        const suffix = result.stopReason === 'max_turns'
          ? '\n[注意：子 agent 因回合数上限被截断，报告可能不完整]'
          : '';

        return textResult(content + suffix, {
          agent: agentName,
          stopReason: result.stopReason,
          toolsUsed: result.toolsUsed,
          usage: result.usage,
          elapsedMs: Date.now() - startedAt,
          truncated,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (signal?.aborted) {
          return errorResult(`子 agent "${agentName}" 已被中止`);
        }
        return errorResult(`子 agent "${agentName}" 执行异常: ${message}`);
      } finally {
        signal?.removeEventListener('abort', onAbort);
        try {
          await subRuntime?.close();
        } catch {
          // 关闭失败不影响结果返回
        }
      }
    },
  };
}
