/**
 * ContextResource - 上下文资源
 *
 * 灵感来自 webpack 的 Module。
 * 代表上下文中的单个资源单元（消息、工具调用、工具结果、状态快照等）。
 * 每个 Resource 拥有唯一标识，并可声明对其他 Resource 的依赖。
 *
 * Webpack 映射: Module
 */

// ─── 资源类型 ─────────────────────────────────────────────────────

export type ResourceType =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'system_message'
  | 'state_snapshot'
  | 'compaction_summary'
  | 'custom';

export type ResourceRole = 'user' | 'assistant' | 'toolResult' | 'system' | string;

// ─── 资源接口 ─────────────────────────────────────────────────────

export interface ContextResource {
  /** 唯一标识 */
  readonly id: string;
  /** 资源类型 */
  readonly type: ResourceType;
  /** 消息角色 */
  readonly role: ResourceRole;
  /** 资源内容（消息体或工具数据） */
  readonly content: unknown;
  /** 时间戳 */
  readonly timestamp: number;
  /** 依赖的其他资源 ID（如 tool_result 依赖 tool_call） */
  readonly dependencies: string[];
  /** 资源元数据 */
  readonly meta: Record<string, unknown>;
  /** 是否为关键资源（压缩时不可移除） */
  readonly pinned: boolean;
}

// ─── 资源构建器 ───────────────────────────────────────────────────

export class ContextResourceBuilder {
  private _id: string;
  private _type: ResourceType = 'custom';
  private _role: ResourceRole = 'user';
  private _content: unknown = '';
  private _timestamp: number = Date.now();
  private _dependencies: string[] = [];
  private _meta: Record<string, unknown> = {};
  private _pinned: boolean = false;

  constructor(id?: string) {
    this._id = id || `res_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  id(id: string): this {
    this._id = id;
    return this;
  }

  type(t: ResourceType): this {
    this._type = t;
    return this;
  }

  role(r: ResourceRole): this {
    this._role = r;
    return this;
  }

  content(c: unknown): this {
    this._content = c;
    return this;
  }

  timestamp(ts: number): this {
    this._timestamp = ts;
    return this;
  }

  dependsOn(...ids: string[]): this {
    this._dependencies.push(...ids);
    return this;
  }

  meta(key: string, value: unknown): this {
    this._meta[key] = value;
    return this;
  }

  pinned(p: boolean = true): this {
    this._pinned = p;
    return this;
  }

  build(): ContextResource {
    return {
      id: this._id,
      type: this._type,
      role: this._role,
      content: this._content,
      timestamp: this._timestamp,
      dependencies: this._dependencies,
      meta: this._meta,
      pinned: this._pinned,
    };
  }
}

// ─── 工厂函数 ─────────────────────────────────────────────────────

export function createMessageResource(
  role: ResourceRole,
  content: unknown,
  options?: Partial<ContextResource>,
): ContextResource {
  const type: ResourceType =
    role === 'user' ? 'user_message'
    : role === 'assistant' ? 'assistant_message'
    : role === 'system' ? 'system_message'
    : 'custom';

  return new ContextResourceBuilder()
    .type(type)
    .role(role)
    .content(content)
    .timestamp(options?.timestamp ?? Date.now())
    .build();
}

export function createToolCallResource(
  toolCallId: string,
  toolName: string,
  args: unknown,
  options?: Partial<ContextResource>,
): ContextResource {
  return new ContextResourceBuilder()
    .id(toolCallId)
    .type('tool_call')
    .role('assistant')
    .content({ toolName, args })
    .meta('toolName', toolName)
    .meta('toolCallId', toolCallId)
    .timestamp(options?.timestamp ?? Date.now())
    .build();
}

export function createToolResultResource(
  toolCallId: string,
  toolName: string,
  result: unknown,
  isError: boolean,
  dependsOn: string,
  options?: Partial<ContextResource>,
): ContextResource {
  return new ContextResourceBuilder()
    .id(`${toolCallId}_result`)
    .type('tool_result')
    .role('toolResult')
    .content(result)
    .dependsOn(dependsOn)
    .meta('toolName', toolName)
    .meta('toolCallId', toolCallId)
    .meta('isError', isError)
    .timestamp(options?.timestamp ?? Date.now())
    .build();
}
