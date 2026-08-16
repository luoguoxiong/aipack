/**
 * CLI 参数解析与帮助文本（参考 pi 的 args.ts，适配 aipack）
 */
import type { ThinkingLevel } from '@aipack-ai/agent';
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
  console.log(`${APP_NAME} ${VERSION} - 基于 @aipack-ai/agent 的终端 AI 助手

${'用法:'}
  ${APP_NAME} [选项] [@文件...] [消息...]

${'子命令:'}
  ${APP_NAME} approvals list              列出未决审批单
  ${APP_NAME} approvals approve <id>      批准审批单
  ${APP_NAME} approvals deny <id>         驳回审批单
  ${APP_NAME} --list-models [搜索]        列出可用模型

${'模式:'}
  (默认)                                交互模式（REPL）
  --print, -p [消息]                    非交互：处理一次提示后退出（支持管道 stdin）
  --mode json                           以 JSON 行输出全部流式事件

${'模型选项:'}
  --provider <名称>                     提供商（openai/deepseek/anthropic/google...）
  --model <id>                          模型 ID，支持 provider/id 组合写法
  --api-key <key>                       API Key（覆盖环境变量）
  --thinking <级别>                     思考级别: off/minimal/low/medium/high/max

${'会话选项:'}
  --continue, -c                        继续当前目录最近的会话
  --resume, -r                          浏览并选择历史会话
  --session <名称>                      使用指定会话
  --name, -n <名称>                     为新会话命名
  --session-dir <目录>                  自定义会话存储目录
  --no-session                          临时会话（不持久化）

${'工具选项:'}
  --tools, -t <列表>                    工具白名单（逗号分隔）
  --exclude-tools, -xt <列表>           工具黑名单（逗号分隔）
  --no-tools, -nt                       禁用全部工具
  --safe                                保守模式：写文件/shell 全部人工确认

  内置工具: read, write, edit, bash, find, grep, ls
  默认权限: 读写文件静默放行（工作区范围内）；bash 仅危险命令
            （sudo、rm -rf ~、磁盘写入、远程脚本管道等）需确认

${'其他:'}
  --system-prompt <文本>                替换默认系统提示词
  --append-system-prompt <文本>         追加系统提示词（可多次）
  --help, -h                            显示帮助
  --version, -v                         显示版本

${'示例:'}
  # 交互模式
  ${APP_NAME}

  # 非交互单次提问（支持管道）
  cat README.md | ${APP_NAME} -p "总结这段文本"

  # 指定模型
  ${APP_NAME} --provider deepseek --model deepseek-chat "你好"

  # provider/id 组合写法
  ${APP_NAME} --model anthropic/claude-sonnet-4-20250514 "帮我重构代码"

  # 附带文件上下文
  ${APP_NAME} @package.json "分析这个文件的依赖"

  # 继续上次会话
  ${APP_NAME} -c "我们刚才聊到哪里了？"

  # 只读模式
  ${APP_NAME} --tools read -p "审查 src/ 下的代码"

${'环境变量:'}
  OPENAI_API_KEY / DEEPSEEK_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY ...
  AIPACK_CONFIG_DIR                       配置目录（默认 ~/.aipack）
`);
}
