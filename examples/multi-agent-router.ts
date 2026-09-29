/**
 * 多Agent示例：Router 条件路由
 *
 * 演示 createRouter：路由 Agent 先做意图识别，再按结果把请求分发给对应专家 Agent。
 *   意图路由 intent-router → 技术专家 / 账单专员 / 通用客服
 *
 * 本例用到的能力：
 *   1. RouterOpts.resolve：从路由 Agent 输出里解析目标 Agent ID
 *   2. RouterOpts.defaultTarget：解析不出合法目标时的兜底路由
 *   3. 同一批节点多次 run —— 每次重建节点避免共享会话历史（Runtime 按节点缓存）
 *
 * 模型配置统一来自 examples/model.config.ts（本地私有，不提交）：
 *   cp examples/model.config.example.ts examples/model.config.ts
 *
 * 运行：
 *   npx tsx examples/multi-agent-router.ts
 */
import type { Result, RuntimeOptions } from '@aipack-ai/agent';
import { createRouter } from '@aipack-ai/multi-agent';
import type { AgentGraph, AgentNode } from '@aipack-ai/multi-agent';
import { createLlm, formatModelConfig } from './model.config';

const { model, streamFn } = createLlm();

// ─── 辅助函数 ────────────────────────────────────────────────────

function agentRuntime(systemPrompt: string): RuntimeOptions {
  return { model, streamFn, systemPrompt };
}

function preview(text: string, n = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

// ─── 路由图构建 ──────────────────────────────────────────────────

/**
 * 构建 Router 图。
 *
 * 注意：图执行器按 AgentNode 对象缓存 Runtime（同一 sessionKey 复用会话），
 * 因此多轮 run 想要互不干扰时，需要重建节点对象；单次查询则复用同一张图即可。
 */
function buildRouterGraph(): AgentGraph {
  const routerNode: AgentNode = {
    id: 'intent-router',
    name: '意图路由',
    description: '识别用户意图并输出目标 Agent 标识',
    runtime: agentRuntime(
      [
        '你是意图分类器。候选类别：tech（技术实现/报错排查）、billing（账单/退款/发票）、general（其他闲聊）。',
        '只输出一个单词：tech 或 billing 或 general。不要标点，不要解释。',
      ].join('\n'),
    ),
  };

  const techSupport: AgentNode = {
    id: 'tech-support',
    name: '技术专家',
    description: '回答技术实现与报错排查问题',
    runtime: agentRuntime('你是资深工程师，用不超过 3 句话给出可直接执行的排查/实现建议。'),
  };

  const billingSupport: AgentNode = {
    id: 'billing-support',
    name: '账单专员',
    description: '处理账单、退款与发票问题',
    runtime: agentRuntime('你是账单客服，用不超过 3 句话说明处理流程与所需材料，语气专业克制。'),
  };

  const generalSupport: AgentNode = {
    id: 'general-support',
    name: '通用客服',
    description: '兜底处理其他问题',
    runtime: agentRuntime('你是通用客服，用 1 句话友好回应，并说明可以提供的帮助范围。'),
  };

  const targets = [techSupport, billingSupport, generalSupport];

  return createRouter(routerNode, targets, {
    // 从路由 Agent 的输出中解析目标 ID（容错：取首个命中的类别词）
    resolve: (routerResult: Result) => {
      const text = routerResult.content.trim().toLowerCase();
      for (const id of ['tech-support', 'billing-support', 'general-support']) {
        if (text.includes(id.split('-')[0])) return id;
      }
      return 'unknown';
    },
    // 兜底：解析失败或输出非法类别时走通用客服
    defaultTarget: 'general-support',
    // 把原始用户提问（而非路由 Agent 的输出）交给目标专家
    passOriginalInput: true,
  });
}

// ─── 主流程 ──────────────────────────────────────────────────────

async function main() {
  console.log('╔═════════════════════════════════════════════╗');
  console.log('║   Router：意图识别 → 专家分发                ║');
  console.log('╚═════════════════════════════════════════════╝');
  console.log(`✅ 模型: ${formatModelConfig()}\n`);

  const queries = [
    'Node.js 读大文件时进程内存爆了，怎么定位？',
    '上个月的订阅被重复扣款了，能退回吗？',
    '帮我写首诗吧',
  ];

  for (const query of queries) {
    console.log(`──────────────────────────────────────────────`);
    console.log(`▶ 用户提问: ${query}`);

    // 每次重建图：避免多轮查询共用同一会话历史
    const graph = buildRouterGraph();
    const result = await graph.run(query);

    const routed = graph.getState().nodeResults.get('intent-router');
    console.log(`  🔀 路由输出: ${routed ? routed.content.trim() : '（无）'} → 命中 ${result.lastAgentId}`);
    console.log(`  💬 专家回答: ${preview(result.content, 200)}`);
    console.log(`  ✅ 结果: success=${result.success} / stopReason=${result.stopReason}\n`);
  }

  console.log('▶ 路由语义小结');
  console.log('  • passOriginalInput=true：专家拿到的是用户原话，而不是路由器的类别词');
  console.log('  • defaultTarget：路由器输出异常时自动降级到 general-support');
}

main().catch((err) => {
  console.error('运行失败:', err);
  process.exit(1);
});
