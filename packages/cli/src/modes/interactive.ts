/**
 * 交互模式：REPL + 斜杠命令。
 *
 * 输入非斜杠开头的行 → 发送给 runtime 流式执行；
 * 流式期间可继续输入（提示排队/丢弃），Ctrl+C 中断当前运行，连按两次退出。
 *
 * 权限确认期间关闭主 readline，由 select 选择器（方向键）接管终端，
 * 确认结束重建 readline。
 */
import readline from 'node:readline';
import chalk from 'chalk';
import {
  getBuiltinModels,
  adaptAiModel,
} from '@aipack-ai/agent';
import type {
  Runtime,
  ResultChunk,
  Request,
  ApprovalManager,
  SessionStorage,
  ThinkingLevel,
  PermissionRequest,
} from '@aipack-ai/agent';
import type { Args } from '../args.js';
import type { ResolvedModel } from '../builder.js';
import { listSessionsByRecency } from '../builder.js';
import type { McpPlugin } from '@aipack-ai/mcp';
import { ChunkRenderer } from './render.js';
import { ask } from '../prompt.js';
import { printStartupBanner } from '../banner.js';

export interface InteractiveOptions {
  runtime: Runtime;
  sessionKey: string;
  model: ResolvedModel;
  args: Args;
  storage?: SessionStorage;
  approvalManager?: ApprovalManager;
  /** MCP 插件（/mcp 命令用；无 .mcp.json 配置时为 undefined） */
  mcp?: McpPlugin;
  /** 启动时的初始消息（aipack "帮我..."） */
  initialMessages?: string[];
  /** confirm 委托（cli.ts 创建；此处包装为"关 rl → select → 重建 rl"后生效） */
  confirmRef?: { fn: (req: PermissionRequest) => Promise<boolean> };
  /** 基础确认逻辑（含"总是允许"会话记忆），由 cli.ts 注入 */
  baseConfirm: (req: PermissionRequest) => Promise<boolean>;
}

const VALID_THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'max']);

export async function runInteractiveMode(opts: InteractiveOptions): Promise<void> {
  const { runtime, sessionKey, model, args, storage, approvalManager, mcp } = opts;

  // --resume：先选会话
  let activeKey = sessionKey;
  if (args.resume && storage) {
    const picked = await pickSessionInteractively(storage, sessionKey);
    if (picked) activeKey = picked;
  }

  const renderer = new ChunkRenderer();
  let busy = false;
  let sigintCount = 0;

  /** 多行输入缓存：行尾以 \ 续行时累加，直至遇到普通行 */
  let pendingMultiline: string[] = [];

  /** 主循环存活 Promise：cleanup 时 resolve，进程由 cli.ts 收尾 */
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });

  function cleanup(): void {
    finish();
  }

  /** 提示符：显示短模型名，busy 时保持原值（busy 期间不 prompt） */
  function buildPrompt(): string {
    const id = model.aiModel.id;
    return chalk.blue(`${chalk.dim('aipack')} ${chalk.cyan(id)}${chalk.blue('>')} `);
  }

  // ── readline 生命周期（确认期间销毁重建，避免与 select 抢占 stdin）──

  let rl!: readline.Interface;
  /** rl.close() 来自"确认前接管"而非退出 */
  let recreating = false;

  function setupRl(): void {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: buildPrompt(),
    });

    rl.on('SIGINT', () => {
      if (busy) {
        console.log(chalk.yellow('\n中断当前运行...'));
        runtime.abort(activeKey);
        return;
      }
      // 续行中：第一次 Ctrl+C 取消续行而非退出
      if (pendingMultiline.length > 0) {
        pendingMultiline = [];
        rl.setPrompt(buildPrompt());
        console.log(chalk.dim('（已取消多行输入）'));
        rl.prompt();
        return;
      }
      sigintCount++;
      if (sigintCount >= 2) {
        console.log(chalk.dim('\n再见'));
        rl.close();
      } else {
        console.log(chalk.dim('（再按一次 Ctrl+C 退出）'));
        rl.prompt();
        setTimeout(() => { sigintCount = 0; }, 1500);
      }
    });

    rl.on('close', () => {
      if (!recreating) cleanup();
    });

    rl.on('line', onLine);
    rl.prompt();
  }

  // ── 请求执行 ──
  /** 会话内累计 token（跨多次 send） */
  let usageTotal = { input: 0, output: 0 };

  async function send(text: string): Promise<void> {
    if (!text.trim()) return;
    busy = true;
    sigintCount = 0;
    renderer.reset();

    const request: Request = {
      message: text,
      type: 'message',
      channel: 'cli',
      sessionKey: activeKey,
      ephemeral: args.noSession,
    };

    let turnUsage = { input: 0, output: 0 };
    let toolsUsed: string[] = [];

    try {
      for await (const chunk of runtime.stream(request) as AsyncGenerator<ResultChunk>) {
        renderer.render(chunk);
        if (chunk.type === 'done' && chunk.result?.usage) {
          const u = chunk.result.usage as { input?: number; output?: number };
          turnUsage.input = u.input ?? 0;
          turnUsage.output = u.output ?? 0;
          usageTotal.input += turnUsage.input;
          usageTotal.output += turnUsage.output;
          toolsUsed = chunk.result.toolsUsed ?? [];
        }
      }
      printTurnStats(turnUsage, toolsUsed);
    } catch (err) {
      console.log(chalk.red(`错误: ${err instanceof Error ? err.message : String(err)}`));
    } finally {
      busy = false;
      rl.prompt();
    }
  }

  /** 回合统计行：本轮 token + 工具数 + 会话累计 */
  function printTurnStats(
    turn: { input: number; output: number },
    tools: string[],
  ): void {
    const parts: string[] = [];
    if (turn.input > 0 || turn.output > 0) {
      parts.push(
        chalk.dim(`本轮 ↑${turn.input.toLocaleString()} ↓${turn.output.toLocaleString()}`),
      );
      parts.push(
        chalk.dim(
          `累计 ↑${usageTotal.input.toLocaleString()} ↓${usageTotal.output.toLocaleString()}`,
        ),
      );
    }
    if (tools.length > 0) {
      parts.push(chalk.dim(`工具 ${tools.join(', ')}`));
    }
    if (parts.length > 0) {
      console.log(`  ${parts.join(chalk.dim('  ·  '))}`);
    }
  }

  // ── 斜杠命令 ──
  async function handleCommand(line: string): Promise<void> {
    const spaceIdx = line.indexOf(' ');
    const cmd = (spaceIdx === -1 ? line : line.slice(0, spaceIdx)).toLowerCase();
    const rest = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1).trim();

    switch (cmd) {
      case '/help':
        printSlashHelp();
        break;

      case '/quit':
      case '/exit':
        rl.close();
        return;

      case '/model': {
        if (!rest) {
          console.log(chalk.dim(`当前模型: ${model.aiModel.provider}/${model.aiModel.id}`));
          console.log(chalk.dim('用法: /model provider/model-id（如 /model deepseek/deepseek-chat）'));
          break;
        }
        const slash = rest.indexOf('/');
        const provider = slash === -1 ? model.aiModel.provider : rest.slice(0, slash);
        const id = slash === -1 ? rest : rest.slice(slash + 1);
        const found = getBuiltinModels(provider).find(m => m.id === id);
        if (!found) {
          console.log(chalk.yellow(`未找到内置模型 ${provider}/${id}，可用:`));
          console.log(getBuiltinModels(provider).map(m => `  ${m.id}`).join('\n') || '  (无)');
          break;
        }
        runtime.setModel(adaptAiModel(found));
        model.aiModel = found;
        model.custom = false;
        console.log(chalk.green(`已切换到 ${provider}/${id}`));
        break;
      }

      case '/thinking': {
        if (!VALID_THINKING.has(rest)) {
          console.log(chalk.dim('用法: /thinking <off|minimal|low|medium|high|max>'));
          break;
        }
        runtime.setThinkingLevel(rest as ThinkingLevel);
        console.log(chalk.green(`思考级别: ${rest}`));
        break;
      }

      case '/system': {
        if (!rest) {
          console.log(chalk.dim('用法: /system <新的系统提示词>'));
          break;
        }
        runtime.setSystemPrompt(rest);
        console.log(chalk.green('系统提示词已更新'));
        break;
      }

      case '/session':
        console.log(`会话 key: ${chalk.cyan(activeKey)}`);
        console.log(`消息数: ${runtime.getMessages(activeKey).length}`);
        console.log(`持久化: ${args.noSession ? chalk.yellow('否（--no-session）') : chalk.green(storage ? '是' : '否（无存储）')}`);
        break;

      case '/sessions': {
        if (!storage) {
          console.log(chalk.yellow('当前为临时会话，无持久化存储'));
          break;
        }
        const sessions = await listSessionsByRecency(storage);
        if (sessions.length === 0) {
          console.log(chalk.dim('（无历史会话）'));
          break;
        }
        console.log(sessions.slice(0, 10).map((s, i) => `${s === activeKey ? chalk.green('▸ ') : '  '}${i + 1}. ${s}`).join('\n'));
        console.log(chalk.dim('切换: 退出后用 aipack --session <key> 恢复'));
        break;
      }

      case '/clear':
        runtime.clearSession(activeKey);
        usageTotal = { input: 0, output: 0 };
        console.log(chalk.green('会话已清空（仅内存）'));
        break;

      case '/compact': {
        console.log(chalk.dim('压缩会话历史...'));
        const mode = await runtime.compact(activeKey);
        if (mode === null) {
          console.log(chalk.yellow('无可压缩内容（消息过少或压缩已通过 --no-compaction 关闭）'));
        } else {
          console.log(chalk.green(`已完成${mode === 'summary' ? '摘要压缩' : '截断压缩'}，消息数: ${runtime.getMessages(activeKey).length}`));
        }
        break;
      }

      case '/tools':
        console.log(chalk.dim('内置工具: read, write, edit, bash, find, grep, ls'));
        console.log(chalk.dim('通过 --tools / --exclude-tools / --no-tools 配置启停'));
        break;

      case '/mcp': {
        if (!mcp) {
          console.log(chalk.yellow('未配置 MCP server（在 .mcp.json / ~/.aipack/mcp.json 中配置）'));
          break;
        }
        if (rest === 'refresh') {
          console.log(chalk.dim('刷新 MCP 工具列表...'));
          const diags = await mcp.refresh();
          if (diags.length > 0) {
            for (const d of diags) console.log(`  ${chalk[d.type === 'error' ? 'red' : d.type === 'warning' ? 'yellow' : 'cyan'](d.type)} [${d.server}] ${d.message}`);
          }
          console.log(chalk.green('刷新完成'));
          break;
        }
        const statuses = mcp.registry.getStatus();
        if (statuses.length === 0) {
          console.log(chalk.dim('（无 MCP server）'));
          break;
        }
        for (const s of statuses) {
          const flag = s.connected ? chalk.green('●') : chalk.red('○');
          const err = s.error ? chalk.red(`  ${s.error}`) : '';
          console.log(`${flag} ${chalk.cyan(s.name)}  ${s.transport}  ${s.toolCount} 工具${err}`);
        }
        const diags = mcp.diagnostics;
        if (diags.length > 0) {
          console.log(chalk.dim('诊断:'));
          for (const d of diags) console.log(`  ${d.type} [${d.server}] ${d.message}`);
        }
        break;
      }

      case '/approvals': {
        if (!approvalManager) {
          console.log(chalk.yellow('审批未启用（在 aipack.config.js 中配置 approvals.enabled: true）'));
          break;
        }
        const pending = approvalManager.list();
        if (pending.length === 0) {
          console.log(chalk.dim('（无未决审批）'));
          break;
        }
        for (const p of pending) {
          console.log(`${chalk.cyan(p.id)}  ${p.request.toolName}  ${chalk.dim(new Date(p.createdAt).toLocaleString())}${p.restored ? chalk.yellow(' (孤儿)') : ''}`);
        }
        break;
      }

      case '/approve':
      case '/deny': {
        if (!approvalManager) {
          console.log(chalk.yellow('审批未启用'));
          break;
        }
        if (!rest) {
          console.log(chalk.dim(`用法: ${cmd} <审批单 id>`));
          break;
        }
        const ok = approvalManager.resolve(rest, cmd === '/approve');
        console.log(ok ? chalk.green('已生效') : chalk.yellow('审批单不存在或已结算'));
        break;
      }

      default:
        console.log(chalk.yellow(`未知命令: ${cmd}（/help 查看全部）`));
    }
  }

  function printSlashHelp(): void {
    console.log(`${chalk.bold.magenta('斜杠命令:')}
  ${chalk.green('/model [provider/id]')}      切换模型（无参显示当前）
  ${chalk.green('/thinking <级别>')}         ${chalk.dim('off/minimal/low/medium/high/max')}
  ${chalk.green('/system <文本>')}           替换系统提示词
  ${chalk.green('/session')}                  当前会话信息
  ${chalk.green('/sessions')}                 列出历史会话
  ${chalk.green('/clear')}                    清空当前会话（仅内存）
  ${chalk.green('/compact')}                  手动压缩会话历史（释放上下文空间）
  ${chalk.green('/tools')}                    查看工具集与权限配置
  ${chalk.green('/mcp [refresh]')}            MCP server 状态 / 热刷新工具列表
  ${chalk.green('/approvals')}                未决审批单
  ${chalk.green('/approve <id>')}             批准
  ${chalk.green('/deny <id>')}                驳回
  ${chalk.green('/quit')}                     退出（Ctrl+C 双击）

${chalk.dim('输入提示:')}
  ${chalk.dim('· 普通文本直接发送；行尾以')} ${chalk.yellow('\\')} ${chalk.dim('续行，空行提交多行')}
  ${chalk.dim('·')} ${chalk.yellow('@文件')} ${chalk.dim('可附加文件上下文（图片自动走多模态）')}`);
  }

  // ── 行输入分发 ──
  async function onLine(line: string): Promise<void> {
    const text = line.trim();
    if (!text) {
      // 空行：若有续行缓存则提交，否则仅重置提示
      if (pendingMultiline.length > 0) {
        const joined = pendingMultiline.join('\n');
        pendingMultiline = [];
        await send(joined);
      } else {
        rl.prompt();
      }
      return;
    }
    // 续行：以 \ 结尾（且非斜杠命令）→ 累加并切换续行提示
    if (!text.startsWith('/') && text.endsWith('\\') && !text.endsWith('\\\\')) {
      pendingMultiline.push(text.slice(0, -1));
      rl.setPrompt(chalk.dim('… '));
      rl.prompt();
      return;
    }
    // 合并续行 + 当前行为完整输入
    const full = pendingMultiline.length > 0
      ? [...pendingMultiline, text].join('\n')
      : text;
    pendingMultiline = [];
    // 恢复主提示符（续行后）
    rl.setPrompt(buildPrompt());

    if (busy) {
      console.log(chalk.dim('（运行中，输入被忽略；Ctrl+C 中断）'));
      rl.prompt();
      return;
    }
    if (full.startsWith('/')) {
      await handleCommand(full);
      rl.prompt();
      return;
    }
    await send(full);
  }

  // ── 权限确认：关 rl → select 接管 → 重建 rl ──
  if (opts.confirmRef) {
    opts.confirmRef.fn = async (req: PermissionRequest): Promise<boolean> => {
      recreating = true;
      rl.close();
      try {
        return await opts.baseConfirm(req);
      } finally {
        recreating = false;
        setupRl();
      }
    };
  }

  // ── 启动横幅 ──
  printStartupBanner({
    sessionKey: activeKey,
    ephemeral: args.noSession,
    modelLabel: `${model.aiModel.provider}/${model.aiModel.id}`,
    customModel: model.custom,
  });

  setupRl();

  // ── 初始消息 ──
  if (opts.initialMessages && opts.initialMessages.length > 0) {
    await send(opts.initialMessages.join('\n'));
  }

  // 保持存活直至用户退出（rl close → cleanup → resolve）
  await finished;
}

/** --resume 的会话选择器 */
export async function pickSessionInteractively(
  storage: SessionStorage,
  currentKey: string,
): Promise<string | undefined> {
  const sessions = await listSessionsByRecency(storage);
  if (sessions.length === 0) {
    console.log(chalk.dim('（无历史会话，将新建）'));
    return undefined;
  }
  console.log(chalk.bold('选择会话:'));
  sessions.slice(0, 15).forEach((s, i) => {
    console.log(`${s === currentKey ? chalk.green('▸ ') : '  '}${i + 1}. ${s}`);
  });
  console.log(chalk.dim('  n. 新会话'));
  const answer = await ask('编号: ');
  if (answer === '' || answer.toLowerCase() === 'n') return undefined;
  const idx = Number.parseInt(answer, 10);
  if (Number.isInteger(idx) && idx >= 1 && idx <= Math.min(sessions.length, 15)) {
    return sessions[idx - 1];
  }
  return undefined;
}
