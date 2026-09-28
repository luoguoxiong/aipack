#!/usr/bin/env node
/**
 * packages/eval/src/cli.ts - aipack-eval 命令行入口
 *
 * 用法：
 *   aipack-eval run [--suite <name>]... [--cases-dir <dir>] [--repeats <n>]
 *                   [--report-dir <dir>] [--baseline <path>]
 *                   [--update-baseline] [--threshold <0.02>]
 *
 * 退出码：0 = 全过且无回归；1 = 有失败或回归；2 = 用法错误。
 */

import { loadCases } from './core/loader';
import { runEval } from './core/runner';
import { finalizeReport, renderMarkdown } from './core/report';
import type { RunConfig } from './core/types';

interface CliArgs {
  command?: string;
  suites: string[];
  casesDir?: string;
  reportDir?: string;
  baselinePath?: string;
  updateBaseline: boolean;
  threshold: number;
  repeats?: number;
}

const USAGE = `用法: aipack-eval run [options]

选项:
  --suite <name>         只跑指定套件（可多次）
  --cases-dir <dir>      用例目录（缺省 <包根>/eval/cases）
  --report-dir <dir>     报告输出目录（缺省 ./eval-results；'none' 不写盘）
  --baseline <path>      baseline 文件（门禁对比）
  --update-baseline      用本次结果更新 baseline
  --threshold <x>        通过率回归阈值（缺省 0.02）
  --repeats <n>          每用例重复次数（缺省 1）
  -h, --help             显示帮助`;

function parseArgs(argv: string[]): CliArgs | { error: string } {
  const args: CliArgs = {
    suites: [],
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
        case 'run':
          args.command = 'run';
          break;
        case '--suite':
          args.suites.push(next());
          break;
        case '--cases-dir':
          args.casesDir = next();
          break;
        case '--report-dir':
          args.reportDir = next();
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
        case '--repeats': {
          const v = Number(next());
          if (!Number.isInteger(v) || v < 1) throw new Error('repeats 须为正整数');
          args.repeats = v;
          break;
        }
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
  if (args.command !== 'run') return { error: `缺少子命令 'run'\n${USAGE}` };
  return args;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
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

  const config: RunConfig = {
    mode: 'mock',
    suites: parsed.suites,
    repeats: parsed.repeats,
    casesDir: parsed.casesDir,
    reportDir: parsed.reportDir === 'none' ? undefined : parsed.reportDir,
    baselinePath: parsed.baselinePath,
    updateBaseline: parsed.updateBaseline,
    regressionThreshold: parsed.threshold,
  };

  console.error(
    `加载 ${cases.length} 个用例${parsed.suites.length ? `（套件: ${parsed.suites.join(', ')}）` : ''}，mode=mock`,
  );
  const report = await runEval(cases, config);
  const finalized = await finalizeReport(report, config);

  console.log(renderMarkdown(report));

  if (finalized.jsonPath) console.error(`\n报告已写入: ${finalized.jsonPath}`);
  if (config.updateBaseline && finalized.baseline === undefined) {
    console.error(`baseline 已更新: ${config.baselinePath}`);
  }

  let exitCode = report.totals.passed === report.totals.cases ? 0 : 1;

  if (finalized.comparison && !finalized.comparison.ok) {
    exitCode = 1;
    const { overallDelta, regressions } = finalized.comparison;
    console.error(`\n⚠️  baseline 回归（整体 ${overallDelta >= 0 ? '+' : ''}${(overallDelta * 100).toFixed(1)}%）:`);
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

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
