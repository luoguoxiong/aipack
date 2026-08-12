/**
 * apps/ai_office_agent/src/tools/officecli.ts
 *
 * OfficeCLI(https://github.com/iOfficeAI/OfficeCLI)统一封装:
 * 通过 child_process 调用 officecli 单二进制来创建/修改/读取 Office 文档。
 * 无需安装 Office、跨平台(macOS/Linux/Windows)、Apache-2.0 开源。
 * 安装方式:npm i -g @officecli/officecli 或 brew install officecli
 *
 * 设计原则:本 agent 不在代码里写死任何文档模板,所有增删改查都采用
 * 「识别用户意图 → 生成 officecli 参数 → 执行」的模式,由 LLM 负责生成:
 *   - 读取:officecli view <file> <outline|text> --max-lines N
 *   - 写入:officecli create → batch(JSON 命令数组)→ close
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const RUN_TIMEOUT_MS = 120_000;

export class OfficeCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficeCliError';
  }
}

/** officecli 是否已安装 */
export async function officecliAvailable(): Promise<boolean> {
  try {
    await execFileAsync('officecli', ['--version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** 运行 officecli 命令,返回 stdout;未安装/执行失败抛 OfficeCliError */
export async function runOfficeCli(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('officecli', args, {
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    if (e.code === 'ENOENT') {
      throw new OfficeCliError(
        '未检测到 officecli,请先安装:npm i -g @officecli/officecli 或 brew install officecli',
      );
    }
    const stderr = (e.stderr || '').toString().trim();
    const stdout = (e.stdout || '').toString().trim();
    throw new OfficeCliError(`officecli ${args[0] ?? ''} 失败: ${stderr || stdout || e.message}`);
  }
}

/** 创建空白文档并释放驻留(create 会驻留后台进程,须 close 才能让其他程序安全读取文件) */
async function officeCreateClose(abs: string): Promise<void> {
  await runOfficeCli(['create', abs]);
  await runOfficeCli(['close', abs]).catch(() => {});
}

/** 批量执行命令(单次 open→apply→save 周期)后刷盘 */
async function officeBatchClose(abs: string, commands: object[]): Promise<string> {
  const out = await runOfficeCli(['batch', abs, '--commands', JSON.stringify(commands)]);
  await runOfficeCli(['close', abs]).catch(() => {});
  return out;
}

/**
 * 读取文档内容(officecli view):
 *   - xlsx → text(单元格文本)
 *   - docx/pptx → outline(结构大纲:标题/段落/表格/每页内容)
 * maxLines 限制输出行数(防止撑爆上下文),超大文档按行截断。
 */
export async function officeReadDocument(
  abs: string,
  opts?: { mode?: 'outline' | 'text'; maxLines?: number },
): Promise<string> {
  const mode = opts?.mode ?? (path.extname(abs).toLowerCase() === '.xlsx' ? 'text' : 'outline');
  const maxLines = opts?.maxLines ?? 60;
  return await runOfficeCli(['view', abs, mode, '--max-lines', String(maxLines)]);
}

/**
 * 查询 OfficeCLI 能力参考(officecli help):schema 驱动、随版本自动更新。
 *   - 不传 topic:返回该格式全部元素清单
 *   - topic 传元素名(如 cell/chart/autofilter/sort/table)或操作(set/add/remove):返回该元素/操作的完整语法
 *     (支持路径、可用属性、类型、示例),供 LLM 按用户意图生成准确的 batch commands。
 */
export async function officeHelp(
  format: 'xlsx' | 'docx' | 'pptx',
  topic?: string,
): Promise<string> {
  return await runOfficeCli(['help', format, ...(topic ? [topic] : [])]);
}

// ─── 通用脚本执行(LLM 按需生成任意 officecli 命令)────────────────────

export interface OfficeBatchCommand {
  /** 操作:add 新增 / set 修改 / remove 删除 */
  command: 'add' | 'set' | 'remove';
  /** DOM 路径:set/remove 必填,add 可用作 parent 兜底。如 '/Sheet1/A1'、'/Sheet1/A1:K1'、'/slide[2]'、'/body' */
  path?: string;
  /** 父路径:add 必填。如 '/slide[1]'、'/body'、'/Sheet1'、'/sheets[1]' */
  parent?: string;
  /** 元素类型:add 必填。shape/chart/table/picture/paragraph/style/sheet/cell/row/markdown 等 */
  type?: string;
  props?: Record<string, unknown>;
}

/**
 * 直接执行 officecli batch 脚本(单次 open→apply→save 周期)。
 * create=true 时先创建空文档(按扩展名 docx/xlsx/pptx),再执行命令。
 * 返回执行摘要(逐条命令结果)。
 */
export async function officeExecuteScript(
  abs: string,
  commands: OfficeBatchCommand[],
  opts: { create?: boolean } = {},
): Promise<string> {
  if (opts.create) {
    await officeCreateClose(abs);
  }
  return await officeBatchClose(abs, commands as object[]);
}
