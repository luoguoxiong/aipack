/**
 * extensions/debug.ts - 可视化调试扩展
 *
 * 提供：
 * 1. DOT 格式图结构导出（可用 Graphviz 渲染）
 * 2. 执行 Trace 记录（GraphTrace）
 * 3. 执行过程日志
 */

import type {
  AgentGraph,
  AgentNode,
  AgentEdge,
  GraphTrace,
  TraceStep,
  MultiAgentEvent,
  NodeExecutionState,
} from '../core/types';

// ─── GraphDebugger ───────────────────────────────────────────────

/**
 * GraphDebugger：图可视化调试工具
 *
 * 用法：
 * ```typescript
 * const debugger_ = new GraphDebugger(graph);
 *
 * // 导出 DOT 格式
 * const dot = debugger_.toDOT();
 *
 * // 运行并记录 trace
 * const trace = await debugger_.trace('用户输入');
 *
 * // 导出 trace 为 JSON
 * const json = debugger_.traceToJSON(trace);
 * ```
 */
export class GraphDebugger {
  private graph: AgentGraph;
  private nodes: Map<string, AgentNode> = new Map();
  private edges: AgentEdge[] = [];
  private entryId?: string;

  constructor(graph: AgentGraph, nodes?: AgentNode[], edges?: AgentEdge[], entryId?: string) {
    this.graph = graph;
    if (nodes) {
      for (const node of nodes) {
        this.nodes.set(node.id, node);
      }
    }
    if (edges) {
      this.edges = edges;
    }
    this.entryId = entryId;
  }

  /** 设置图元数据（供无法直接访问内部结构的场景使用） */
  setGraphMeta(nodes: AgentNode[], edges: AgentEdge[], entryId?: string): void {
    this.nodes.clear();
    for (const node of nodes) {
      this.nodes.set(node.id, node);
    }
    this.edges = edges;
    this.entryId = entryId;
  }

  /** 导出为 DOT 格式 */
  toDOT(): string {
    const lines: string[] = [];
    lines.push('digraph AgentGraph {');
    lines.push('  rankdir=LR;');
    lines.push('  node [shape=box, style=filled, fillcolor="#e8f4fd", fontname="Arial"];');
    lines.push('  edge [fontname="Arial", fontsize=10];');
    lines.push('');

    // 节点
    for (const [id, node] of this.nodes) {
      const isEntry = id === this.entryId;
      const fillColor = isEntry ? '#4CAF50' : '#e8f4fd';
      const fontColor = isEntry ? 'white' : 'black';
      const label = `${node.name}\\n(${id})`;
      lines.push(`  "${id}" [label="${label}", fillcolor="${fillColor}", fontcolor="${fontColor}"];`);
    }

    lines.push('');

    // 边
    for (const edge of this.edges) {
      const hasCondition = !!edge.condition;
      const style = hasCondition ? 'dashed' : 'solid';
      const label = hasCondition ? '条件' : '';
      lines.push(`  "${edge.from}" -> "${edge.to}" [style=${style}, label="${label}"];`);
    }

    lines.push('}');
    return lines.join('\n');
  }

  /** 执行图并记录 Trace */
  async trace(input: string): Promise<GraphTrace> {
    const traceId = `trace-${Date.now()}`;
    const graphStartTime = Date.now();
    const steps: TraceStep[] = [];
    let stepIndex = 0;

    // 收集事件
    for await (const event of this.graph.stream(input)) {
      if (event.type === 'agent_start') {
        stepIndex++;
        steps.push({
          step: stepIndex,
          agentId: event.agentId,
          agentName: event.agentName,
          startTime: Date.now(),
          duration: 0,
          input: '',
          output: '',
          state: 'running',
        });
      } else if (event.type === 'agent_result') {
        // 找最后一个匹配的 running step（同一 agent 可能执行多次）
        const step = this.findLastRunning(steps, event.agentId);
        if (step) {
          step.duration = Date.now() - step.startTime;
          step.output = this.truncate(event.result.content, 200);
          step.state = 'completed';
        } else {
          // 如果找不到 running step，回退到找最后一个同 agentId 的 step
          const fallback = this.findLastById(steps, event.agentId);
          if (fallback) {
            fallback.duration = Date.now() - fallback.startTime;
            fallback.output = this.truncate(event.result.content, 200);
            fallback.state = 'completed';
          }
        }
      } else if (event.type === 'agent_error') {
        const step = this.findLastRunning(steps, event.agentId);
        if (step) {
          step.duration = Date.now() - step.startTime;
          step.error = event.error;
          step.state = 'failed';
        }
      }
    }

    // 获取最终结果
    const state = this.graph.getState();
    const graphDuration = Date.now() - graphStartTime;

    return {
      traceId,
      startTime: graphStartTime,
      duration: graphDuration,
      steps,
      result: {
        success: !state.error,
        content: state.error ?? '',
        stopReason: state.error ? 'error' : 'completed',
        stepsCompleted: state.stepsCompleted,
      },
    };
  }

  /** 将 Trace 转为 JSON 字符串 */
  traceToJSON(trace: GraphTrace): string {
    return JSON.stringify(trace, null, 2);
  }

  /** 将 Trace 转为可读的执行日志 */
  traceToLog(trace: GraphTrace): string {
    const lines: string[] = [];
    lines.push(`=== Graph Trace: ${trace.traceId} ===`);
    lines.push(`Duration: ${trace.duration}ms`);
    lines.push('');

    for (const step of trace.steps) {
      const status = step.state === 'completed' ? 'OK' : step.state === 'failed' ? 'FAIL' : step.state;
      lines.push(`[${step.step}] ${step.agentName} (${step.agentId}) - ${status} (${step.duration}ms)`);
      if (step.input) lines.push(`  Input:  ${this.truncate(step.input, 100)}`);
      if (step.output) lines.push(`  Output: ${this.truncate(step.output, 100)}`);
      if (step.error) lines.push(`  Error:  ${step.error}`);
      lines.push('');
    }

    lines.push(`Result: ${trace.result.success ? 'SUCCESS' : 'FAILED'} (${trace.result.stopReason})`);
    return lines.join('\n');
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '...';
  }

  /** 找最后一个匹配 agentId 且状态为 running 的 step */
  private findLastRunning(steps: TraceStep[], agentId: string): TraceStep | undefined {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].agentId === agentId && steps[i].state === 'running') {
        return steps[i];
      }
    }
    return undefined;
  }

  /** 找最后一个匹配 agentId 的 step（不管状态） */
  private findLastById(steps: TraceStep[], agentId: string): TraceStep | undefined {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].agentId === agentId) {
        return steps[i];
      }
    }
    return undefined;
  }
}

// ─── createDebugger 工厂函数 ─────────────────────────────────────

/** 创建 GraphDebugger */
export function createDebugger(graph: AgentGraph): GraphDebugger {
  return new GraphDebugger(graph);
}
