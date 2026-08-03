/**
 * TaskGraph - 任务依赖图
 *
 * 管理所有 ContextResource 之间的依赖关系，支持拓扑排序与可达性分析。
 * Runtime 在每次编译时会构建 TaskGraph，Pipeline 与 Transformer 基于图结构操作资源。
 */

import type { ContextResource, ResourceType } from './context-resource';

// ─── 图节点 ───────────────────────────────────────────────────────

export interface GraphNode {
  resource: ContextResource;
  dependents: Set<string>;  // 依赖此节点的节点
  dependencies: Set<string>; // 此节点依赖的节点
}

// ─── TaskGraph 接口 ───────────────────────────────────────────────

export interface TaskGraph {
  /** 添加资源到图中 */
  add(resource: ContextResource): void;
  /** 批量添加资源 */
  addAll(resources: ContextResource[]): void;
  /** 获取指定 ID 的资源 */
  resolve(id: string): ContextResource | undefined;
  /** 获取指定 ID 的节点 */
  getNode(id: string): GraphNode | undefined;
  /** 移除资源（同时清理依赖关系） */
  remove(id: string): boolean;
  /** 获取所有资源 */
  getAll(): ContextResource[];
  /** 按类型过滤资源 */
  getByType(type: ResourceType): ContextResource[];
  /** 拓扑排序 */
  topologicalSort(): ContextResource[];
  /** 检查从 from 到 to 是否可达 */
  isReachable(from: string, to: string): boolean;
  /** 获取所有叶子节点（无依赖的节点） */
  getLeaves(): ContextResource[];
  /** 获取根节点（无被依赖的节点） */
  getRoots(): ContextResource[];
  /** 获取图的大小 */
  readonly size: number;
  /** 清空图 */
  clear(): void;
}

// ─── TaskGraph 实现 ───────────────────────────────────────────────

export class TaskGraphImpl implements TaskGraph {
  private nodes = new Map<string, GraphNode>();
  private _size = 0;

  get size(): number {
    return this._size;
  }

  add(resource: ContextResource): void {
    // 如果已存在，先移除旧节点
    if (this.nodes.has(resource.id)) {
      this.remove(resource.id);
    }

    const node: GraphNode = {
      resource,
      dependents: new Set(),
      dependencies: new Set(),
    };

    // 建立依赖关系
    for (const depId of resource.dependencies) {
      node.dependencies.add(depId);
      const depNode = this.nodes.get(depId);
      if (depNode) {
        depNode.dependents.add(resource.id);
      }
    }

    this.nodes.set(resource.id, node);
    this._size++;
  }

  addAll(resources: ContextResource[]): void {
    // 先添加所有节点（不带依赖），再补充依赖关系
    for (const res of resources) {
      if (!this.nodes.has(res.id)) {
        this.nodes.set(res.id, {
          resource: res,
          dependents: new Set(),
          dependencies: new Set(),
        });
        this._size++;
      }
    }
    // 补充依赖关系
    for (const res of resources) {
      const node = this.nodes.get(res.id)!;
      for (const depId of res.dependencies) {
        node.dependencies.add(depId);
        const depNode = this.nodes.get(depId);
        if (depNode) {
          depNode.dependents.add(res.id);
        }
      }
    }
  }

  resolve(id: string): ContextResource | undefined {
    return this.nodes.get(id)?.resource;
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  remove(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;

    // 清理依赖关系
    for (const depId of node.dependencies) {
      const depNode = this.nodes.get(depId);
      depNode?.dependents.delete(id);
    }
    for (const dependentId of node.dependents) {
      const dependentNode = this.nodes.get(dependentId);
      dependentNode?.dependencies.delete(id);
    }

    this.nodes.delete(id);
    this._size--;
    return true;
  }

  getAll(): ContextResource[] {
    return Array.from(this.nodes.values()).map(n => n.resource);
  }

  getByType(type: ResourceType): ContextResource[] {
    return this.getAll().filter(r => r.type === type);
  }

  topologicalSort(): ContextResource[] {
    const result: ContextResource[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) return; // 环检测：跳过

      visiting.add(id);
      const node = this.nodes.get(id);
      if (node) {
        for (const depId of node.dependencies) {
          visit(depId);
        }
        result.push(node.resource);
      }
      visiting.delete(id);
      visited.add(id);
    };

    for (const id of this.nodes.keys()) {
      visit(id);
    }

    return result;
  }

  isReachable(from: string, to: string): boolean {
    if (from === to) return true;
    const visited = new Set<string>();
    const queue = [from];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      const node = this.nodes.get(current);
      if (!node) continue;

      for (const depId of node.dependencies) {
        if (depId === to) return true;
        if (!visited.has(depId)) {
          queue.push(depId);
        }
      }
    }

    return false;
  }

  getLeaves(): ContextResource[] {
    return Array.from(this.nodes.values())
      .filter(n => n.dependencies.size === 0)
      .map(n => n.resource);
  }

  getRoots(): ContextResource[] {
    return Array.from(this.nodes.values())
      .filter(n => n.dependents.size === 0)
      .map(n => n.resource);
  }

  clear(): void {
    this.nodes.clear();
    this._size = 0;
  }
}

// ─── 图构建器 ─────────────────────────────────────────────────────

export class TaskGraphBuilder {
  private resources: ContextResource[] = [];

  add(resource: ContextResource): this {
    this.resources.push(resource);
    return this;
  }

  addAll(resources: ContextResource[]): this {
    this.resources.push(...resources);
    return this;
  }

  build(): TaskGraph {
    const graph = new TaskGraphImpl();
    graph.addAll(this.resources);
    return graph;
  }
}

export function createTaskGraph(): TaskGraph {
  return new TaskGraphImpl();
}
