/**
 * 多Agent示例：Pipeline 顺序链
 *
 * 演示 createPipeline：A → B → C 严格串行，前一个 Agent 的输出成为后一个的输入。
 *   大纲师 outliner → 撰稿 writer → 润色 editor
 *
 * 本例用到的能力：
 *   1. AgentNode.outputMapping：把节点输出写入 blackboard（跨节点共享）
 *   2. AgentNode.inputMapping：从 blackboard 组装下一个节点的输入（比默认传递更可控）
 *   3. AgentGraph.on(event)：监听 agent_start / agent_result / graph_done 事件
 *
 * 模型配置统一来自 examples/model.config.ts（本地私有，不提交）：
 *   cp examples/model.config.example.ts examples/model.config.ts
 *
 * 运行：
 *   npx tsx examples/multi-agent-pipeline.ts
 */
import type { Result, RuntimeOptions } from '@aipack-ai/agent';
import { createPipeline } from '@aipack-ai/multi-agent';
import type { AgentNode, MultiAgentResult } from '@aipack-ai/multi-agent';
import { createLlm, formatModelConfig } from './model.config';

const { model, streamFn } = createLlm();

// ─── 辅助函数 ────────────────────────────────────────────────────

/** 每个 Agent 一份独立的 Runtime 配置（共享同一组 model + streamFn） */
function agentRuntime(systemPrompt: string): RuntimeOptions {
  return { model, streamFn, systemPrompt };
}

/** 压缩空白并截断，便于控制台预览 */
function preview(text: string, n = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/** token 用量摘要 */
function usage(result: MultiAgentResult): string {
  const parts = Object.entries(result.totalUsage).map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(', ') : '（模型未回传）';
}

// ─── Agent 节点定义 ──────────────────────────────────────────────

/** 1) 大纲师：把主题拆成大纲，并写入 blackboard.outline */
const outliner: AgentNode = {
  id: 'outliner',
  name: '大纲师',
  description: '把写作主题拆成结构化大纲',
  runtime: agentRuntime('你是技术写作大纲师。输出不超过 4 条编号大纲，每条 1 行，不要多余解释。'),
  outputMapping: (result: Result, ctx) => {
    ctx.blackboard.set('outline', result.content);
  },
};

/** 2) 撰稿：用 inputMapping 组合「原始需求 + 大纲」，而不是直接吃上一个节点的原文 */
const writer: AgentNode = {
  id: 'writer',
  name: '撰稿',
  description: '依据大纲撰写技术短文',
  runtime: agentRuntime('你是技术撰稿人。按给定的大纲写成短文，控制在 200 字以内，输出纯正文。'),
  inputMapping: (ctx) => {
    const topic = ctx.blackboard.get('__original_input__') as string;
    const outline = ctx.blackboard.get('outline') as string;
    return `主题：${topic}\n\n大纲：\n${outline}\n\n请按大纲写正文。`;
  },
  outputMapping: (result: Result, ctx) => {
    ctx.blackboard.set('draft', result.content);
  },
};

/** 3) 润色：默认接收上一个节点的输出（未配置 inputMapping 时自动传递 prevResult.content） */
const editor: AgentNode = {
  id: 'editor',
  name: '润色',
  description: '润色成最终 Markdown 稿件',
  runtime: agentRuntime('你是资深编辑。修正语病、统一术语，输出 Markdown（一个二级标题 + 正文），不要写修改说明。'),
};

// ─── 主流程 ──────────────────────────────────────────────────────

async function main() {
  console.log('╔═════════════════════════════════════════════╗');
  console.log('║   Pipeline：大纲师 → 撰稿 → 润色            ║');
  console.log('╚═════════════════════════════════════════════╝');
  console.log(`✅ 模型: ${formatModelConfig()}\n`);

  const topic = '为什么事件驱动能提升 Agent 系统的可观测性';

  // 1. 组装顺序链
  const graph = createPipeline([outliner, writer, editor]);

  // 2. 事件监听（run 与 stream 都会触发；这里用于打印执行进度）
  const t0 = Date.now();
  graph.on('agent_start', (e) => {
    const ev = e as { agentId: string; agentName: string };
    console.log(`  ▶ [${ev.agentId}] ${ev.agentName} 开始执行 (${Date.now() - t0}ms)`);
  });
  graph.on('agent_result', (e) => {
    const ev = e as { agentId: string; result: Result };
    console.log(`  ✔ [${ev.agentId}] 输出: ${preview(ev.result.content, 90)}`);
  });

  // 3. 执行
  console.log(`▶ 输入主题: ${topic}\n`);
  const result = await graph.run(topic);

  // 4. 结果总览
  console.log(`\n▶ 最终输出（最后节点 ${result.lastAgentId}）`);
  console.log(`──────────────────────────────────────────────`);
  console.log(result.content);
  console.log(`──────────────────────────────────────────────`);

  // 5. 每个节点的独立产出（agentResults 是 Map<nodeId, Result>）
  console.log('\n▶ 各节点产出');
  for (const [id, r] of result.agentResults) {
    console.log(`  • ${id}: ${preview(r.content, 60)}`);
  }

  // 6. blackboard 快照：outputMapping 写入的共享数据
  console.log('\n▶ blackboard 共享数据');
  for (const key of ['__original_input__', 'outline', 'draft']) {
    const value = result.context.blackboard.get(key);
    if (value !== undefined) {
      console.log(`  • ${key}: ${preview(String(value), 80)}`);
    }
  }

  console.log(`\n▶ 步数 ${result.stepsCompleted} / 停止原因 ${result.stopReason} / 成功 ${result.success}`);
  console.log(`▶ Token 用量: ${usage(result)}`);
}

main().catch((err) => {
  console.error('运行失败:', err);
  process.exit(1);
});
