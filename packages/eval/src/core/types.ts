/**
 * packages/eval/src/core/types.ts - Eval 体系类型定义
 *
 * 四个核心概念：
 *   EvalCase   —— 一条评测用例（输入 + 期望 + 评分器配置）
 *   RunConfig  —— 一次评测运行的执行配置
 *   RunTrace   —— 单个用例运行后的完整轨迹（供评分器消费）
 *   EvalReport —— 一次运行的汇总报告
 *
 * 设计原则（对齐 EVAL_PLAN.md）：
 *   - 轨迹优先：工具调用轨迹是 agent 框架最值得断言的信号
 *   - 规则评分覆盖 70%：M1 只实现规则评分器，semantic / llm-judge 留到 M5
 *   - origin 标识：报告按数据来源分组，诊断 eval 集与真实分布的漂移
 */

import type { Message, Result } from '@aipack-ai/agent';

// ─── 用例来源 ─────────────────────────────────────────────────────

/** 用例数据来源（报告按 origin 分组诊断分布漂移） */
export type CaseOrigin =
  | 'handwritten' // 手工 golden（README / examples 场景）
  | 'trace' // 线上 trace 回流
  | 'synthetic' // 工具 schema / SKILL.md 合成
  | 'dataset' // 开源数据集适配
  | 'bugfix'; // bug 修复回归

// ─── Mock 脚本（fixture replay）───────────────────────────────────

/** 脚本化的一次工具调用 */
export interface MockToolCall {
  /** 缺省自动生成（mock_tc_<n>） */
  id?: string;
  /** 被调用的 mock 工具名 */
  name: string;
  args?: Record<string, unknown>;
}

/** 脚本化的一轮 assistant 响应 */
export interface MockAssistantTurn {
  /** 本轮要发起的工具调用（可多个 = 并行调用） */
  toolCalls?: MockToolCall[];
  /** 本轮 assistant 文本（可与 toolCalls 并存，文本在前） */
  text?: string;
  /** 缺省：有 toolCalls 时 'toolUse'，否则 'stop' */
  stopReason?: string;
  /** 本轮 usage（缺省 {input:10, output:5, total:15}） */
  usage?: { input?: number; output?: number; total?: number };
}

export interface MockScript {
  /** 依次消费的 assistant 轮次；每次 streamFn 调用取下一条 */
  turns: MockAssistantTurn[];
  /** 轮次耗尽后的兜底文本轮（缺省 'done'） */
  fallbackText?: string;
  /**
   * 轮次耗尽后是否持续发起该工具的调用（模拟死循环，
   * 配合 case metadata.maxSteps 断言 max_turns 截断）。
   */
  infiniteTool?: string;
  /** infiniteTool 的参数（缺省 {}） */
  infiniteToolArgs?: Record<string, unknown>;
}

// ─── 用例输入 ─────────────────────────────────────────────────────

export interface AgentInput {
  /** 用户消息 */
  message: string;
  systemPrompt?: string;
  /** 使用的 mock 工具名列表；缺省注册全部标准 mock 工具 */
  tools?: string[];
  /** 预置 mock 文件系统（readFile / writeFile / listDir / search 消费） */
  fs?: Record<string, string>;
  /** mock 模式必填：脚本化 LLM 轮次 */
  mock?: MockScript;
}

// ─── 期望与评分器 ─────────────────────────────────────────────────

/** 期望的工具调用（args 为部分匹配：只断言列出的字段） */
export interface ExpectedToolCall {
  tool: string;
  args?: Record<string, unknown>;
  /** 断言该调用结果是否为错误（undefined = 不断言） */
  isError?: boolean;
}

/** 期望结果的声明式写法（loader 会归一化为 scorers） */
export type ExpectedResult =
  | { type: 'exact'; value: string }
  | { type: 'contains'; value: string }
  | { type: 'regex'; value: string; flags?: string }
  | { type: 'tool-call'; calls: ExpectedToolCall[]; order?: 'exact' | 'subset' }
  | { type: 'tools-used'; tools: string[] }
  | { type: 'json-field'; path: string; value?: unknown }
  | { type: 'success'; value?: boolean }
  | { type: 'stop-reason'; value: string };

/** M1 支持的规则评分器类型 */
export type RuleScorerType =
  | 'exact'
  | 'contains'
  | 'regex'
  | 'json-field'
  | 'tool-call'
  | 'tools-used'
  | 'success'
  | 'stop-reason';

/** 全量评分器类型（M5 扩展 semantic / llm-judge） */
export type ScorerType = RuleScorerType | 'semantic' | 'llm-judge';

export interface ScorerConfig {
  type: ScorerType;
  /** 评分器参数（各评分器自定义，见 rule.ts） */
  params: Record<string, unknown>;
  /** 加权（缺省 1）；M1 规则评分器只看 passed，权重影响加权分 */
  weight?: number;
}

// ─── 用例 ─────────────────────────────────────────────────────────

export interface EvalCase {
  /** 全局唯一，如 'tool-calling/single-echo' */
  id: string;
  /** 套件名：'agent-e2e' | 'tool-calling' | 'text-output' | ... */
  suite: string;
  /** 一句话描述（报告展示用） */
  description?: string;
  input: AgentInput;
  /** 声明式期望（归一化为 scorers，与 scorers 字段可并存） */
  expected?: ExpectedResult;
  /** 显式评分器配置（与 expected 可并存） */
  scorers?: ScorerConfig[];
  origin: CaseOrigin;
  metadata?: {
    tags?: string[];
    /** 工具调用步数上限（映射 RuntimeOptions.maxTurns，缺省 50） */
    maxSteps?: number;
    /** 单用例墙钟超时 ms（缺省 30000） */
    timeoutMs?: number;
    /** usage.total token 上限（预算熔断） */
    maxTokens?: number;
  };
}

// ─── 运行轨迹（评分器输入）────────────────────────────────────────

/** 完整轨迹中的一条工具调用记录（从会话消息重建） */
export interface ToolCallRecord {
  id: string;
  name: string;
  args: unknown;
  /** 对应 toolResult 的 isError（结果缺失时 undefined） */
  isError?: boolean;
}

/** 单个用例一次运行的完整产物 */
export interface RunTrace {
  caseId: string;
  suite: string;
  origin: CaseOrigin;
  result: Result;
  /** 按时间序的工具调用轨迹（含参数与顺序） */
  trajectory: ToolCallRecord[];
  messages: Message[];
  durationMs: number;
  usageTotal: number;
  /** 实际对话轮数 */
  turns: number;
}

// ─── 评分结果 ─────────────────────────────────────────────────────

export interface ScoreResult {
  scorer: ScorerType;
  /** 0~1；规则评分器为 0/1 */
  score: number;
  passed: boolean;
  reason: string;
  /** 命中证据（文本片段 / 工具调用序号） */
  evidence?: string;
}

// ─── 用例结果与报告 ───────────────────────────────────────────────

export interface CaseResult {
  caseId: string;
  suite: string;
  origin: CaseOrigin;
  passed: boolean;
  /** 加权平均分 0~1 */
  score: number;
  scores: ScoreResult[];
  /** 运行错误（超时 / 熔断 / 框架异常） */
  error?: string;
  durationMs: number;
  /** 工具调用步数 */
  steps: number;
  usageTotal: number;
}

export interface SuiteSummary {
  total: number;
  passed: number;
  passRate: number;
  avgScore: number;
}

export interface EvalReport {
  runId: string;
  startedAt: string;
  durationMs: number;
  mode: 'mock' | 'live';
  model?: string;
  totals: {
    cases: number;
    passed: number;
    passRate: number;
    avgScore: number;
    usageTotal: number;
  };
  bySuite: Record<string, SuiteSummary>;
  byOrigin: Record<string, SuiteSummary>;
  results: CaseResult[];
}

// ─── 运行配置 ─────────────────────────────────────────────────────

export interface RunConfig {
  mode: 'mock' | 'live';
  /** 只跑指定套件；缺省全部 */
  suites?: string[];
  /** 每用例重复次数（消随机性）；mock 模式缺省 1 */
  repeats?: number;
  /** 用例并发数（缺省 8） */
  concurrency?: number;
  /** 单用例墙钟超时 ms（缺省 30000，case metadata 可覆盖） */
  timeoutMs?: number;
  /** maxTurns 全局缺省（缺省 50，case metadata 可覆盖） */
  maxSteps?: number;
  /** 用例目录（loader 用） */
  casesDir?: string;
  /** 报告输出目录（缺省 ./eval-results） */
  reportDir?: string;
  /** baseline 文件路径（门禁对比） */
  baselinePath?: string;
  /** 通过率回归阈值（缺省 0.02） */
  regressionThreshold?: number;
  /** 更新 baseline 文件 */
  updateBaseline?: boolean;
}

// ─── Baseline 门禁 ────────────────────────────────────────────────

export interface BaselineFile {
  /** 生成 baseline 的 runId */
  runId: string;
  updatedAt: string;
  totals: { cases: number; passed: number; passRate: number };
  bySuite: Record<string, { total: number; passed: number; passRate: number }>;
}

export interface BaselineComparison {
  ok: boolean;
  overallDelta: number;
  regressions: Array<{ suite: string; baseline: number; current: number; delta: number }>;
}
