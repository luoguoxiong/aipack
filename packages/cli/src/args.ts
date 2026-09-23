/**
 * CLI 参数解析与帮助文本（参考 pi 的 args.ts，适配 aipack）
 */
import type { ThinkingLevel } from '@aipack-ai/agent';
import chalk from 'chalk';
import { APP_NAME, VERSION } from './version.js';

export type Mode = 'text' | 'json';

export interface Args {
  provider?: string;
  model?: string;
  apiKey?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string[];
  thinking?: ThinkingLevel;
  continue?: boolean;
  resume?: boolean;
  help?: boolean;
  version?: boolean;
  mode?: Mode;
  name?: string;
  noSession?: boolean;
  session?: string;
  sessionDir?: string;
  tools?: string[];
  excludeTools?: string[];
  noTools?: boolean;
  print?: boolean;
  listModels?: string | true;
  /** 保守模式：写文件与 shell 全部人工确认 */
  safe?: boolean;
  /** 关闭上下文压缩（内置摘要压缩与五级压缩 transformer 均不启用） */
  noCompaction?: boolean;
  /** 压缩配置文件路径（JSON，DeepPartial<CompressionConfig> 结构，叠加在默认配置上） */
  compactionConfig?: string;
  /** 位置参数（用户消息） */
  messages: string[];
  /** @file 引用 */
  fileArgs: string[];
  diagnostics: Array<{ type: 'warning' | 'error'; message: string }>;
}

const VALID_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'max'] as const;

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
  return (VALID_THINKING_LEVELS as readonly string[]).includes(level);
}

export function parseArgs(args: string[]): Args {
  const result: Args = {
    messages: [],
    fileArgs: [],
    diagnostics: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--version' || arg === '-v') {
      result.version = true;
    } else if (arg === '--mode' && i + 1 < args.length) {
      const mode = args[++i];
      if (mode === 'text' || mode === 'json') {
        result.mode = mode;
      } else {
        result.diagnostics.push({ type: 'error', message: `无效的 mode: ${mode}（可选 text / json）` });
      }
    } else if (arg === '--continue' || arg === '-c') {
      result.continue = true;
    } else if (arg === '--resume' || arg === '-r') {
      result.resume = true;
    } else if (arg === '--provider' && i + 1 < args.length) {
      result.provider = args[++i];
    } else if (arg === '--model' && i + 1 < args.length) {
      result.model = args[++i];
    } else if (arg === '--api-key' && i + 1 < args.length) {
      result.apiKey = args[++i];
    } else if (arg === '--system-prompt' && i + 1 < args.length) {
      result.systemPrompt = args[++i];
    } else if (arg === '--append-system-prompt' && i + 1 < args.length) {
      result.appendSystemPrompt = result.appendSystemPrompt ?? [];
      result.appendSystemPrompt.push(args[++i]);
    } else if (arg === '--thinking' && i + 1 < args.length) {
      const level = args[++i];
      if (isValidThinkingLevel(level)) {
        result.thinking = level;
      } else {
        result.diagnostics.push({
          type: 'warning',
          message: `无效的思考级别 "${level}"。可选: ${VALID_THINKING_LEVELS.join(', ')}`,
        });
      }
    } else if (arg === '--name' || arg === '-n') {
      if (i + 1 < args.length) {
        result.name = args[++i];
      } else {
        result.diagnostics.push({ type: 'error', message: '--name 需要一个值' });
      }
    } else if (arg === '--no-session') {
      result.noSession = true;
    } else if (arg === '--session' && i + 1 < args.length) {
      result.session = args[++i];
    } else if (arg === '--session-dir' && i + 1 < args.length) {
      result.sessionDir = args[++i];
    } else if ((arg === '--tools' || arg === '-t') && i + 1 < args.length) {
      result.tools = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if ((arg === '--exclude-tools' || arg === '-xt') && i + 1 < args.length) {
      result.excludeTools = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg === '--no-tools' || arg === '-nt') {
      result.noTools = true;
    } else if (arg === '--safe') {
      result.safe = true;
    } else if (arg === '--no-compaction') {
      result.noCompaction = true;
    } else if (arg === '--compaction-config' && i + 1 < args.length) {
      result.compactionConfig = args[++i];
    } else if (arg === '--print' || arg === '-p') {
      result.print = true;
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('@') && !next.startsWith('-')) {
        result.messages.push(next);
        i++;
      }
    } else if (arg === '--list-models') {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-') && !next.startsWith('@')) {
        result.listModels = next;
        i++;
      } else {
        result.listModels = true;
      }
    } else if (arg.startsWith('@')) {
      result.fileArgs.push(arg.slice(1));
    } else if (arg.startsWith('--')) {
      result.diagnostics.push({ type: 'error', message: `未知选项: ${arg}` });
    } else if (arg.startsWith('-') && arg !== '-') {
      result.diagnostics.push({ type: 'error', message: `未知选项: ${arg}` });
    } else {
      result.messages.push(arg);
    }
  }

  return result;
}

export function printHelp(): void {
  const c = chalk;
  const title = c.bold.cyan(`${APP_NAME} ${VERSION}`);
  const head = (s: string): string => c.bold.magenta(s);
  const opt = (flag: string, desc: string): string =>
    `  ${c.green(flag.padEnd(28))} ${c.dim(desc)}`;

  console.log(`${title}  ${c.dim('· 终端 AI 编程助手')}

${head('用法:')}
  ${c.cyan(APP_NAME)} ${c.dim('[选项]')} ${c.yellow('[@文件...]')} ${c.dim('[消息...]')}

${head('子命令:')}
${opt('approvals list', '列出未决审批单')}
${opt('approvals approve <id>', '批准审批单')}
${opt('approvals deny <id>', '驳回审批单')}
${opt('--list-models [搜索]', '列出可用模型（标注 API Key 配置状态）')}

${head('模式:')}
${opt('(默认)', '交互模式（REPL），支持斜杠命令与多行输入')}
${opt('--print, -p [消息]', '非交互：处理一次提示后退出（支持管道 stdin）')}
${opt('--mode json', '以 JSON 行输出全部流式事件')}

${head('模型选项:')}
${opt('--provider <名称>', '提供商（openai/deepseek/anthropic/google...）')}
${opt('--model <id>', '模型 ID，支持 provider/id 组合写法')}
${opt('--api-key <key>', 'API Key（覆盖环境变量）')}
${opt('--thinking <级别>', '思考级别: off/minimal/low/medium/high/max')}

${head('会话选项:')}
${opt('--continue, -c', '继续当前目录最近的会话')}
${opt('--resume, -r', '浏览并选择历史会话')}
${opt('--session <名称>', '使用指定会话')}
${opt('--name, -n <名称>', '为新会话命名')}
${opt('--session-dir <目录>', '自定义会话存储目录')}
${opt('--no-session', '临时会话（不持久化）')}

${head('工具与权限:')}
${opt('--tools, -t <列表>', '工具白名单（逗号分隔）')}
${opt('--exclude-tools, -xt <列表>', '工具黑名单（逗号分隔）')}
${opt('--no-tools, -nt', '禁用全部工具')}
${opt('--safe', '保守模式：写文件/shell 全部人工确认')}

  ${c.dim('内置工具:')} read · write · edit · bash · find · grep · ls
  ${c.dim('默认权限:')} 读/写文件静默放行（工作区范围）；bash 仅危险命令需确认
            ${c.dim('（rm 删除、sudo、磁盘写入、远程脚本管道等；危险命令每次重确认）')}

${head('上下文压缩:')}
${opt('--no-compaction', '关闭上下文压缩（长会话可能溢出）')}
${opt('--compaction-config <文件>', '压缩配置 JSON（覆盖默认阈值）')}

${head('其他:')}
${opt('--system-prompt <文本>', '替换默认系统提示词')}
${opt('--append-system-prompt <文本>', '追加系统提示词（可多次）')}
${opt('--help, -h', '显示本帮助')}
${opt('--version, -v', '显示版本')}

${head('交互模式:')}
  ${c.dim('· 多行输入：行尾以')} ${c.yellow('\\')} ${c.dim('续行，空行提交')}
  ${c.dim('· 斜杠命令：/help /model /thinking /clear /compact /sessions /quit')}
  ${c.dim('· Ctrl+C 中断运行，连按两次退出')}

${head('示例:')}
  ${c.dim('# 交互模式')}
  ${c.cyan(APP_NAME)}
  ${c.dim('# 管道单次提问')}
  ${c.yellow('cat README.md')} ${c.dim('|')} ${c.cyan(APP_NAME)} ${c.green('-p')} ${c.yellow('"总结这段文本"')}
  ${c.dim('# 指定模型（provider/id）')}
  ${c.cyan(APP_NAME)} ${c.green('--model')} ${c.yellow('deepseek/deepseek-chat')} ${c.yellow('"你好"')}
  ${c.dim('# 附带文件上下文（图片走多模态）')}
  ${c.cyan(APP_NAME)} ${c.yellow('@package.json')} ${c.yellow('"分析依赖"')}
  ${c.dim('# 继续上次会话')}
  ${c.cyan(APP_NAME)} ${c.green('-c')} ${c.yellow('"我们刚才聊到哪里了？"')}
  ${c.dim('# 只读审查')}
  ${c.cyan(APP_NAME)} ${c.green('-t')} ${c.yellow('read,find,grep')} ${c.green('-p')} ${c.yellow('"审查 src/"')}

${head('环境变量:')}
  ${c.dim('OPENAI_API_KEY / DEEPSEEK_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY ...')}
  ${c.dim('AIPACK_CONFIG_DIR')} ${c.dim('→')} ${c.dim('配置目录（默认 ~/.aipack）')}
`);
}
