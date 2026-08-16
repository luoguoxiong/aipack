/**
 * 终端交互辅助：问题 / 确认
 */
import readline from 'node:readline';

export function ask(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** y/N 确认；非 TTY 环境直接拒绝（保守） */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const answer = await ask(`${question} [y/N] `);
  return answer === 'y' || answer === 'Y' || answer === 'yes';
}

/** 读取可读流全部内容（管道 stdin） */
export function readStreamAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    stream.setEncoding?.('utf8');
    stream.on('data', chunk => { data += chunk; });
    stream.on('end', () => resolve(data));
    stream.on('error', () => resolve(data));
  });
}
