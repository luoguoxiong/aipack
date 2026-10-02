// @aipack-ai/eval 文档代码样例

export const evalQuickstartCode = `import {
  loadCases,
  runEval,
  renderMarkdown,
  compareBaseline,
} from '@aipack-ai/eval';

// 1. 加载用例（默认 eval/cases 目录）
const { cases, errors } = await loadCases('./eval/cases');

// 2. 运行评测（mock 模式：fixture replay，确定性、零 API Key）
const report = await runEval(cases, { mode: 'mock' });

// 3. 渲染 Markdown 报告
console.log(renderMarkdown(report));

// 4. CI 门禁：与 baseline 对比，回归超阈值则失败
const comparison = compareBaseline(report, {
  runId: 'baseline-001',
  updatedAt: new Date().toISOString(),
  totals: { cases: 42, passed: 42, passRate: 1 },
  bySuite: {},
}, 0.02);

if (!comparison.ok) process.exit(1);`;

export const evalCaseCode = `{
  "id": "tool-calling/read-then-answer",
  "suite": "tool-calling",
  "description": "先读文件再回答：断言工具轨迹 + 文本结果",
  "origin": "handwritten",
  "input": {
    "message": "读取 /notes/todo.md 并总结",
    "fs": { "/notes/todo.md": "- 买牛奶\\n- 写报告" },
    "mock": {
      "turns": [
        { "toolCalls": [{ "name": "readFile", "args": { "path": "/notes/todo.md" } }] },
        { "text": "待办：买牛奶、写报告" }
      ]
    }
  },
  "expected": {
    "type": "tool-call",
    "order": "exact",
    "calls": [
      { "tool": "readFile", "args": { "path": "/notes/todo.md" }, "isError": false }
    ]
  },
  "scorers": [
    { "type": "contains", "params": { "value": "买牛奶" }, "weight": 2 }
  ]
}`;

export const evalMaxStepsCaseCode = `{
  "id": "tool-calling/max-steps-termination",
  "suite": "tool-calling",
  "description": "死循环被 maxTurns 截断：stopReason = max_turns",
  "origin": "handwritten",
  "input": {
    "message": "不停地回显",
    "mock": {
      "turns": [{ "toolCalls": [{ "name": "echo", "args": { "message": "loop" } }] }],
      "infiniteTool": "echo",
      "infiniteToolArgs": { "message": "loop" }
    }
  },
  "metadata": { "maxSteps": 3 },
  "scorers": [
    { "type": "stop-reason", "params": { "value": "max_turns" } },
    { "type": "tools-used", "params": { "tools": ["echo"] } }
  ]
}`;

export const evalMockToolsCode = `import { createMockTools, createMockStreamFn } from '@aipack-ai/eval';

// 标准工具集（case input.tools 缺省时全量注册）：
//   echo      回显参数
//   readFile  读 case 预置内存文件系统
//   writeFile 写内存文件系统
//   listDir   列出前缀匹配的文件
//   search    跨文件全文检索
//   fail      恒定失败（测错误恢复轨迹）

const tools = createMockTools(
  { '/notes/todo.md': '- 买牛奶' },   // 预置 fs（按 case 隔离，深拷贝）
  ['readFile', 'echo'],              // 只注册部分工具
);

// 也可以直接驱动 mock 流（DIY runner 用）：
const streamFn = createMockStreamFn({
  turns: [
    { toolCalls: [{ name: 'echo', args: { message: 'hi' } }] },
    { text: 'done' },
  ],
});`;

export const evalLiveCode = `# CLI 指定模型
aipack-eval run --mode live --model deepseek/deepseek-chat

# 或用环境变量（优先级低于显式参数，便于 CI secrets 注入）
export AIPACK_EVAL_MODEL=deepseek/deepseek-chat
export DEEPSEEK_API_KEY=sk-...
aipack-eval run --mode live

# 端点覆盖（代理 / OpenAI 兼容网关）+ 重复消噪（pass@k 判定）
aipack-eval run --mode live \\
  --base-url https://gateway.example.com/v1 \\
  --repeats 3 --temperature 0 \\
  --max-tokens 500000     # 全局 token 预算，超限熔断剩余用例`;

export const evalLiveProgrammaticCode = `import { runEval, resolveLiveLlm, describeLiveLlm } from '@aipack-ai/eval';

// live 模式下工具仍走 mock 工具集，保证环境确定性；
// 只有 LLM 是真实的。
const report = await runEval(cases, {
  mode: 'live',
  model: 'deepseek/deepseek-chat',
  temperature: 0,     // 缺省 0，消随机性
  repeats: 3,         // 每用例重复 3 次，pass@k：通过 1 次即算过
  concurrency: 8,
  timeoutMs: 30000,
});`;

export const evalScorersCode = `// 声明式 expected（loader 自动归一化为 scorers）
{
  "expected": { "type": "contains", "value": "北京" }
}

// 显式 scorer 配置（weight 影响加权分）
{
  "scorers": [
    { "type": "exact",       "params": { "value": "pong" } },
    { "type": "regex",       "params": { "value": "\\\\d{4}-\\\\d{2}", "flags": "i" } },
    { "type": "json-field",  "params": { "path": "user.name", "value": "Alice" } },
    { "type": "tool-call",   "params": { "order": "exact", "calls": [
        { "tool": "readFile", "args": { "path": "/a.md" }, "isError": false }
    ] } },
    { "type": "tools-used",  "params": { "tools": ["search", "readFile"] } },
    { "type": "success",     "params": { "value": true } },
    { "type": "stop-reason", "params": { "value": "stop" } },
    { "type": "llm-judge",   "params": { "rubric": "回答是否准确且简洁" }, "weight": 2 }
  ]
}`;

export const evalCliCode = `# ─── run：跑评测 ───
aipack-eval run                              # mock 模式全量
aipack-eval run --suite tool-calling --suite agent-e2e
aipack-eval run --mode live --model deepseek/deepseek-chat --repeats 3

# 报告写盘 + 历史趋势
aipack-eval run --report-dir ./eval-results --history ./eval-results/history.jsonl

# ─── compare：多模型对比（同一组用例横评）───
aipack-eval compare --models deepseek/deepseek-chat,openai/gpt-4o-mini --mode live

# ─── import：trace 回流入库 ───
aipack-eval import --file export.json --origin trace --prefix bugfix --dry-run

# ─── history：日环比趋势（sparkline）───
aipack-eval history --limit 15

# 退出码：0 = 全过且无回归；1 = 有失败或回归；2 = 用法错误`;

export const evalBaselineCode = `# 1. 首次生成 baseline
aipack-eval run --update-baseline --baseline ./eval-baseline.json

# 2. CI 中对比（通过率回归超过阈值即失败）
aipack-eval run --baseline ./eval-baseline.json --threshold 0.02

# 输出示例：
# ⚠️  baseline 回归（整体 -4.2%）:
#   - tool-calling: 100.0% → 95.8%（-4.2%）`;

export const evalBaselineProgrammaticCode = `import {
  runEval, writeBaseline, readBaseline,
  reportToBaseline, compareBaseline, finalizeReport,
} from '@aipack-ai/eval';

const report = await runEval(cases, { mode: 'mock' });

// 首次：写 baseline
await writeBaseline('./eval-baseline.json', reportToBaseline(report));

// 之后：对比 + 门禁
const baseline = await readBaseline('./eval-baseline.json');
const comparison = compareBaseline(report, baseline, 0.02); // 缺省阈值 2%
if (!comparison.ok) {
  console.error('回归：', comparison.regressions);
  process.exitCode = 1;
}`;

export const evalImportCode = `# trace 回流：把 export-eval 导出的 JSON 变成回归用例
aipack-eval import --file export-eval.json \\
  --origin trace \\          # 覆盖来源（trace | bugfix）
  --prefix bugfix \\         # case id 加前缀
  --suite regression \\      # 覆盖套件
  --dry-run                 # 只校验不写盘

# 入库后按来源分组，报告可诊断 eval 集与真实分布的漂移
aipack-eval run --suite regression`;

export const evalHistoryCode = `import {
  appendHistory, readHistory,
  renderHistoryTrend, reportToHistoryEntry, sparkline,
} from '@aipack-ai/eval';

// 每次运行后追加历史（JSONL）
await appendHistory('./eval-results/history.jsonl', reportToHistoryEntry(report));

// 读取并渲染趋势（CLI 也可：aipack-eval history）
const entries = await readHistory('./eval-results/history.jsonl', 15);
console.log(renderHistoryTrend(entries, 15));

// sparkline：▁▂▃▅▇ 形式的通过率趋势`;

export const evalJudgeCode = `# LLM-as-judge：judge 模型必须与被测模型异源（防同源偏置）
aipack-eval run --mode live \\
  --model openai/gpt-4o-mini \\
  --judge-model anthropic/claude-sonnet-4-5 \\
  --judge-api-key $ANTHROPIC_API_KEY

# semantic 评分器：配置 embedding 模型（OpenAI 兼容 /embeddings）
aipack-eval run --mode live \\
  --embed-model text-embedding-3-small \\
  --embed-api-key $OPENAI_API_KEY

# 环境变量等价：
#   AIPACK_EVAL_JUDGE_MODEL / AIPACK_EVAL_JUDGE_API_KEY
#   AIPACK_EVAL_EMBEDDING_MODEL / AIPACK_EVAL_EMBEDDING_API_KEY`;
