/**
 * packages/cli/src/sessions.ts
 *
 * 会话管理：list / delete / clear。
 * 基于 aipack 的 FileSessionStorage，目录按配置 sessions.baseDir 解析。
 */

import { createFileSessionStorage } from '@aipack-ai/agent';
import type { AipackConfig } from './config';

export async function listSessions(
  config: AipackConfig,
): Promise<string[]> {
  const storage = createFileSessionStorage({ baseDir: config.sessions.baseDir });
  return storage.list();
}

export async function deleteSession(
  config: AipackConfig,
  sessionKey: string,
): Promise<boolean> {
  const storage = createFileSessionStorage({ baseDir: config.sessions.baseDir });
  return storage.delete(sessionKey);
}

/** 清空全部会话，返回删除数量 */
export async function clearSessions(
  config: AipackConfig,
): Promise<number> {
  const storage = createFileSessionStorage({ baseDir: config.sessions.baseDir });
  const keys = await storage.list();
  let removed = 0;
  for (const key of keys) {
    if (await storage.delete(key)) removed++;
  }
  return removed;
}
