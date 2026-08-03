/**
 * CLI 一次性执行：agentpack-coding run "你的需求"。
 *
 * 非 TTY 场景：无 confirmFn，confirm 类命令直接 deny。
 */

import { createCodingAgent } from '../factory';
import { handleMessage } from './chat';

export interface RunOptions {
  message: string;
  provider?: string;
  model?: string;
  workspace?: string;
}

export async function runOnce(opts: RunOptions): Promise<void> {
  const agent = await createCodingAgent({
    provider: opts.provider,
    model: opts.model,
    workspace: opts.workspace ?? process.cwd(),
    // 非 TTY：不提供 confirmFn，confirm 类命令将被拒绝
  });

  const sessionKey = `coding-run-${Date.now().toString(36)}`;
  try {
    await handleMessage(agent, sessionKey, opts.message);
  } finally {
    await agent.close();
  }
}
