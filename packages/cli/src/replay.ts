/**
 * packages/cli/src/replay.ts
 *
 * 会话回放：从文件存储加载历史会话，按顺序重放用户消息以复现问题。
 * 对齐 src/cli.ts 的 replay 语义，基于 aipack 的 StoredSession 格式。
 */

import { createFileSessionStorage, createRequest } from '@aipack/agent';
import type { Message, AiModel } from '@aipack/agent';
import type { AipackConfig } from './config';
import { createAipackRuntime } from './runtime';

export interface ReplayTurnResult {
  index: number;
  userMessage: string;
  response: string;
  error?: string;
}

export interface ReplayResult {
  sessionKey: string;
  userMessageCount: number;
  turns: ReplayTurnResult[];
  totalErrors: number;
  totalDurationMs: number;
}

export interface ReplayOptions {
  /**
   * 是否只回放对话（不执行任何工具）。默认 true —— 重放历史时若真实
   * 执行工具会触发真实副作用（写文件/执行命令等）。设为 false 才真实执行，
   * 用于需要复现工具调用链的场景。
   */
  dryRun?: boolean;
}

/** 从消息中提取文本内容（兼容 string 与 ContentBlock[] 两种形式） */
function messageToText(msg: Message): string {
  const content = (msg as { content?: string | Array<{ type?: string; text?: string }> }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c?.type === 'text')
      .map((c) => c.text || '')
      .join('\n');
  }
  return '';
}

export async function replaySession(
  sessionKey: string,
  config: AipackConfig,
  onProgress?: (current: number, total: number, message: string) => void,
  onTurnResult?: (
    current: number,
    total: number,
    turn: ReplayTurnResult,
  ) => void,
  model?: AiModel,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const dryRun = options.dryRun !== false;

  // 1. 加载历史会话
  const storage = createFileSessionStorage({ baseDir: config.sessions.baseDir });
  const stored = await storage.load(sessionKey);
  if (!stored) {
    throw new Error(
      `会话 "${sessionKey}" 未找到（存储目录：${config.sessions.baseDir}）`,
    );
  }

  // 2. 提取用户消息
  const userMessages = stored.messages
    .filter((m) => m.role === 'user')
    .map(messageToText)
    .filter((t) => t.length > 0);

  if (userMessages.length === 0) {
    throw new Error(`会话 "${sessionKey}" 中没有用户消息`);
  }

  // 3. 创建回放 Runtime，直接继续原会话（回放结果追加到原会话历史）
  //    P1: 默认 dry-run —— 禁用全部工具，避免重放触发真实副作用；
  //    仅当显式 dryRun:false 时才注入原配置的工具集。
  const runtime = createAipackRuntime(
    config,
    model,
    sessionKey,
    dryRun ? { tools: [] } : undefined,
  );
  const turns: ReplayTurnResult[] = [];
  let totalErrors = 0;
  const startTime = Date.now();

  try {
    // 4. 逐条回放用户消息
    for (let i = 0; i < userMessages.length; i++) {
      const userMsg = userMessages[i];
      let response = '';
      let error: string | undefined;

      onProgress?.(i + 1, userMessages.length, userMsg.slice(0, 120));

      try {
        const result = await runtime.run(
          createRequest(userMsg, { channel: 'cli' }),
        );
        response = result.content;
        if (!result.success && result.error) {
          error = result.error;
          totalErrors++;
        }
      } catch (err) {
        error = (err as Error).message;
        totalErrors++;
      }

      const turn: ReplayTurnResult = { index: i, userMessage: userMsg, response, error };
      turns.push(turn);
      onTurnResult?.(i + 1, userMessages.length, turn);
    }
  } finally {
    await runtime.close();
  }

  return {
    sessionKey,
    userMessageCount: userMessages.length,
    turns,
    totalErrors,
    totalDurationMs: Date.now() - startTime,
  };
}
