/**
 * AgentService —— 包装 agentpack-coding 的 createCodingAgent。
 *
 * 职责：
 * 1. 懒初始化：首次 getAgent() 才真正 createCodingAgent（避免无 API Key 时启动报错）
 * 2. 从 VSCode settings 读取 provider/model/apiKey，syncApiKeysToEnv 后交给 createCodingAgent
 * 3. workspace 取 workspaceFolders[0]；sessionDir 落 globalStorage/sessions
 * 4. confirmFn 接 QuickPick；memory 按 settings 启用
 * 5. invalidate()：配置变更时重建 agent，保留 allowedAlways 集合
 *
 * 面板层通过 streamRun/stop/clearHistory/getHistory 驱动 agent，sessionKey 由面板持有。
 */

import * as vscode from 'vscode';
import path from 'path';
import fs from 'fs';
import { createCodingAgent } from 'agentpack-coding';
import type { CodingAgent } from 'agentpack-coding';
import { createRequest } from 'agentpack';
import type { Message, ResultChunk } from 'agentpack';
import { createQuickPickConfirmFn } from './confirm';
import { loadConfigAndSyncEnv } from './config';

export class AgentService {
  private agent: CodingAgent | undefined;
  private preservedAllowedAlways: string[] = [];
  private disposed = false;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  /** 获取或懒初始化 agent */
  async getAgent(): Promise<CodingAgent> {
    if (this.agent) return this.agent;
    console.log('[agentpack] getAgent: creating...');

    const { config: cfg } = loadConfigAndSyncEnv();

    // 1. workspace 根：取第一个 workspaceFolder
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('未打开工作区文件夹，无法启动 Agentpack Coding agent。');
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

    this.agent = await createCodingAgent({
      provider: cfg.provider,
      model: cfg.model || undefined,
      workspace,
      sessionDir,
      permission: {
        confirmFn,
        allowedAlways: new Set(this.preservedAllowedAlways),
      },
      memory,
      enabledTools: cfg.enabledTools.length > 0 ? cfg.enabledTools : undefined,
    });
    console.log('[agentpack] getAgent: created');

    return this.agent;
  }

  /** 流式运行；面板订阅返回的 AsyncGenerator 做增量渲染 */
  async *streamRun(message: string, sessionKey: string): AsyncGenerator<ResultChunk> {
    const agent = await this.getAgent();
    yield* agent.runtime.stream(createRequest(message, { sessionKey }));
  }

  /** 停止指定会话的运行（agent 未初始化时 no-op，避免触发创建） */
  async stop(sessionKey: string): Promise<void> {
    if (!this.agent) return;
    this.agent.runtime.abort(sessionKey);
  }

  /** 清空指定会话的内存消息历史（agent 未初始化时 no-op） */
  async clearHistory(sessionKey: string): Promise<void> {
    if (!this.agent) return;
    this.agent.runtime.clearSession(sessionKey);
  }

  /** 取指定会话的已有消息列表（agent 未初始化时返回空，避免 ready 阶段触发创建卡住） */
  async getHistory(sessionKey: string): Promise<Message[]> {
    if (!this.agent) return [];
    return this.agent.runtime.getMessages(sessionKey);
  }

  /**
   * 配置变更时重建 agent：保留 allowedAlways 集合，下次 getAgent 重建时传入。
   * 不阻塞调用方：旧 agent 异步关闭。
   */
  invalidate(): void {
    if (!this.agent) return;
    const allowed = this.agent.permission.getAllowedAlways();
    this.preservedAllowedAlways = allowed;
    const old = this.agent;
    this.agent = undefined;
    void old.close().catch(() => {
      // 忽略关闭错误
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.agent?.close().catch(() => {
      // 忽略关闭错误
    });
    this.agent = undefined;
  }
}
