/**
 * core/context.ts - SharedContext 实现
 *
 * 提供 EventBus、ToolRegistry 和 SharedContext 的默认实现。
 */

import type { Tool } from '@aipack-ai/agent';
import type { EventBus, ToolRegistry, SharedContext, EventListener } from './types';

// ─── SimpleEventBus ──────────────────────────────────────────────

/** 简单同步事件总线实现 */
export class SimpleEventBus implements EventBus {
  private listeners = new Map<string, Set<EventListener>>();

  on(event: string, listener: EventListener): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  off(event: string, listener: EventListener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, data?: unknown): this {
    const set = this.listeners.get(event);
    if (set) {
      for (const listener of set) {
        try {
          listener(data);
        } catch {
          // 防止监听器异常中断事件传播
        }
      }
    }
    return this;
  }
}

// ─── SimpleToolRegistry ─────────────────────────────────────────

/** 简单工具注册表实现 */
export class SimpleToolRegistry implements ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: Tool[]): this {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}

// ─── createSharedContext ────────────────────────────────────────

/** 创建默认 SharedContext */
export function createSharedContext(init?: Partial<SharedContext>): SharedContext {
  return {
    blackboard: init?.blackboard ?? new Map(),
    bus: init?.bus ?? new SimpleEventBus(),
    toolRegistry: init?.toolRegistry ?? new SimpleToolRegistry(),
    meta: init?.meta ?? {},
  };
}
