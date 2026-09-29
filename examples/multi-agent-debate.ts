/**
 * 多Agent示例：Debate 对抗评审
 *
 * 演示 createDebate：Proposer 生成 → Reviewer 审查 → 未通过则把反馈回灌给 Proposer，
 * 循环直到收敛或达到最大轮次。适合「生成 + 审查」类场景（代码评审、文案合规检查）。
 *   编码工程师 coder ↔ 代码审查官 reviewer
 *
 * 本例用到的能力：
 *   1. DebateOpts.convergeWhen：自定义收敛判定（这里约定 reviewer 首行输出 APPROVED）
 *   2. DebateOpts.feedbackTransform：把审查意见转成下一轮 Proposer 的输入
 *   3. stream()：消费 round_start / agent_result / converged / graph_done 事件
 *
 * 模型配置统一来自 examples/model.config.ts（本地私有，不提交）：
 *   cp examples/model.config.example.ts examples/model.config.ts
 *
 * 运行：
 *   npx tsx examples/multi-agent-debate.ts
 */
import type { Result, RuntimeOptions } from '@aipack-ai/agent';
import { createDebate } from '@aipack-ai/multi-agent';
import type { AgentNode } from '@aipack-ai/multi-agent';
import { createLlm, formatModelConfig } from './model.config';

const { model, streamFn } = createLlm();

// ─── 辅助函数 ────────────────────────────────────────────────────

function agentRuntime(systemPrompt: string): RuntimeOptions {
  return { model, streamFn, systemPrompt };
}

function preview(text: string, n = 180): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

// ─── 双方 Agent ──────────────────────────────────────────────────

const proposer: AgentNode = {
  id: 'coder',
  name: '编码工程师',
  description: '按需求产出 TypeScript 实现',
  runtime: agentRuntime(
    [
      '你是 TypeScript 工程师。用严格模式 TypeScript 实现需求，含入参校验与 JSDoc。',
      '只输出一个代码块，不要前后缀说明。',
    ].join('\n'),
  ),
};

const reviewer: AgentNode = {
  id: 'reviewer',
  name: '代码审查官',
  description: '审查代码并决定是否放行',
  runtime: agentRuntime(
    [
      '你是严格的代码审查官。检查正确性、边界条件、类型安全、可读性。',
      '判定规则（务必遵守）：',
      '- 代码完全满足要求：第一行只写 APPROVED，第二行起写一句总评。',
      '- 仍有问题：第一行只写 REVISE，随后每行一条具体修改意见（最多 2 条）。',
    ].join('\n'),
  ),
};

// ─── 主流程 ──────────────────────────────────────────────────────

async function main() {
  console.log('╔═════════════════════════════════════════════╗');
  console.log('║   Debate：编码工程师 ↔ 代码审查官            ║');
  console.log('╚═════════════════════════════════════════════╝');
  console.log(`✅ 模型: ${formatModelConfig()}\n`);

  const requirement = [
    '实现一个 TypeScript 纯函数 debounce：',
    '入参 fn（无返回值的函数）与 waitMs，返回包装后的函数，并支持调用 cancel() 取消等待中的执行。',
    '要求：1) 严格 TypeScript 泛型与类型标注；2) cancel 必须清理定时器；',
    '3) waitMs <= 0 或非有限数时抛 RangeError。',
  ].join('');

  console.log(`▶ 需求: ${preview(requirement, 120)}\n`);

  const graph = createDebate(proposer, reviewer, {
    maxRounds: 3,
    // 收敛条件：审查官放行
    convergeWhen: (reviewerResult: Result) => /APPROVED/i.test(reviewerResult.content),
    // 自定义回灌：把「本轮代码 + 修改意见」一起交给 Proposer 修订
    feedbackTransform: (reviewerResult: Result, proposerResult: Result) => [
      '你的上一版实现：',
      proposerResult.content,
      '',
      '审查意见：',
      reviewerResult.content,
      '',
      '请按意见修改后重新输出完整代码（仍只输出一个代码块）。',
    ].join('\n'),
  });

  let round = 0;
  let finalContent = '';
  let stopReason = '';

  // 流式消费：每轮的执行过程实时可见
  for await (const event of graph.stream(requirement)) {
    switch (event.type) {
      case 'round_start':
        round = event.round;
        console.log(`\n═══ 第 ${event.round} 轮 ═══`);
        break;
      case 'agent_result':
        console.log(`  ${event.agentId === 'reviewer' ? '🔍' : '✍️ '} ${event.agentName}: ${preview(event.result.content, 140)}`);
        break;
      case 'agent_error':
        console.log(`  ❌ ${event.agentName} 执行失败: ${event.error}`);
        break;
      case 'converged':
        console.log(`  🎯 ${event.reason}`);
        break;
      case 'graph_done':
        finalContent = event.result.content;
        stopReason = event.result.stopReason;
        break;
      case 'graph_error':
        console.log(`  ❌ 图执行失败: ${event.error}`);
        break;
    }
  }

  console.log('\n══════════════════════════════════════════════');
  console.log(`▶ 最终采纳版本（取 Proposer 最后一轮输出）`);
  console.log('──────────────────────────────────────────────');
  console.log(finalContent);
  console.log('──────────────────────────────────────────────');
  console.log(`▶ 总轮数 ${round} / 停止原因 ${stopReason}`);
  console.log('  停止原因含义：converged_at_round_N=审查通过，max_rounds_reached=达轮次上限仍未通过');
}

main().catch((err) => {
  console.error('运行失败:', err);
  process.exit(1);
});
