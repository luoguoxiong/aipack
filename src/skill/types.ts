import type { ToolResult } from '../tools/types';

// ─── Skill 类型 ───

export type SkillType = 'action' | 'workflow' | 'knowledge' | 'agent';

export interface TriggerDef {
  keywords?: string[];
  file_patterns?: string[];
  priority?: number;           // 优先级（越大越优先），默认 0
}

export interface ContextDef {
  required?: string[];
  optional?: string[];
  exclude?: string[];
  max_tokens?: number;
}

export interface PermissionDef {
  filesystem?: {
    read?: string[];
    write?: string[];
    delete?: boolean;
  };
  network?: boolean | { allowed_domains?: string[]; allowed_methods?: string[] };
  shell?: boolean | { allowed_commands?: string[]; denied_commands?: string[] };
}

export interface RuntimeDef {
  timeout?: number;            // ms
  retry?: number;
  max_output_chars?: number;
}

export interface SkillManifest {
  name: string;
  version: string;
  type: SkillType;
  description: string;
  author?: string;
  trigger?: TriggerDef;
  context?: ContextDef;
  tools?: { allowed?: string[] };
  runtime?: RuntimeDef;
  permission?: PermissionDef;
}

// ─── Skill 定义（加载后的完整结构） ───

export interface SkillDefinition {
  manifest: SkillManifest;
  promptMd: string;            // SKILL.md 原文
  handlerPath?: string;        // handler.ts 路径（可选）
  sourceDir: string;           // 源目录
  registeredAt: number;
}

// ─── 匹配结果 ───

export interface SkillMatch {
  skillName: string;
  confidence: number;          // 0-1
  level: 0 | 1 | 2 | 3;       // 匹配级别
  triggerType: 'explicit' | 'keyword' | 'file' | 'llm';
  priority: number;
}

// ─── 上下文包 ───

export interface SkillContext {
  files: string[];
  memory: string[];
  summary: string;
  tokens: number;
  size: number;
  cost: number;
  truncated: boolean;
}

// ─── 执行结果 ───

export interface SkillResult {
  content: string;
  tokensUsed: number;
  durationMs: number;
  toolsUsed: string[];
  status: 'success' | 'error' | 'timeout';
  error?: string;
}

// ─── 执行追踪 ───

export interface SkillTrace {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  skillName: string;
  version: string;
  startTime: number;
  durationMs: number;
  tokensUsed: number;
  tools: string[];
  status: 'success' | 'error' | 'timeout';
  error?: string;
  metadata: {
    triggerType: string;
    inputSize: number;
    outputSize: number;
    retryCount: number;
  };
}

// ─── Hook ───

export interface SkillHookContext {
  skill: SkillDefinition;
  match?: SkillMatch;
  context?: SkillContext;
  signal?: AbortSignal;
}

export interface SkillHook {
  beforeMatch?(ctx: SkillHookContext): Promise<void | { abort: boolean }>;
  beforeLoad?(ctx: SkillHookContext): Promise<void | { abort: boolean }>;
  beforeContext?(ctx: SkillHookContext): Promise<void | { abort: boolean }>;
  beforeExecute?(ctx: SkillHookContext): Promise<void | { abort: boolean }>;
  afterExecute?(ctx: SkillHookContext & { result: SkillResult }): Promise<void>;
  onError?(ctx: SkillHookContext & { error: Error }): Promise<void>;
  parallel?: boolean;          // 是否可并行执行
}

// ─── 路由结果 ───

export interface RouteResult {
  match: SkillMatch | null;
  matchedSkill: SkillDefinition | null;
}

// ─── 注册表操作结果 ───

export interface RegisterOptions {
  file?: string;
  dir?: string;
  manifest?: SkillManifest;
  promptMd?: string;
  handlerPath?: string;
}

// ─── 导出类型 ───

export type { ToolResult };
