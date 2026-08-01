import type { Kobot } from '../kobot';
import { CLIChannel } from '../channels/cli';
import { FeishuChannel } from '../channels/feishu';
import type { Channel } from '../channels/types';
import { logger } from '../utils/logger';

/**
 * 统一管理所有通道的启动与停止。
 * 从 cli.ts 的 startBot() 中提取，使通道编排逻辑可复用。
 */
export class ChannelManager {
  private channels: Channel[] = [];

  /** 根据环境变量/配置启动所有已启用的通道 */
  async startAll(bot: Kobot): Promise<void> {
    // 飞书通道
    const feishuAppId = process.env.FEISHU_APP_ID;
    const feishuAppSecret = process.env.FEISHU_APP_SECRET;
    if (feishuAppId && feishuAppSecret) {
      const feishu = new FeishuChannel({
        id: 'feishu',
        name: 'Feishu',
        enabled: true,
        appId: feishuAppId,
        appSecret: feishuAppSecret,
        port: parseInt(process.env.FEISHU_PORT || '3000', 10),
        path: process.env.FEISHU_PATH || '/webhook/event',
      });
      await feishu.start(bot);
      this.channels.push(feishu);
      logger.info({ port: process.env.FEISHU_PORT }, '飞书通道已启动');
    }

    // CLI 通道（始终启动，作为最后启动的主通道）
    const cli = new CLIChannel({
      id: 'cli',
      name: 'CLI',
      enabled: true,
      historySize: 100,
      prompt: 'kobot> ',
    });
    await cli.start(bot);
    this.channels.push(cli);
  }

  async stopAll(): Promise<void> {
    for (const ch of this.channels) {
      await ch.stop().catch((err) =>
        logger.error({ err, channel: ch.id }, '通道停止失败'),
      );
    }
    this.channels = [];
  }
}
