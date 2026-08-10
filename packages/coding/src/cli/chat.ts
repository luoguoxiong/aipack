/**
 * CLI 交互式 REPL。
 *
 * 参考 aipack-cli/src/chat.ts 的串行队列 + stream 事件消费模式。
 * 额外注入 confirmFn（TTY 交互确认，非 TTY 直接拒绝），
 * 并支持 /tools / /permission 命令。
 */

import readline from 'readline';
import path from 'path';
import { createRequest } from '@aipack/agent';
import type { AssistantMessage } from '@aipack/agent';
import { createCodingAgent } from '../factory';
import type { CodingAgent } from '../types';
import type { ConfirmContext, ConfirmResult } from '../permission';

export interface ChatOptions {
  provider?: string;
  model?: string;
  workspace?: string;
  sessionDir?: string;
  memory?: boolean;
}

/** 消费 runtime.stream 事件，打印文本/思考/工具执行进度。供 chat 与 run 复用。 */
export async function handleMessage(
  agent: CodingAgent,
  message: string,
): Promise<void> {
  let thinkingActive = false;
  let wroteAnything = false;

  try {
    for await (const chunk of agent.runtime.stream(
      createRequest(message, { channel: 'cli' }),
    )) {
      if (chunk.type !== 'done') wroteAnything = true;

      switch (chunk.type) {
        case 'thinking':
          if (chunk.content) {
            if (!thinkingActive) {
              thinkingActive = true;
              process.stdout.write('\x1b[90mthink: ');
            }
            process.stdout.write(chunk.content);
          }
          break;
        case 'text':
          if (thinkingActive) {
            thinkingActive = false;
            process.stdout.write('\x1b[0m\n');
          }
          process.stdout.write(chunk.content ?? '');
          break;
        case 'tool_start':
          if (thinkingActive) {
            thinkingActive = false;
            process.stdout.write('\x1b[0m\n');
          }
          console.log(`\n🔧 正在运行：${chunk.toolName}`);
          break;
        case 'tool_end':
          if (chunk.isError) console.log(`\n❌ ${chunk.toolName} 失败`);
          else console.log(`\n✅ ${chunk.toolName} 完成`);
          break;
        case 'error':
          console.log(`\n❌ 错误：${chunk.content || '未知错误'}`);
          break;
        case 'done':
          if (thinkingActive) {
            thinkingActive = false;
            process.stdout.write('\x1b[0m\n');
          }
          break;
      }
    }

    if (thinkingActive) process.stdout.write('\x1b[0m\n');

    // LLM 层错误（如 API Key 无效）从最后一条 assistant 消息兜底捕获
    const messages = agent.runtime.getMessages();
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant' && (last as AssistantMessage).errorMessage) {
      wroteAnything = true;
      console.log(`\n❌ 错误：${(last as AssistantMessage).errorMessage}`);
    }

    if (!wroteAnything) console.log('\n（未收到响应）');
    else process.stdout.write('\n');
  } catch (err) {
    console.error(`\n❌ 意外错误：${(err as Error).message}`);
  }
}

function isExit(trimmed: string): boolean {
  return (
    trimmed === 'exit' ||
    trimmed === 'quit' ||
    trimmed === '/exit' ||
    trimmed === '/quit'
  );
}

function showHelp(): void {
  console.log('\n可用命令：');
  console.log('  /help        显示此帮助');
  console.log('  /clear       清空当前会话上下文');
  console.log('  /tools       列出已启用的工具');
  console.log('  /permission  查看 allow-always 命令集合');
  console.log('  /model       显示当前模型');
  console.log('  /exit        退出（也可输入 exit / quit）');
  console.log('  其他输入     发送给 coding agent');
  console.log('');
}

function showTools(agent: CodingAgent): void {
  console.log(`\n已启用 ${agent.tools.length} 个工具：`);
  for (const t of agent.tools) console.log(`  - ${t.name}`);
  console.log('');
}

function showPermission(agent: CodingAgent): void {
  const allowed = agent.permission.getAllowedAlways();
  console.log('\nallow-always 命令集合：');
  if (allowed.length === 0) console.log('  （空）');
  else for (const c of allowed) console.log(`  - ${c}`);
  console.log('');
}

async function stop(agent: CodingAgent): Promise<void> {
  await agent.close();
  console.log('\n再见！');
  process.exit(0);
}

export async function startChat(opts: ChatOptions): Promise<void> {
  const workspace = opts.workspace ?? process.cwd();
  const isTTY = !!process.stdin.isTTY;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: isTTY,
  });
  rl.setPrompt('coding> ');

  // confirmFn：TTY 交互确认，非 TTY 直接拒绝
  const confirmFn = async (ctx: ConfirmContext): Promise<ConfirmResult> => {
    if (!isTTY) return false;
    return new Promise((resolve) => {
      rl.question(`允许执行 "${ctx.command}" 吗？[y/N/a=允许所有] `, (ans) => {
        const a = ans.trim().toLowerCase();
        if (a === 'a' || a === 'always') resolve('allow-always');
        else resolve(a === 'y' || a === 'yes');
      });
    });
  };

  console.log('初始化 coding agent...');
  const sessionKey = `coding-${Date.now().toString(36)}`;
  const agent = await createCodingAgent({
    provider: opts.provider,
    model: opts.model,
    workspace,
    sessionKey,
    sessionDir: opts.sessionDir ?? path.join(workspace, '.aipack', 'sessions'),
    memory: opts.memory,
    permission: { confirmFn },
  });

  if (isTTY) {
    console.log(`会话: ${sessionKey}`);
    console.log(`workspace: ${workspace}`);
    console.log('输入 /help 查看命令，/exit 退出');
    console.log('---');
    rl.prompt();
  }

  // 串行队列：readline 的 line 事件会在上一行异步未完成时并发触发，需保证顺序
  let queue: Promise<void> = Promise.resolve();
  let closed = false;
  const prompt = (): void => {
    if (isTTY && !closed) rl.prompt();
  };

  rl.on('line', (input) => {
    queue = queue.then(() => processLine(input)).catch(() => {});
  });
  rl.on('close', () => {
    closed = true;
    queue = queue.then(() => stop(agent));
  });

  async function processLine(input: string): Promise<void> {
    const trimmed = input.trim();
    if (!trimmed) {
      prompt();
      return;
    }

    if (isExit(trimmed)) {
      await stop(agent);
      return;
    }
    if (trimmed === '/help' || trimmed === 'help') {
      showHelp();
      prompt();
      return;
    }
    if (trimmed === '/clear') {
      agent.runtime.clearSession();
      console.log('已清空当前会话上下文');
      prompt();
      return;
    }
    if (trimmed === '/tools') {
      showTools(agent);
      prompt();
      return;
    }
    if (trimmed === '/permission') {
      showPermission(agent);
      prompt();
      return;
    }
    if (trimmed === '/model') {
      console.log(`模型: ${agent.model.provider} / ${agent.model.id}`);
      prompt();
      return;
    }

    await handleMessage(agent, input);
    prompt();
  }
}
