/**
 * Phase 5：Agent spec schema 校验（零依赖手写校验，不引 zod）。
 *
 * 校验 AgentSpec 形状：
 *   systemPrompt: string（必填，非空）
 *   model: { provider: string, id: string, temperature?: number, maxTokens?: number }
 *   tools: string[]
 *   params?: { maxTurns?: number, approvalMode?: 'auto'|'always'|'never', ... }
 *
 * 校验失败返回结构化错误；成功返回原 spec（已规范化）。
 */
import type { AgentSpec } from '../stores/agent-definition-store';

export interface ValidateSpecResult {
  ok: boolean;
  spec?: AgentSpec;
  error?: string;
  /** 字段级错误路径（如 model.provider） */
  path?: string;
}

export function validateAgentSpec(input: unknown): ValidateSpecResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'spec 必须为对象' };
  }
  const spec = input as Record<string, unknown>;

  // systemPrompt
  if (typeof spec.systemPrompt !== 'string' || spec.systemPrompt.length === 0) {
    return { ok: false, error: 'systemPrompt 为必填且为非空字符串', path: 'systemPrompt' };
  }
  if (spec.systemPrompt.length > 100_000) {
    return { ok: false, error: 'systemPrompt 长度不能超过 100000 字符', path: 'systemPrompt' };
  }

  // model
  if (typeof spec.model !== 'object' || spec.model === null || Array.isArray(spec.model)) {
    return { ok: false, error: 'model 为必填且为对象', path: 'model' };
  }
  const model = spec.model as Record<string, unknown>;
  if (typeof model.provider !== 'string' || !model.provider) {
    return { ok: false, error: 'model.provider 为必填非空字符串', path: 'model.provider' };
  }
  if (typeof model.id !== 'string' || !model.id) {
    return { ok: false, error: 'model.id 为必填非空字符串', path: 'model.id' };
  }
  if (model.temperature !== undefined) {
    const t = Number(model.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) {
      return { ok: false, error: 'model.temperature 须为 0-2 之间的数字', path: 'model.temperature' };
    }
    model.temperature = t;
  }
  if (model.maxTokens !== undefined) {
    const mt = Number(model.maxTokens);
    if (!Number.isFinite(mt) || mt <= 0 || mt > 2_000_000) {
      return { ok: false, error: 'model.maxTokens 须为正整数（≤2000000）', path: 'model.maxTokens' };
    }
    model.maxTokens = Math.floor(mt);
  }

  // tools
  if (!Array.isArray(spec.tools)) {
    return { ok: false, error: 'tools 为必填且为字符串数组', path: 'tools' };
  }
  for (let i = 0; i < spec.tools.length; i++) {
    if (typeof spec.tools[i] !== 'string' || (spec.tools[i] as string).length === 0) {
      return { ok: false, error: `tools[${i}] 必须为非空字符串`, path: `tools[${i}]` };
    }
  }

  // params（可选）
  if (spec.params !== undefined) {
    if (typeof spec.params !== 'object' || spec.params === null || Array.isArray(spec.params)) {
      return { ok: false, error: 'params 须为对象', path: 'params' };
    }
    const params = spec.params as Record<string, unknown>;
    if (params.maxTurns !== undefined) {
      const mt = Number(params.maxTurns);
      if (!Number.isFinite(mt) || mt <= 0 || mt > 1000) {
        return { ok: false, error: 'params.maxTurns 须为正整数（≤1000）', path: 'params.maxTurns' };
      }
      params.maxTurns = Math.floor(mt);
    }
    if (params.approvalMode !== undefined) {
      if (params.approvalMode !== 'auto' && params.approvalMode !== 'always' && params.approvalMode !== 'never') {
        return { ok: false, error: "params.approvalMode 仅支持 'auto' / 'always' / 'never'", path: 'params.approvalMode' };
      }
    }
  }

  return { ok: true, spec: spec as unknown as AgentSpec };
}

/** 校验 name 字段（1-100 字符） */
export function validateAgentName(name: unknown): { ok: boolean; name?: string; error?: string } {
  if (typeof name !== 'string') return { ok: false, error: 'name 必须为字符串' };
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100) return { ok: false, error: 'name 长度须在 1-100 字符' };
  // 简单字符白名单：字母数字 _ - . /（避免 SQL 注入风险，DB 层已参数化，此处仅前端友好）
  if (!/^[A-Za-z0-9_\-./]+$/.test(trimmed)) {
    return { ok: false, error: 'name 仅支持字母数字与 _ - . /' };
  }
  return { ok: true, name: trimmed };
}
