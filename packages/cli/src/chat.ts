/**
 * packages/cli/src/chat.ts
 *
 * 交互式聊天（readline REPL）。
 * 支持 /help /clear /sessions /model /exit，以及多行续行输入。
 */

import readline from 'readline';
import { createRequest } from '@aipack-ai/agent';
import type { AssistantMessage, Runtime } from '@aipack-ai/agent';
import type { AipackConfig } from './config';
import { listSessions } from './sessions';

export async function startChat(
  runtime: Runtime,
  config: AipackConfig,
  modelLabel?: string,
): Promise<void> {
  const isTTY = !!process.stdin.isTTY;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: isTTY,
  });
  rl.setPrompt('aipack> ');

  const model = modelLabel ?? `${config.provider}/${config.model}`;
  let pending = ''; // 续行缓冲

  if (isTTY) {
    console.log('');
    console.log(`会话: ${config.sessionKey}  模型: ${model}`);
    console.log('输入 /help 查看命令，/exit 退出');
    console.log('---');
    rl.prompt();
  }

  // 串行处理每一行：readline 的 'line' 事件会在上一行异步处理未完成时
  // 并发触发下一行，必须用 promise 链保证顺序（否则 /exit 会打断进行中的流）
  let queue: Promise<void> = Promise.resolve();
  let closed = false;
  const prompt = (): void => {
    if (isTTY && !closed) rl.prompt();
  };

  rl.on('line', (input) => {
    queue = queue.then(() => processLine(input)).catch(() => {});
  });

  // close（EOF / Ctrl+D）也要排队：若流仍在进行，先等它完成再退出
  rl.on('close', () => {
    closed = true;
    queue = queue.then(() => stop(runtime));
  });

  async function processLine(input: string): Promise<void> {
    // 续行模式：拼接多行输入
    if (pending) {
      pending += '\n' + input;
      if (needsContinuation(pending) && isTTY) {
        prompt();
        return;
      }
      input = pending;
      pending = '';
      rl.setPrompt('aipack> ');
    }

    const trimmed = input.trim();

    if (!trimmed) {
      prompt();
      return;
    }

    if (isExit(trimmed)) {
      await stop(runtime);
      return;
    }
    if (trimmed === 'help' || trimmed === '/help') {
      showHelp();
      prompt();
      return;
    }
    if (trimmed === '/clear') {
      runtime.clearSession(config.sessionKey);
      console.log('已清空当前会话上下文');
      prompt();
      return;
    }
    if (trimmed === '/sessions') {
      await showSessions(config);
      prompt();
      return;
    }
    if (trimmed === '/model') {
      console.log(`当前模型: ${model}`);
      prompt();
      return;
    }

    // 多行续行（仅 TTY 下启用，避免管道输入被阻塞）
    if (needsContinuation(trimmed) && isTTY) {
      pending = trimmed;
      rl.setPrompt('...> ');
      prompt();
      return;
    }

    await handleMessage(runtime, config, input);
    prompt();
  }
}

// ─── 命令处理 ──────────────────────────────────────────────────────

function isExit(trimmed: string): boolean {
  return (
    trimmed === 'exit' ||
    trimmed === 'quit' ||
    trimmed === '/exit' ||
    trimmed === '/quit'
  );
}

function needsContinuation(text: string): boolean {
  if (text.endsWith('\\')) return true;
  const open = (text.match(/[{([]/g) || []).length;
  const close = (text.match(/[})\]]/g) || []).length;
  return open > close;
}

async function handleMessage(
  runtime: Runtime,
  config: AipackConfig,
  message: string,
): Promise<void> {
  let thinkingActive = false;
  let wroteAnything = false;

  try {
    for await (const chunk of runtime.stream(
      createRequest(message, { channel: 'cli', sessionKey: config.sessionKey }),
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
          console.log('\n❌ 发生错误：');
          console.log(`   ${chunk.content || '未知错误'}`);
          console.log('');
          console.log('💡 故障排除提示：');
          console.log('   1. 检查 API Key 配置（如 DEEPSEEK_API_KEY / OPENAI_API_KEY）');
          console.log('   2. 验证网络连接');
          console.log('   3. 查看 .env 配置（~/.aipack/.env / <cwd>/.env）');
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

    // LLM 层错误（如 API Key 无效）不会以 chunk 形式抛出，
    // 从最后一条 assistant 消息的 errorMessage 兜底捕获
    const messages = runtime.getMessages(config.sessionKey);
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant' && (last as AssistantMessage).errorMessage) {
      wroteAnything = true;
      console.log(`\n❌ 错误：${(last as AssistantMessage).errorMessage}`);
    }

    if (!wroteAnything) {
      console.log('\n（未收到响应）');
    } else {
      process.stdout.write('\n');
    }
  } catch (err) {
    console.error('\n❌ 意外错误：');
    console.error(`   ${(err as Error).message}`);
  }
}

async function showSessions(config: AipackConfig): Promise<void> {
  const sessions = await listSessions(config);
  console.log('\n已持久化的会话：');
  if (sessions.length === 0) {
    console.log('  （无）');
  } else {
    for (const s of sessions) console.log(`  - ${s}`);
  }
  console.log('');
}

function showHelp(): void {
  console.log('\n可用命令：');
  console.log('  /help        - 显示此帮助信息');
  console.log('  /clear       - 清空当前会话上下文');
  console.log('  /sessions    - 列出已持久化的会话');
  console.log('  /model       - 显示当前模型');
  console.log('  /exit        - 退出（也可输入 exit / quit）');
  console.log('  其他输入     - 发送给 AI');
  console.log('  以 \\ 结尾或括号未闭合时支持多行输入');
  console.log('');
}

async function stop(runtime: Runtime): Promise<void> {
  await runtime.close();
  console.log('\n再见！');
  process.exit(0);
}
