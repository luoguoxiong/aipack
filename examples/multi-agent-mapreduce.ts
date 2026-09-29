/**
 * 多Agent示例：MapReduce 并行聚合
 *
 * 演示 createMapReduce：把长输入拆成多个子任务 → mapper 并行处理 → reducer 汇总。
 *   章节摘要 renewal-mapper（N 份并发） → 全局汇总 reducer
 *
 * 本例用到的能力：
 *   1. MapReduceOpts.split：自定义拆分策略（这里按一级标题 # 切章）
 *   2. MapReduceOpts.reduceInputFormat：自定义传给 reducer 的输入格式
 *   3. concurrency 限流 + onMapperError:'skip' 容错
 *   4. 虚拟节点 ID：每个子任务的结果以 `${mapperId}_${index}` 记录在 agentResults
 *
 * 模型配置统一来自 examples/model.config.ts（本地私有，不提交）：
 *   cp examples/model.config.example.ts examples/model.config.ts
 *
 * 运行：
 *   npx tsx examples/multi-agent-mapreduce.ts
 */
import type { Result, RuntimeOptions } from '@aipack-ai/agent';
import { createMapReduce } from '@aipack-ai/multi-agent';
import type { AgentNode, MultiAgentResult } from '@aipack-ai/multi-agent';
import { createLlm, formatModelConfig } from './model.config';

const { model, streamFn } = createLlm();

/** mapper 并发上限（子任务总数由 split 决定，这里限制同时在飞的请求数） */
const CONCURRENCY = 2;

// ─── 辅助函数 ────────────────────────────────────────────────────

function agentRuntime(systemPrompt: string): RuntimeOptions {
  return { model, streamFn, systemPrompt };
}

function preview(text: string, n = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

// ─── 待处理长文（真实场景可换成文件或网页正文） ──────────────────

const longDoc = `# 指标：系统是否健康
指标是时间序列的数值信号，回答「坏了吗、多严重」。Agent 系统常用：请求延迟 P95、工具调用失败率、单会话步数、Token 成本。指标便宜、可聚合，适合做告警阈值。

# 日志：到底发生了什么
日志记录离散事件，回答「哪一步出错了」。关键是把同一次执行用 traceId 串起来，并记录输入摘要、工具名、耗时。日志贵在可检索，建议结构化而非自由文本。

# 链路追踪：瓶颈在哪一段
链路追踪把一次请求拆成 span 树，回答「时间花在哪」。多 Agent 场景下 span 的父子关系天然对应「图→节点→工具调用」，可以直观看到是哪一层拖慢整体。

# 三者的协作方式
指标发现异常，追踪定位到具体节点，日志给出该节点的原始输入与报错栈。三者用同一个 traceId 关联，才能在出问题时分钟级定位。`;

// ─── Mapper / Reducer ────────────────────────────────────────────

const mapper: AgentNode = {
  id: 'section-summarizer',
  name: '章节摘要员',
  description: '为单个章节生成要点摘要',
  runtime: agentRuntime('你是技术文档编辑。把给定章节压缩成 2 条要点，每条不超过 25 字，输出为「- 」开头的列表。'),
};

const reducer: AgentNode = {
  id: 'report-writer',
  name: '汇总撰稿',
  description: '把各章节摘要汇总为统一报告',
  runtime: agentRuntime(
    [
      '你是技术文档主编。把各章节摘要汇总成一份读书笔记：',
      '先写一句全文主旨，再输出 3-4 条要点，最后给一句适用场景建议。输出 Markdown。',
    ].join('\n'),
  ),
};

// ─── 主流程 ──────────────────────────────────────────────────────

async function main() {
  console.log('╔═════════════════════════════════════════════╗');
  console.log('║   MapReduce：章节并行摘要 → 汇总              ║');
  console.log('╚═════════════════════════════════════════════╝');
  console.log(`✅ 模型: ${formatModelConfig()}\n`);

  const graph = createMapReduce(mapper, reducer, {
    // 1) 拆分：按一级标题切分为独立章节
    split: (input: string) => input.split(/\n(?=# )/).map((s) => s.trim()).filter(Boolean),
    // 2) 限流：避免一次性打满供应商并发（子任务 4 个，但同时最多跑 CONCURRENCY 个）
    concurrency: CONCURRENCY,
    // 3) 容错：个别章节失败不中断整体，失败 ID 会进入 result.failedAgents
    onMapperError: 'skip',
    // 4) 自定义 reducer 输入格式：带上章节标题
    reduceInputFormat: (results: Map<number, Result>) =>
      [...results.entries()]
        .map(([idx, r]) => `【第 ${idx + 1} 章】\n${r.content}`)
        .join('\n\n'),
  });

  console.log('▶ Map 阶段：并行摘要各章节');
  const t0 = Date.now();
  // 统计在飞子任务数，用来验证 concurrency 限流确实生效
  let inflight = 0;
  let peak = 0;
  const isMapper = (agentId: string) => agentId.startsWith('section-summarizer');

  graph.on('parallel_start', (e) => {
    const ev = e as { agentIds: string[] };
    // 注意：这里报告的是 split 出来的子任务总数，不等于同时发起的请求数
    console.log(`  ⇉ 本批子任务 ${ev.agentIds.length} 个（并发上限 ${CONCURRENCY}）: ${ev.agentIds.join(', ')}`);
  });
  graph.on('agent_start', (e) => {
    const ev = e as { agentId: string };
    if (!isMapper(ev.agentId)) return;
    inflight++;
    peak = Math.max(peak, inflight);
    console.log(`  ▶ ${ev.agentId} 开始（在飞 ${inflight}/${CONCURRENCY}）`);
  });
  graph.on('agent_result', (e) => {
    const ev = e as { agentId: string; result: Result };
    if (!isMapper(ev.agentId)) return;
    inflight--;
    console.log(`  ✔ ${ev.agentId} 完成 (${Date.now() - t0}ms): ${preview(ev.result.content, 90)}`);
  });

  const result: MultiAgentResult = await graph.run(longDoc);

  console.log('\n▶ 各子任务产出（虚拟节点 `${mapperId}_${index}`）');
  for (const [id, r] of result.agentResults) {
    console.log(`  • ${id}: ${preview(r.content, 70)}`);
  }

  console.log(`\n▶ Reduce 阶段输出（${result.lastAgentId}）`);
  console.log('──────────────────────────────────────────────');
  console.log(result.content);
  console.log('──────────────────────────────────────────────');

  console.log(`\n▶ 步数 ${result.stepsCompleted} / 停止原因 ${result.stopReason}`);
  console.log(`▶ 失败子任务: ${result.failedAgents?.length ? result.failedAgents.join(', ') : '无'}`);
  console.log(`▶ mapper 峰值并发 ${peak}（上限 ${CONCURRENCY}）/ 总耗时约 ${Date.now() - t0}ms`);
  console.log('  说明：parallel_start 报的是 split 出的子任务总数，真正同时在飞的请求数由 concurrency 控制');
}

main().catch((err) => {
  console.error('运行失败:', err);
  process.exit(1);
});
