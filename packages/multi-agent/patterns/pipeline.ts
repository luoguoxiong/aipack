/**
 * patterns/pipeline.ts - Pipeline 顺序链模式
 *
 * 将多个 Agent 按顺序串联：A → B → C → ...
 * 前一个 Agent 的输出作为后一个 Agent 的输入。
 */

import type { AgentNode, AgentGraph, PipelineOpts } from '../core/types';
import { createAgentGraph } from '../core/graph';

/**
 * 创建 Pipeline 顺序链
 *
 * @param agents - 按顺序排列的 Agent 节点列表
 * @param opts - Pipeline 配置选项
 * @returns AgentGraph 实例
 */
export function createPipeline(
  agents: AgentNode[],
  opts?: PipelineOpts,
): AgentGraph {
  if (agents.length === 0) {
    throw new Error('Pipeline: 至少需要一个 Agent 节点');
  }

  const graph = createAgentGraph();

  // 添加所有节点
  for (const agent of agents) {
    graph.addNode(agent);
  }

  // 设置入口
  graph.setEntry(agents[0].id);

  // 添加顺序边
  for (let i = 0; i < agents.length - 1; i++) {
    const from = agents[i];
    const to = agents[i + 1];

    graph.addEdge({
      from: from.id,
      to: to.id,
      // 边上的转换：将前一个Agent的输出传递给下一个Agent
      transform: opts?.outputTransform
        ? (result, ctx) => opts.outputTransform!(result, ctx)
        : undefined,
    });
  }

  return graph;
}
