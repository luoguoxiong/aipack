/**
 * AgentService —— 包装 aipack-coding 的 createCodingAgent。
 *
 * 职责：
 * 1. 懒初始化：首次 getAgent(sessionKey) 才真正 createCodingAgent（避免无 API Key 时启动报错）
 * 2. 从 VSCode settings 读取 provider/model/apiKey，syncApiKeysToEnv 后交给 createCodingAgent
 * 3. workspace 取 workspaceFolders[0]；sessionDir 落 globalStorage/sessions
 * 4. confirmFn 接 QuickPick；memory 按 settings 启用
 * 5. 多会话：每个 sessionKey 对应独立 CodingAgent 实例（单会话架构）
 * 6. invalidate()：配置变更时重建所有 agent，保留 allowedAlways 集合
 *
 * 面板层通过 streamRun/stop/clearHistory/getHistory 驱动 agent，sessionKey 由面板持有。
 */

import * as vscode from 'vscode';
import path from 'path';
import fs from 'fs';
import { createCodingAgent } from '@aipack/coding';
import type { CodingAgent } from '@aipack/coding';
import { createRequest } from '@aipack/agent';
import type { Message, ResultChunk } from '@aipack/agent';
import { createQuickPickConfirmFn } from './confirm';
import { loadConfigAndSyncEnv } from './config';

export class AgentService {
  private agents = new Map<string, CodingAgent>();
  private preservedAllowedAlways: string[] = [];
  private disposed = false;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  /** 获取或懒初始化指定 sessionKey 的 agent */
  async getAgent(sessionKey: string): Promise<CodingAgent> {
    const existing = this.agents.get(sessionKey);
    if (existing) return existing;
    console.log(`[aipack] getAgent: creating for session ${sessionKey}...`);

    const { config: cfg } = loadConfigAndSyncEnv();

    // 1. workspace 根：取第一个 workspaceFolder
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('未打开工作区文件夹，无法启动 Aipack Coding agent。');
    }
    const workspace = folder.uri.fsPath;

    // 2. apiKey 已由 loadConfigAndSyncEnv 同步到 process.env（复用 getEnvApiKey 兜底）

    // 3. sessionDir：默认走扩展 globalStorage/sessions
    const sessionDir = cfg.sessionDir || path.join(this.ctx.globalStorageUri.fsPath, 'sessions');
    await fs.promises.mkdir(sessionDir, { recursive: true });

    // 4. confirmFn：QuickPick 三选项；保留上次 invalidate 前的 allowedAlways
    const confirmFn = createQuickPickConfirmFn();

    // 5. memory：按 settings 启用
    const memory = cfg.memory.enabled
      ? cfg.memory.baseDir
        ? { baseDir: cfg.memory.baseDir }
        : true
      : false;

    const agent = await createCodingAgent({
      provider: cfg.provider,
      model: cfg.model || undefined,
      workspace,
      sessionDir,
      sessionKey,
      permission: {
        confirmFn,
        allowedAlways: new Set(this.preservedAllowedAlways),
      },
      memory,
      enabledTools: cfg.enabledTools.length > 0 ? cfg.enabledTools : undefined,
    });
    console.log(`[aipack] getAgent: created for session ${sessionKey}`);
    this.agents.set(sessionKey, agent);

    return agent;
  }

  /** 流式运行；面板订阅返回的 AsyncGenerator 做增量渲染 */
  async *streamRun(message: string, sessionKey: string): AsyncGenerator<ResultChunk> {
    const agent = await this.getAgent(sessionKey);
    yield* agent.runtime.stream(createRequest(message, { sessionKey }));
  }

  /** 停止指定会话的运行（agent 未初始化时 no-op，避免触发创建） */
  async stop(sessionKey: string): Promise<void> {
    this.agents.get(sessionKey)?.runtime.abort(sessionKey);
  }

  /** 清空指定会话的内存消息历史（agent 未初始化时 no-op） */
  async clearHistory(sessionKey: string): Promise<void> {
    this.agents.get(sessionKey)?.runtime.clearSession(sessionKey);
  }

  /** 取指定会话的已有消息列表（agent 未初始化时返回空，避免 ready 阶段触发创建卡住） */
  async getHistory(sessionKey: string): Promise<Message[]> {
    const agent = this.agents.get(sessionKey);
    if (!agent) return [];
    return agent.runtime.getMessages(sessionKey);
  }

  /**
   * 配置变更时重建所有 agent：保留 allowedAlways 集合，下次 getAgent 重建时传入。
   * 不阻塞调用方：旧 agent 异步关闭。
   */
  invalidate(): void {
    if (this.agents.size === 0) return;
    const first = this.agents.values().next().value;
    if (first) {
      const allowed = first.permission.getAllowedAlways();
      this.preservedAllowedAlways = allowed;
    }
    const oldAgents = [...this.agents.values()];
    this.agents.clear();
    for (const old of oldAgents) {
      void old.close().catch(() => {
        // 忽略关闭错误
      });
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const all = [...this.agents.values()];
    this.agents.clear();
    await Promise.allSettled(all.map((a) => a.close()));
  }
}
