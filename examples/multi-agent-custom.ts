/**
 * 多Agent示例：自定义 AgentGraph（自由图）
 *
 * 当 Pipeline / Router / Supervisor / Debate / MapReduce 都不够用时，
 * 直接用 createAgentGraph 手工定义一张图：任意 fan-out 并行、条件边、环图返工流。
 *
 * 本例结构：
 *
 *        ┌──→ researcher ──┐
 *   planner ─(fan-out)     ├──→ reviewer ──(REVISE 条件边)──→ writer ──→ reviewer …（环）
 *        └──→ writer ──────┘
 *
 *   1. planner    拆解方案要点（入口）
 *   2. researcher 与 writer 并行执行（fan-out 并行 wave）
 *   3. reviewer   汇总评审：APPROVED 走终稿节点，REVISE 则沿条件边回到 writer 返工
 *   4. finalizer  整理终稿并写入 blackboard.final_done，触发 setFinish 收尾
 *   5. maxVisitsPerNode 安全阀 + 条件边轮次上限，防止环图死循环
 *
 * 本例用到的能力：
 *   1. createAgentGraph({ concurrency, maxVisitsPerNode })
 *   2. AgentEdge.condition / transform 与 AgentNode.inputMapping / outputMapping
 *   3. setFinish 全局终止条件 + blackboard 记录跨节点状态（返工轮次）
 *   4. GraphDebugger：导出 DOT 结构图 + 记录执行 Trace
 *
 * 模型配置统一来自 examples/model.config.ts（本地私有，不提交）：
 *   cp examples/model.config.example.ts examples/model.config.ts
 *
 * 运行：
 *   npx tsx examples/multi-agent-custom.ts
 */
import type { Result, RuntimeOptions } from '@aipack-ai/agent';
import { createAgentGraph, createDebugger } from '@aipack-ai/multi-agent';
import type { AgentEdge, AgentGraph, AgentNode, SharedContext } from '@aipack-ai/multi-agent';
import { createLlm, formatModelConfig } from './model.config';

const { model, streamFn } = createLlm();

const MAX_ROUNDS = 3;

// ─── 辅助函数 ────────────────────────────────────────────────────

function agentRuntime(systemPrompt: string): RuntimeOptions {
  return { model, streamFn, systemPrompt };
}

function preview(text: string, n = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/** 读取 blackboard 上的评审轮次（未开始视为 0） */
function reviewRound(ctx: SharedContext): number {
  return (ctx.blackboard.get('review_round') as number | undefined) ?? 0;
}

// ─── 节点定义 ────────────────────────────────────────────────────

const planner: AgentNode = {
  id: 'planner',
  name: '方案规划师',
  description: '把目标拆成可执行要点',
  runtime: agentRuntime('你是可观测性架构师。把用户目标拆成 3 条可执行要点，每条 1 行，编号列出。'),
  outputMapping: (result: Result, ctx: SharedContext) => {
    ctx.blackboard.set('plan', result.content);
  },
};

const researcher: AgentNode = {
  id: 'researcher',
  name: '现状调研员',
  description: '补充落地约束与常见坑',
  runtime: agentRuntime('你是 SRE 顾问。基于给定方案要点，补充 2 条落地风险与规避办法，每条 1 行。'),
  outputMapping: (result: Result, ctx: SharedContext) => {
    ctx.blackboard.set('researcher_result', result.content);
  },
};

const writer: AgentNode = {
  id: 'writer',
  name: '方案撰写',
  description: '产出方案正文或修改稿',
  runtime: agentRuntime('你是技术方案撰稿人。基于方案要点与调研补充，写一份 200 字以内的落地方案，输出 Markdown 正文。'),
  outputMapping: (result: Result, ctx: SharedContext) => {
    ctx.blackboard.set('draft', result.content);
  },
};

const reviewer: AgentNode = {
  id: 'reviewer',
  name: '方案评审',
  description: '评审方案并决定是否返工',
  runtime: agentRuntime(
    [
      '你是可观测性方案评审专家。检查方案是否可落地、是否遗漏关键度量项。',
      '判定规则：',
      '- 通过：第一行 ONLY 输出 APPROVED，之后给一句总评。',
      '- 返工：第一行 ONLY 输出 REVISE，之后给最多 2 条具体修改意见。',
    ].join('\n'),
  ),
  // 两条入边（researcher→reviewer、writer→reviewer）都没有 transform，
  // 因此统一走 inputMapping，从 blackboard 拼装评审输入
  inputMapping: (ctx: SharedContext) => [
    '本轮待评审方案：',
    (ctx.blackboard.get('draft') as string | undefined) ?? '（无）',
    '',
    '调研补充的风险：',
    (ctx.blackboard.get('researcher_result') as string | undefined) ?? '（无）',
  ].join('\n'),
  outputMapping: (result: Result, ctx: SharedContext) => {
    const approved = /APPROVED/i.test(result.content);
    ctx.blackboard.set('review_status', approved ? 'APPROVED' : 'REVISE');
    ctx.blackboard.set('review_comment', result.content);
    ctx.blackboard.set('review_round', reviewRound(ctx) + 1);
  },
};

/** 终稿整理：评审通过后，把 draft 与评审结论整理成最终交付物 */
const finalizer: AgentNode = {
  id: 'finalizer',
  name: '终稿整理',
  description: '整理终稿并附评审结论',
  runtime: agentRuntime('你是交付编辑。输出「方案正文」与「评审结论」两段，方案正文优先保留已通过评审的原文措辞。'),
  inputMapping: (ctx: SharedContext) => [
    '已通过评审的方案：',
    (ctx.blackboard.get('draft') as string | undefined) ?? '（无）',
    '',
    '评审意见：',
    (ctx.blackboard.get('review_comment') as string | undefined) ?? '（无）',
  ].join('\n'),
  outputMapping: (_result: Result, ctx: SharedContext) => {
    // 供 setFinish 判断：终稿已产出即可结束
    ctx.blackboard.set('final_done', true);
  },
};

const nodes: AgentNode[] = [planner, researcher, writer, reviewer, finalizer];

// ─── 边定义 ──────────────────────────────────────────────────────

const edges: AgentEdge[] = [
  // 1) fan-out：planner 完成后 researcher 与 writer 同时开始（并行 wave）
  { from: 'planner', to: 'researcher', transform: (r) => r.content },
  { from: 'planner', to: 'writer', transform: (r) => r.content },

  // 2) join：两条边指向同一目标时只执行一次，输入由 reviewer.inputMapping 决定
  { from: 'researcher', to: 'reviewer' },
  { from: 'writer', to: 'reviewer' },

  // 3) 环：评审未通过且未超轮次上限 → 沿条件边回到 writer 返工
  {
    from: 'reviewer',
    to: 'writer',
    condition: (_result: Result, ctx: SharedContext) =>
      ctx.blackboard.get('review_status') === 'REVISE' && reviewRound(ctx) < MAX_ROUNDS,
    transform: (result: Result, ctx: SharedContext) => [
      `第 ${reviewRound(ctx)} 轮评审未通过，请按以下意见修改并重写方案：`,
      result.content,
      '',
      '原始要点：',
      (ctx.blackboard.get('plan') as string | undefined) ?? '（无）',
    ].join('\n'),
  },

  // 4) 出口：评审通过 → 终稿整理（条件边）
  {
    from: 'reviewer',
    to: 'finalizer',
    condition: (_result: Result, ctx: SharedContext) =>
      ctx.blackboard.get('review_status') === 'APPROVED',
  },
];

// ─── 主流程 ──────────────────────────────────────────────────────

async function main() {
  console.log('╔═════════════════════════════════════════════╗');
  console.log('║   自定义 AgentGraph：并行 + 条件环 + 评审    ║');
  console.log('╚═════════════════════════════════════════════╝');
  console.log(`✅ 模型: ${formatModelConfig()}\n`);

  const graph: AgentGraph = createAgentGraph({
    // 并行 wave 的最大并发数
    concurrency: 2,
    // 环图安全阀：单节点最多被访问 MAX_ROUNDS+1 次（writer/planner 各多一次），
    // 超限以 stopReason='max_visits_exceeded' 安全截断
    maxVisitsPerNode: MAX_ROUNDS + 1,
  });

  for (const node of nodes) {
    graph.addNode(node);
  }
  for (const edge of edges) {
    graph.addEdge(edge);
  }
  graph.setEntry('planner');
  // 全局终止条件：终稿产出即结束（即使 reviewer 仍在要求返工也不会无限循环）
  graph.setFinish((ctx: SharedContext) => ctx.blackboard.get('final_done') === true);

  // 调试工具：导出图结构（DOT）+ 记录执行 Trace（trace() 内部会跑一次图）
  const debugger_ = createDebugger(graph);
  debugger_.setGraphMeta(nodes, edges, 'planner');

  console.log('▶ 图结构（Graphviz DOT，可粘到在线渲染器查看）');
  console.log('──────────────────────────────────────────────');
  console.log(debugger_.toDOT());
  console.log('──────────────────────────────────────────────');

  const input = '给一个初创团队设计可观测性方案，要求 7 天内见效';
  console.log(`\n▶ 输入: ${input}\n`);

  const trace = await debugger_.trace(input);
  console.log('▶ 执行 Trace');
  console.log('──────────────────────────────────────────────');
  console.log(debugger_.traceToLog(trace));
  console.log('──────────────────────────────────────────────');

  const state = graph.getState();
  console.log('\n▶ 节点状态快照');
  for (const [id, nodeState] of state.nodeStates) {
    console.log(`  • ${id}: ${nodeState}`);
  }

  console.log('\n▶ 最终方案（最后一个节点输出）');
  console.log('──────────────────────────────────────────────');
  console.log(trace.result.content || preview('（无输出）', 20));
  console.log('──────────────────────────────────────────────');

  console.log(`\n▶ 步数 ${trace.result.stepsCompleted} / 停止原因 ${trace.result.stopReason}`);
  console.log(`▶ 返工轮次上限 ${MAX_ROUNDS}；成功=${trace.result.success}`);
  console.log('  stopReason 含义：finish_condition=终稿产出触发 setFinish');
  console.log('                  completed=无出边可走而自然结束（如轮次用完）');
  console.log('                  max_visits_exceeded=触到 maxVisitsPerNode 安全阀被截断');
}

main().catch((err) => {
  console.error('运行失败:', err);
  process.exit(1);
});
