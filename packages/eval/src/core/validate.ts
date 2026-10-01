/**
 * packages/eval/src/core/validate.ts - 用例静态校验
 *
 * loader 加载 JSON 后立即校验，坏用例在运行前暴露（fail fast）。
 */

import type { CaseOrigin, EvalCase, ScorerType } from './types';
import { RULE_SCORER_TYPES } from './scorer/rule';
import { ALL_SCORER_TYPES } from './scorer';

const ORIGINS: CaseOrigin[] = [
  'handwritten',
  'trace',
  'synthetic',
  'dataset',
  'bugfix',
];

const EXPECTED_TYPES = [
  'exact',
  'contains',
  'regex',
  'tool-call',
  'tools-used',
  'json-field',
  'success',
  'stop-reason',
];

export function validateEvalCase(c: EvalCase): string[] {
  const errors: string[] = [];
  const at = (msg: string) => `[${c.id ?? '<missing id>'}] ${msg}`;

  if (!c.id || typeof c.id !== 'string') errors.push('缺少 id');
  else if (!/^[a-z0-9][a-z0-9/_-]*$/i.test(c.id)) errors.push(at('id 含非法字符'));
  if (!c.suite || typeof c.suite !== 'string') errors.push(at('缺少 suite'));
  if (!c.input || typeof c.input !== 'object') {
    errors.push(at('缺少 input'));
    return errors;
  }
  if (!c.input.message || typeof c.input.message !== 'string') {
    errors.push(at('input.message 必须为非空字符串'));
  }
  if (c.input.mock) {
    if (!Array.isArray(c.input.mock.turns) || c.input.mock.turns.length === 0) {
      errors.push(at('input.mock.turns 必须为非空数组'));
    } else {
      c.input.mock.turns.forEach((t, i) => {
        if (!t.toolCalls && t.text === undefined) {
          errors.push(at(`mock.turns[${i}] 既无 toolCalls 也无 text`));
        }
      });
    }
  }
  if (c.mode !== undefined && c.mode !== 'mock' && c.mode !== 'live') {
    errors.push(at("mode 只能为 'mock' 或 'live'"));
  }
  if (c.mode === 'live' && c.input?.mock) {
    errors.push(at("mode='live' 的用例走真实 LLM，不应带 input.mock"));
  }
  if (!c.origin || !ORIGINS.includes(c.origin)) {
    errors.push(at(`origin 必须为: ${ORIGINS.join(' | ')}`));
  }

  if (c.expected) {
    const type = (c.expected as { type?: string }).type;
    if (!type || !EXPECTED_TYPES.includes(type)) {
      errors.push(at(`expected.type 必须为: ${EXPECTED_TYPES.join(' | ')}`));
    }
  }

  for (const s of c.scorers ?? []) {
    if (!ALL_SCORER_TYPES.includes(s.type as ScorerType)) {
      errors.push(at(`scorers 含未知类型 '${s.type}'（支持: ${ALL_SCORER_TYPES.join(', ')}）`));
    }
  }

  const hasScorers = Boolean(c.expected) || (c.scorers?.length ?? 0) > 0;
  if (!hasScorers) errors.push(at('expected 与 scorers 至少提供一项'));

  return errors;
}
