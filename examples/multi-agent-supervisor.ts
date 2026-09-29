/**
 * 多Agent示例：Supervisor 层级委派
 *
 * 演示 createSupervisor：Supervisor 先拆解任务，再调度多个 Worker 完成。
 *   主编 supervisor → 背景调研 / 数据分析 / 结论汇总
 *
 * 本例用到的能力：
 *   1. blackboard.tasks 约定：Supervisor 的 outputMapping 把任务清单写成
 *      [{ assignee, task }]，未配置 inputMapping 的 Worker 会自动领取分配给自己的任务
 *   2. Worker.inputMapping：自定义取数（读取上游 Worker 的 blackboard 结果）
 *   3. AgentNode.dependsOn + schedule:'auto'：按依赖拓扑分层，同层并行、层间串行
 *   4. Supervisor 自动把每个 Worker 结果写入 blackboard 的 `${workerId}_result`
 *
 * 模型配置统一来自 examples/model.config.ts（本地私有，不提交）：
 *   cp examples/model.config.example.ts examples/model.config.ts
 *
 * 运行：
 *   npx tsx examples/multi-agent-supervisor.ts
 */
import type { Result, RuntimeOptions } from '@aipack-ai/agent';
import { createSupervisor } from '@aipack-ai/multi-agent';
import type { AgentNode, MultiAgentResult, SharedContext } from '@aipack-ai/multi-agent';
import { createLlm, formatModelConfig } from './model.config';

const { model, streamFn } = createLlm();

// ─── 辅助函数 ────────────────────────────────────────────────────

function agentRuntime(systemPrompt: string): RuntimeOptions {
  return { model, streamFn, systemPrompt };
}

function preview(text: string, n = 150): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/** 宽容解析 Supervisor 输出的任务清单（支持 ```json 包裹） */
function parseTasks(content: string): Array<{ assignee: string; task: string }> {
  const json = content.replace(/```(?:json)?/g, '').trim();
  try {
    const parsed = JSON.parse(json) as Array<{ assignee: string; task: string }>;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ─── Supervisor 节点 ─────────────────────────────────────────────

const supervisor: AgentNode = {
  id: 'supervisor',
  name: '主编',
  description: '拆解调研任务并分派给各 Worker',
  runtime: agentRuntime(
    [
      '你是调研主编。把用户的调研请求拆成 3 个子任务，分派给：researcher、analyst、summarizer。',
      '只输出 JSON 数组，不要 markdown 代码块与解释，格式：',
      '[{"assignee":"researcher","task":"..."},{"assignee":"analyst","task":"..."},{"assignee":"summarizer","task":"..."}]',
    ].join('\n'),
  ),
  outputMapping: (result: Result, ctx: SharedContext) => {
    const tasks = parseTasks(result.content);
    // 约定键名：Worker 未配置 inputMapping 时会按 assignee 领取这里的任务
    ctx.blackboard.set('tasks', tasks);
  },
};

// ─── Worker 节点 ─────────────────────────────────────────────────

/** 第 0 层：无 inputMapping、无 dependsOn → 首批执行，任务来自 blackboard.tasks */
const researcher: AgentNode = {
  id: 'researcher',
  name: '背景调研员',
  description: '梳理背景与现状',
  runtime: agentRuntime('你是行业调研员。用不超过 4 条要点输出背景与现状，每条 1 行。'),
};

/** 第 1 层：inputMapping 显式读取 researcher 的结果（auto 调度会自动插入依赖） */
const analyst: AgentNode = {
  id: 'analyst',
  name: '数据分析师',
  description: '在调研结论上补充量化视角',
  runtime: agentRuntime('你是数据分析师。基于给定背景，补充 3 条可衡量的指标或趋势判断，每条 1 行。'),
  inputMapping: (ctx: SharedContext) => {
    const myTask = (ctx.blackboard.get('tasks') as Array<{ assignee: string; task: string }> | undefined)
      ?.find((t) => t.assignee === 'analyst');
    const upstream = ctx.blackboard.get('researcher_result') as string | undefined;
    return [
      `你的任务：${myTask?.task ?? '补充量化分析'}`,
      '',
      '背景调研结果：',
      upstream ?? '（暂无）',
    ].join('\n');
  },
};

/** 第 2 层：显式声明 dependsOn → 等前两个 Worker 都完成后才开始 */
const summarizer: AgentNode = {
  id: 'summarizer',
  name: '结论汇总',
  description: '汇总为最终结论',
  runtime: agentRuntime('你是主编助理。把材料压缩成一份结论：3 条要点 + 1 句行动建议，输出 Markdown。'),
  dependsOn: ['researcher', 'analyst'],
  inputMapping: (ctx: SharedContext) => [
    '背景调研：',
    (ctx.blackboard.get('researcher_result') as string | undefined) ?? '（暂无）',
    '',
    '量化分析：',
    (ctx.blackboard.get('analyst_result') as string | undefined) ?? '（暂无）',
  ].join('\n'),
};

// ─── 主流程 ──────────────────────────────────────────────────────

async function main() {
  console.log('╔═════════════════════════════════════════════╗');
  console.log('║   Supervisor：主编 + 3 个 Worker（auto 调度） ║');
  console.log('╚═════════════════════════════════════════════╝');
  console.log(`✅ 模型: ${formatModelConfig()}\n`);

  const topic = '调研：多 Agent 编排框架在工程团队中的落地现状';
  console.log(`▶ 调研主题: ${topic}\n`);

  const graph = createSupervisor(supervisor, [researcher, analyst, summarizer], {
    // auto：由 dependsOn / inputMapping 推导依赖，同层并行、层间串行
    schedule: 'auto',
    // 限流，避免触发供应商并发限制
    concurrency: 2,
    // Worker 失败只跳过、不中断整体
    onWorkerError: 'skip',
  });

  const t0 = Date.now();
  graph.on('agent_start', (e) => {
    const ev = e as { agentId: string; agentName: string };
    console.log(`  ▶ [${ev.agentId}] ${ev.agentName} 启动 (${Date.now() - t0}ms)`);
  });
  graph.on('parallel_start', (e) => {
    const ev = e as { agentIds: string[] };
    console.log(`  ⇉ 并行批次: ${ev.agentIds.join(', ')}`);
  });

  const result: MultiAgentResult = await graph.run(topic);

  console.log('\n▶ 任务分派（supervisor 写入 blackboard.tasks）');
  const tasks = result.context.blackboard.get('tasks') as Array<{ assignee: string; task: string }> | undefined;
  if (tasks?.length) {
    for (const t of tasks) {
      console.log(`  • ${t.assignee}: ${preview(t.task, 90)}`);
    }
  } else {
    console.log('  （Supervisor 未返回可解析的 JSON，Worker 已回退使用原始输入）');
  }

  console.log('\n▶ Worker 产出');
  for (const [id, r] of result.agentResults) {
    if (id === 'supervisor') continue;
    console.log(`  • ${id}: ${preview(r.content, 100)}`);
  }

  console.log(`\n▶ 最终结论（最后 Worker: ${result.lastAgentId}）`);
  console.log('──────────────────────────────────────────────');
  console.log(result.content);
  console.log('──────────────────────────────────────────────');

  console.log(`\n▶ 步数 ${result.stepsCompleted} / 停止原因 ${result.stopReason}`);
  console.log(`▶ 失败容忍: ${result.failedAgents?.length ? result.failedAgents.join(', ') : '无失败 Worker'}`);
}

main().catch((err) => {
  console.error('运行失败:', err);
  process.exit(1);
});
