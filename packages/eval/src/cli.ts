#!/usr/bin/env node
/**
 * packages/eval/src/cli.ts - aipack-eval 命令行入口
 *
 * 用法：
 *   aipack-eval run [--suite <name>]... [--mode mock|live] [--model provider/id]
 *                   [--api-key <key>] [--base-url <url>] [--temperature <0>]
 *                   [--repeats <n>] [--cases-dir <dir>] [--report-dir <dir>]
 *                   [--history <path>] [--baseline <path>] [--update-baseline]
 *                   [--judge-model provider/id] [--embed-model <id>]
 *   aipack-eval compare --models m1,m2[,...] [--suite <name>]... [--mode live] ...
 *   aipack-eval import --file <export.json> [--out-dir <dir>] [--suite <name>]
 *                      [--origin trace|bugfix] [--prefix <p>] [--dry-run]
 *   aipack-eval history [--path <file>] [--limit <n>] [--json]
 *
 * 退出码：0 = 全过且无回归；1 = 有失败或回归；2 = 用法错误。
 */

import { loadCases } from './core/loader';
import { runEval } from './core/runner';
import { finalizeReport, renderMarkdown } from './core/report';
import { readHistory, renderHistoryTrend } from './core/history';
import { compareModels, renderComparisonMarkdown } from './core/compare';
import { importCases } from './core/import';
import type { CaseOrigin, EvalReport, RunConfig } from './core/types';

type Mode = 'mock' | 'live';

interface RunArgs {
  suites: string[];
  mode: Mode;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  casesDir?: string;
  reportDir?: string;
  historyPath?: string;
  baselinePath?: string;
  updateBaseline: boolean;
  threshold: number;
  repeats?: number;
  concurrency?: number;
  timeoutMs?: number;
  maxTotalTokens?: number;
  // M5：judge / embedding 装配
  judgeModel?: string;
  judgeApiKey?: string;
  judgeBaseUrl?: string;
  embedModel?: string;
  embedApiKey?: string;
  embedBaseUrl?: string;
  /** compare 子命令：被测模型列表（逗号分隔或 --models 多次） */
  models?: string[];
}

const USAGE = `用法: aipack-eval <run|compare|import|history> [options]

run 选项:
  --suite <name>         只跑指定套件（可多次）
  --mode <mock|live>     运行模式（缺省 mock；live = 真实 LLM）
  --model <provider/id>  live 模型，如 deepseek/deepseek-chat（或 AIPACK_EVAL_MODEL）
  --api-key <key>        live API Key（或 <PROVIDER>_API_KEY）
  --base-url <url>       live 端点覆盖（代理 / 兼容网关）
  --temperature <x>      live 采样温度（缺省 0）
  --repeats <n>          每用例重复次数（live 缺省 3，pass@k 判定）
  --concurrency <n>      并发用例数（缺省 8）
  --timeout <ms>         单用例墙钟超时（缺省 30000）
  --max-tokens <n>       全局 token 预算，超限熔断剩余用例
  --cases-dir <dir>      用例目录（缺省 <包根>/eval/cases）
  --report-dir <dir>     报告输出目录（缺省不写盘；'none' 不写盘）
  --history <path>       历史趋势 JSONL（缺省 <report-dir>/history.jsonl）
  --baseline <path>      baseline 文件（门禁对比）
  --update-baseline      用本次结果更新 baseline
  --threshold <x>        通过率回归阈值（缺省 0.02）
  --judge-model <p/id>   LLM-as-judge 模型（须与被测模型异源；或 AIPACK_EVAL_JUDGE_MODEL）
  --judge-api-key <key>  judge API Key（或 AIPACK_EVAL_JUDGE_API_KEY）
  --judge-base-url <url> judge 端点覆盖
  --embed-model <id>     semantic 评分器的 embedding 模型（或 AIPACK_EVAL_EMBEDDING_MODEL）
  --embed-api-key <key>  embedding API Key（或 AIPACK_EVAL_EMBEDDING_API_KEY / OPENAI_API_KEY）
  --embed-base-url <url> embedding 端点覆盖（OpenAI 兼容 /embeddings）

compare 选项（L4 模型对比）:
  --models <m1,m2,...>   被测模型列表（逗号分隔，可多次；每模型跑同一组用例）
  其余同 run（忽略 baseline / history）。

import 选项（trace 回流入库）:
  --file <path>          export-eval 导出的 JSON（单 case / 数组 / {cases:[...]})
  --out-dir <dir>        用例目录（缺省 <包根>/eval/cases）
  --suite <name>         覆盖套件
  --origin <o>           覆盖来源（trace | bugfix）
  --prefix <p>           case id 加前缀（如 bugfix）
  --dry-run              只校验不写盘

history 选项:
  --path <file>          历史文件（缺省 ./eval-results/history.jsonl）
  --limit <n>            展示最近 N 次（缺省 15）
  --json                 输出原始 JSONL 条目

公共:
  -h, --help             显示帮助`;

function num(raw: string, label: string): number {
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${label} 必须为数字`);
  return v;
}

function parseRunArgs(argv: string[]): RunArgs | { error: string } {
  const args: RunArgs = {
    suites: [],
    mode: 'mock',
    updateBaseline: false,
    threshold: 0.02,
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`选项 ${a} 缺少参数值`);
      return v;
    };
    try {
      switch (a) {
        case '--suite':
          args.suites.push(next());
          break;
        case '--mode': {
          const v = next();
          if (v !== 'mock' && v !== 'live') throw new Error('--mode 只能为 mock 或 live');
          args.mode = v;
          break;
        }
        case '--model':
          args.model = next();
          break;
        case '--api-key':
          args.apiKey = next();
          break;
        case '--base-url':
          args.baseUrl = next();
          break;
        case '--temperature':
          args.temperature = num(next(), '--temperature');
          break;
        case '--repeats': {
          const v = Number(next());
          if (!Number.isInteger(v) || v < 1) throw new Error('repeats 须为正整数');
          args.repeats = v;
          break;
        }
        case '--concurrency': {
          const v = Number(next());
          if (!Number.isInteger(v) || v < 1) throw new Error('concurrency 须为正整数');
          args.concurrency = v;
          break;
        }
        case '--timeout': {
          const v = Number(next());
          if (!Number.isFinite(v) || v <= 0) throw new Error('timeout 须为正数(ms)');
          args.timeoutMs = v;
          break;
        }
        case '--max-tokens': {
          const v = Number(next());
          if (!Number.isFinite(v) || v <= 0) throw new Error('max-tokens 须为正数');
          args.maxTotalTokens = v;
          break;
        }
        case '--cases-dir':
          args.casesDir = next();
          break;
        case '--report-dir':
          args.reportDir = next();
          break;
        case '--history':
          args.historyPath = next();
          break;
        case '--baseline':
          args.baselinePath = next();
          break;
        case '--update-baseline':
          args.updateBaseline = true;
          break;
        case '--threshold': {
          const v = Number(next());
          if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error('阈值须为 0~1');
          args.threshold = v;
          break;
        }
        case '--judge-model':
          args.judgeModel = next();
          break;
        case '--judge-api-key':
          args.judgeApiKey = next();
          break;
        case '--judge-base-url':
          args.judgeBaseUrl = next();
          break;
        case '--embed-model':
          args.embedModel = next();
          break;
        case '--embed-api-key':
          args.embedApiKey = next();
          break;
        case '--embed-base-url':
          args.embedBaseUrl = next();
          break;
        case '--models':
          args.models = (args.models ?? []).concat(
            next()
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          );
          break;
        case '-h':
        case '--help':
          return { error: 'HELP' };
        default:
          return { error: `未知参数: ${a}\n${USAGE}` };
      }
    } catch (e) {
      return { error: `${(e as Error).message}\n${USAGE}` };
    }
    i += 1;
  }
  return args;
}

async function cmdRun(argv: string[]): Promise<number> {
  const parsed = parseRunArgs(argv);
  if ('error' in parsed) {
    if (parsed.error === 'HELP') {
      console.log(USAGE);
      return 0;
    }
    console.error(parsed.error);
    return 2;
  }

  const { cases, errors } = await loadCases(parsed.casesDir);
  if (errors.length > 0) {
    console.error('用例加载错误:');
    for (const e of errors) console.error(`  - ${e}`);
    return 1;
  }
  if (cases.length === 0) {
    console.error('没有可运行的用例');
    return 1;
  }

  const reportDir = parsed.reportDir === 'none' ? undefined : parsed.reportDir;
  const historyPath =
    parsed.historyPath ?? (reportDir ? `${reportDir.replace(/\/$/, '')}/history.jsonl` : undefined);

  const config: RunConfig = {
    mode: parsed.mode,
    model: parsed.model,
    apiKey: parsed.apiKey,
    baseUrl: parsed.baseUrl,
    temperature: parsed.temperature,
    suites: parsed.suites,
    repeats: parsed.repeats,
    concurrency: parsed.concurrency,
    timeoutMs: parsed.timeoutMs,
    maxTotalTokens: parsed.maxTotalTokens,
    casesDir: parsed.casesDir,
    reportDir,
    historyPath,
    baselinePath: parsed.baselinePath,
    updateBaseline: parsed.updateBaseline,
    regressionThreshold: parsed.threshold,
    judgeModel: parsed.judgeModel,
    judgeApiKey: parsed.judgeApiKey,
    judgeBaseUrl: parsed.judgeBaseUrl,
    embedModel: parsed.embedModel,
    embedApiKey: parsed.embedApiKey,
    embedBaseUrl: parsed.embedBaseUrl,
  };

  console.error(
    `加载 ${cases.length} 个用例${parsed.suites.length ? `（套件: ${parsed.suites.join(', ')}）` : ''}，mode=${parsed.mode}`,
  );

  let report: EvalReport;
  try {
    report = await runEval(cases, config);
  } catch (e) {
    // live 装配失败（缺模型 / 缺 Key）属于使用错误
    console.error(`live 模式配置错误: ${(e as Error).message}`);
    return 2;
  }

  const finalized = await finalizeReport(report, config);
  console.log(renderMarkdown(report, { history: finalized.history }));

  if (report.totals.cases === 0) {
    console.error(
      `\n⚠️  当前 mode=${parsed.mode} 下没有可运行的用例（${report.totals.skipped} 个被跳过），检查 --suite 与 --mode 是否匹配`,
    );
  }

  if (finalized.jsonPath) console.error(`\n报告已写入: ${finalized.jsonPath}`);
  if (finalized.historyPath) console.error(`历史已追加: ${finalized.historyPath}`);
  if (config.updateBaseline && finalized.baseline === undefined) {
    console.error(`baseline 已更新: ${config.baselinePath}`);
  }

  let exitCode = report.totals.passed === report.totals.cases ? 0 : 1;

  if (finalized.comparison && !finalized.comparison.ok) {
    exitCode = 1;
    const { overallDelta, regressions } = finalized.comparison;
    console.error(
      `\n⚠️  baseline 回归（整体 ${overallDelta >= 0 ? '+' : ''}${(overallDelta * 100).toFixed(1)}%）:`,
    );
    for (const r of regressions) {
      console.error(
        `  - ${r.suite}: ${(r.baseline * 100).toFixed(1)}% → ${(r.current * 100).toFixed(1)}%（${(r.delta * 100).toFixed(1)}%）`,
      );
    }
  } else if (finalized.comparison) {
    console.error(`\nbaseline 门禁通过（${(finalized.comparison.overallDelta * 100).toFixed(1)}%）`);
  }

  return exitCode;
}

async function cmdHistory(argv: string[]): Promise<number> {
  let path = 'eval-results/history.jsonl';
  let limit = 15;
  let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      asJson = true;
    } else if (a === '--path') {
      path = argv[++i] ?? path;
    } else if (a === '--limit') {
      limit = Number(argv[++i] ?? limit);
    } else if (a === '-h' || a === '--help') {
      console.log(USAGE);
      return 0;
    } else {
      console.error(`未知参数: ${a}\n${USAGE}`);
      return 2;
    }
  }

  const entries = await readHistory(path, limit);
  if (entries.length === 0) {
    console.error(`历史文件为空或不存在: ${path}`);
    return 1;
  }
  if (asJson) {
    console.log(entries.map((e) => JSON.stringify(e)).join('\n'));
    return 0;
  }
  console.log(renderHistoryTrend(entries, limit));
  return 0;
}

/** L4：同一组用例跨多模型对比（M5） */
async function cmdCompare(argv: string[]): Promise<number> {
  const parsed = parseRunArgs(argv);
  if ('error' in parsed) {
    if (parsed.error === 'HELP') {
      console.log(USAGE);
      return 0;
    }
    console.error(parsed.error);
    return 2;
  }
  const models = parsed.models ?? [];
  if (models.length === 0) {
    console.error(`compare 需要至少一个被测模型：--models deepseek/deepseek-chat,openai/gpt-4o-mini\n${USAGE}`);
    return 2;
  }
  if (models.length !== new Set(models).size) {
    console.error('compare 的 --models 含重复模型');
    return 2;
  }

  const { cases, errors } = await loadCases(parsed.casesDir);
  if (errors.length > 0) {
    console.error('用例加载错误:');
    for (const e of errors) console.error(`  - ${e}`);
    return 1;
  }

  const config: RunConfig = {
    mode: parsed.mode,
    apiKey: parsed.apiKey,
    baseUrl: parsed.baseUrl,
    temperature: parsed.temperature,
    suites: parsed.suites,
    repeats: parsed.repeats,
    concurrency: parsed.concurrency,
    timeoutMs: parsed.timeoutMs,
    maxTotalTokens: parsed.maxTotalTokens,
    casesDir: parsed.casesDir,
    judgeModel: parsed.judgeModel,
    judgeApiKey: parsed.judgeApiKey,
    judgeBaseUrl: parsed.judgeBaseUrl,
    embedModel: parsed.embedModel,
    embedApiKey: parsed.embedApiKey,
    embedBaseUrl: parsed.embedBaseUrl,
  };

  console.error(
    `L4 对比：${models.length} 个模型 × ${cases.length} 个用例（mode=${parsed.mode}${parsed.suites.length ? `，套件: ${parsed.suites.join(', ')}` : ''}）`,
  );

  let comparison;
  try {
    comparison = await compareModels(cases, config, models);
  } catch (e) {
    console.error(`compare 配置错误: ${(e as Error).message}`);
    return 2;
  }

  console.log(renderComparisonMarkdown(comparison));

  // 报告写盘（compare-<ts>.md / .json）
  if (parsed.reportDir && parsed.reportDir !== 'none') {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = parsed.reportDir.replace(/\/$/, '');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const mdPath = join(dir, `compare-${stamp}.md`);
    const jsonPath = join(dir, `compare-${stamp}.json`);
    await mkdir(dir, { recursive: true });
    await writeFile(mdPath, renderComparisonMarkdown(comparison), 'utf-8');
    await writeFile(jsonPath, JSON.stringify(comparison, null, 2), 'utf-8');
    console.error(`\n对比报告已写入: ${mdPath}\n                ${jsonPath}`);
  }

  return 0;
}

/** M4：trace 回流导出 JSON → eval/cases 入库 */
async function cmdImport(argv: string[]): Promise<number> {
  let file: string | undefined;
  let outDir: string | undefined;
  let suite: string | undefined;
  let origin: CaseOrigin | undefined;
  let prefix: string | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`选项 ${a} 缺少参数值`);
      return v;
    };
    try {
      switch (a) {
        case '--file':
          file = next();
          break;
        case '--out-dir':
          outDir = next();
          break;
        case '--suite':
          suite = next();
          break;
        case '--origin': {
          const v = next();
          if (v !== 'trace' && v !== 'bugfix') throw new Error('--origin 只能为 trace 或 bugfix');
          origin = v;
          break;
        }
        case '--prefix':
          prefix = next();
          break;
        case '--dry-run':
          dryRun = true;
          break;
        case '-h':
        case '--help':
          console.log(USAGE);
          return 0;
        default:
          console.error(`未知参数: ${a}\n${USAGE}`);
          return 2;
      }
    } catch (e) {
      console.error(`${(e as Error).message}\n${USAGE}`);
      return 2;
    }
  }

  if (!file) {
    console.error(`import 需要 --file <export.json>\n${USAGE}`);
    return 2;
  }

  const { written, errors } = await importCases({ file, outDir, suite, origin, prefix, dryRun });
  if (errors.length > 0) {
    console.error('入库错误:');
    for (const e of errors) console.error(`  - ${e}`);
  }
  if (written.length > 0) {
    console.error(dryRun ? '校验通过（dry-run，未写盘）:' : `已入库 ${written.length} 个用例:`);
    for (const w of written) console.error(`  - ${w}`);
  }
  return errors.length === 0 && written.length > 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === '-h' || command === '--help') {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command === 'run') return cmdRun(rest);
  if (command === 'compare') return cmdCompare(rest);
  if (command === 'import') return cmdImport(rest);
  if (command === 'history') return cmdHistory(rest);
  console.error(`未知子命令: ${command}\n${USAGE}`);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
