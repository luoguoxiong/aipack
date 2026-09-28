/**
 * packages/eval/src/core/scorer/rule.ts - 规则评分器
 *
 * M1 范围：8 个确定性评分器（零 LLM 成本）：
 *   exact / contains / regex   —— 最终文本断言
 *   json-field                 —— 结构化输出断言（dot 路径取值）
 *   tool-call                  —— 工具调用轨迹断言（顺序 + 参数部分匹配）
 *   tools-used                 —— 去重工具集合断言（对齐 Result.toolsUsed）
 *   success / stop-reason      —— 运行状态断言
 */

import type { RunTrace, ScoreResult, ToolCallRecord } from '../types';

// ─── 参数部分匹配（深比较，expected 未列字段忽略）─────────────────

export function partialMatch(expected: unknown, actual: unknown): boolean {
  if (expected === undefined) return true;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((e, i) => partialMatch(e, actual[i]))
    );
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      return false;
    }
    return Object.entries(expected).every(([k, v]) =>
      partialMatch(v, (actual as Record<string, unknown>)[k]),
    );
  }
  return expected === actual;
}

// ─── dot 路径取值 ─────────────────────────────────────────────────

function getByPath(obj: unknown, path: string): { found: boolean; value: unknown } {
  let cur: unknown = obj;
  for (const key of path.split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') return { found: false, value: undefined };
    cur = (cur as Record<string, unknown>)[key];
  }
  return { found: true, value: cur };
}

// ─── 轨迹匹配 ─────────────────────────────────────────────────────

interface ExpectedCall {
  tool: string;
  args?: Record<string, unknown>;
  isError?: boolean;
}

function matchCall(expected: ExpectedCall, actual: ToolCallRecord): boolean {
  if (expected.tool !== actual.name) return false;
  if (expected.isError !== undefined && expected.isError !== actual.isError) {
    return false;
  }
  if (expected.args === undefined) return true;
  return partialMatch(expected.args, actual.args);
}

/**
 * 有序子序列匹配：expected 序列按顺序出现在 actual 中（允许间隔）。
 */
function matchSubsequence(expected: ExpectedCall[], actual: ToolCallRecord[]): boolean {
  let i = 0;
  for (const a of actual) {
    if (i < expected.length && matchCall(expected[i], a)) i += 1;
  }
  return i === expected.length;
}

// ─── 各评分器实现 ─────────────────────────────────────────────────

type RuleParams = Record<string, unknown>;

function str(p: RuleParams, key: string, required = true): string | undefined {
  const v = p[key];
  if (typeof v === 'string') return v;
  if (required) throw new Error(`评分器参数缺少字符串字段 '${key}'`);
  return undefined;
}

const scorers: Record<string, (trace: RunTrace, params: RuleParams) => ScoreResult> = {
  exact: (trace, p) => {
    const value = str(p, 'value')!;
    const passed = trace.result.content === value;
    return {
      scorer: 'exact',
      score: passed ? 1 : 0,
      passed,
      reason: passed ? '最终文本完全相等' : `期望 ${JSON.stringify(value)}，实际 ${JSON.stringify(trace.result.content)}`,
    };
  },

  contains: (trace, p) => {
    const value = str(p, 'value')!;
    const passed = trace.result.content.includes(value);
    return {
      scorer: 'contains',
      score: passed ? 1 : 0,
      passed,
      reason: passed ? `包含 ${JSON.stringify(value)}` : `未包含 ${JSON.stringify(value)}`,
      evidence: passed ? value : undefined,
    };
  },

  regex: (trace, p) => {
    const value = str(p, 'value')!;
    const flags = str(p, 'flags', false) ?? '';
    const re = new RegExp(value, flags);
    const passed = re.test(trace.result.content);
    return {
      scorer: 'regex',
      score: passed ? 1 : 0,
      passed,
      reason: passed ? `匹配 /${value}/${flags}` : `不匹配 /${value}/${flags}（实际 ${JSON.stringify(trace.result.content.slice(0, 80))}）`,
    };
  },

  'json-field': (trace, p) => {
    const path = str(p, 'path')!;
    const expectedValue = 'value' in p ? p.value : undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trace.result.content);
    } catch (e) {
      return {
        scorer: 'json-field',
        score: 0,
        passed: false,
        reason: `最终文本不是合法 JSON: ${(e as Error).message}`,
      };
    }
    const { found, value } = getByPath(parsed, path);
    if (!found) {
      return {
        scorer: 'json-field',
        score: 0,
        passed: false,
        reason: `路径 '${path}' 不存在`,
      };
    }
    const hasExpected = 'value' in p;
    const passed = hasExpected ? partialMatch(expectedValue, value) : true;
    return {
      scorer: 'json-field',
      score: passed ? 1 : 0,
      passed,
      reason: passed
        ? `路径 '${path}' 命中${hasExpected ? '且值匹配' : ''}`
        : `路径 '${path}' 期望 ${JSON.stringify(expectedValue)}，实际 ${JSON.stringify(value)}`,
    };
  },

  'tool-call': (trace, p) => {
    const calls = p.calls as ExpectedCall[] | undefined;
    if (!Array.isArray(calls)) throw new Error("评分器参数缺少数组字段 'calls'");
    const order = p.order === 'exact' ? 'exact' : 'subset';
    const actual = trace.trajectory;

    let passed: boolean;
    if (order === 'exact') {
      passed =
        actual.length === calls.length &&
        calls.every((c, i) => matchCall(c, actual[i]));
    } else {
      passed = matchSubsequence(calls, actual);
    }

    const actualDesc = actual
      .map((a, i) => `${i + 1}. ${a.name}(${JSON.stringify(a.args ?? {})})`)
      .join(' → ') || '(无工具调用)';
    const expectedDesc = calls.map((c) => c.tool).join(' → ') || '(无)';

    return {
      scorer: 'tool-call',
      score: passed ? 1 : 0,
      passed,
      reason: passed
        ? `轨迹匹配（${order}）：${expectedDesc}`
        : `轨迹不匹配（${order}）：期望 ${expectedDesc}，实际 ${actualDesc}`,
      evidence: actualDesc,
    };
  },

  'tools-used': (trace, p) => {
    const tools = p.tools as string[] | undefined;
    if (!Array.isArray(tools)) throw new Error("评分器参数缺少数组字段 'tools'");
    const expectedSet = new Set(tools);
    const actualSet = new Set(trace.result.toolsUsed);
    const passed =
      expectedSet.size === actualSet.size &&
      [...expectedSet].every((t) => actualSet.has(t));
    return {
      scorer: 'tools-used',
      score: passed ? 1 : 0,
      passed,
      reason: passed
        ? `工具集合匹配: ${[...expectedSet].join(', ')}`
        : `期望 {${[...expectedSet].join(', ')}}，实际 {${[...actualSet].join(', ')}}`,
    };
  },

  success: (trace, p) => {
    const expected = typeof p.value === 'boolean' ? p.value : true;
    const passed = trace.result.success === expected;
    return {
      scorer: 'success',
      score: passed ? 1 : 0,
      passed,
      reason: passed
        ? `运行成功标志 = ${expected}`
        : `期望 success=${expected}，实际 ${trace.result.success}${trace.result.error ? `（${trace.result.error}）` : ''}`,
    };
  },

  'stop-reason': (trace, p) => {
    const value = str(p, 'value')!;
    const passed = trace.result.stopReason === value;
    return {
      scorer: 'stop-reason',
      score: passed ? 1 : 0,
      passed,
      reason: passed
        ? `stopReason = ${value}`
        : `期望 stopReason=${value}，实际 ${trace.result.stopReason}`,
    };
  },
};

export const RULE_SCORER_TYPES = Object.keys(scorers);

/** 执行单个规则评分器；未知类型 / 参数错误返回 scorer 自身失败而非抛出 */
export function runRuleScorer(
  trace: RunTrace,
  type: string,
  params: RuleParams,
): ScoreResult {
  const fn = scorers[type];
  if (!fn) {
    return {
      scorer: type as ScoreResult['scorer'],
      score: 0,
      passed: false,
      reason: `未知评分器类型 '${type}'（M1 仅支持: ${RULE_SCORER_TYPES.join(', ')}）`,
    };
  }
  try {
    return fn(trace, params);
  } catch (e) {
    return {
      scorer: type as ScoreResult['scorer'],
      score: 0,
      passed: false,
      reason: `评分器执行错误: ${(e as Error).message}`,
    };
  }
}
