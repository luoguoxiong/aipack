/**
 * patterns/router.ts - Router 条件路由模式
 *
 * 路由器 Agent 根据输入选择目标 Agent 执行。
 * 结构：Router → (条件匹配) → Target Agent
 */

import type { AgentNode, AgentGraph, RouterOpts } from '../core/types';
import { createAgentGraph } from '../core/graph';

/**
 * 创建 Router 条件路由
 *
 * @param router - 路由器 Agent（负责意图识别）
 * @param targets - 目标 Agent 列表
 * @param opts - Router 配置选项（必须提供 resolve 函数）
 * @returns AgentGraph 实例
 */
export function createRouter(
  router: AgentNode,
  targets: AgentNode[],
  opts: RouterOpts,
): AgentGraph {
  if (targets.length === 0) {
    throw new Error('Router: 至少需要一个目标 Agent');
  }

  const graph = createAgentGraph();

  // 添加路由器节点
  graph.addNode(router);

  // 添加目标节点
  for (const target of targets) {
    graph.addNode(target);
  }

  // 设置入口为路由器
  graph.setEntry(router.id);

  // 构建目标 ID 集合，用于校验
  const targetIds = new Set(targets.map(t => t.id));

  // 路由器到每个目标的条件边
  for (const target of targets) {
    graph.addEdge({
      from: router.id,
      to: target.id,
      // 条件：从路由器结果中解析目标ID，匹配当前目标
      condition: (routerResult, _ctx) => {
        const resolvedId = opts.resolve(routerResult);
        return resolvedId === target.id;
      },
      // 转换：决定传给目标Agent的输入
      transform: (_routerResult, _ctx) => {
        // 默认传递原始输入（passOriginalInput=true）
        // 原始输入在 graph run 时传入，这里通过 blackboard 获取
        const originalInput = _ctx.blackboard.get('__original_input__');
        if (opts.passOriginalInput === false) {
          // 传递路由器的输出
          return _routerResult.content;
        }
        return (originalInput as string) ?? _routerResult.content;
      },
    });
  }

  // 默认路由边（如果指定了 defaultTarget）
  if (opts.defaultTarget && targetIds.has(opts.defaultTarget)) {
    // 默认边已在上面添加，这里无需额外处理
    // resolve 函数应返回 defaultTarget 作为兜底
  }

  return graph;
}
