import { logger } from '../utils/logger.js';
import { MessageBus } from '../bus/queue.js';
import { BaseChannel, ChannelConfig, SendOptions } from './base.js';
import { exec } from 'child_process';

export interface SignalChannelConfig extends ChannelConfig {
  phone_number?: string;
  signal_cli_path?: string;
  dbus_mode?: boolean;
  admin_group_ids?: string[];
}

export class SignalChannel extends BaseChannel {
  name = 'signal';
  private processedMessageIds: Set<string> = new Set();
  private receiveProcess: unknown = null;
  private streamBuffers: Map<string, string> = new Map();

  protected get signalConfig(): SignalChannelConfig {
    return this.config as SignalChannelConfig;
  }

  constructor(bus: MessageBus, config: SignalChannelConfig) {
    super(bus, config);
    this.name = config.name || 'signal';
  }

  async start(): Promise<void> {
    if (this.running) return;

    if (!this.signalConfig.phone_number) {
      logger.warn('Signal phone_number not configured, channel disabled');
      return;
    }

    this.subscribeToOutbound();
    this.subscribeToStream();

    try {
      await this.startReceiving();
    } catch (err) {
      logger.error({ err }, 'Failed to start Signal receiver');
    }

    this.running = true;
    logger.info('Signal channel started');
  }

  private async startReceiving(): Promise<void> {
    try {
      const signalCliPath = this.signalConfig.signal_cli_path || 'signal-cli';
      const phoneNumber = this.signalConfig.phone_number;

      const command = this.signalConfig.dbus_mode
        ? `${signalCliPath} --dbus --account ${phoneNumber} daemon`
        : `${signalCliPath} -u ${phoneNumber} daemon`;

      const { spawn } = await import('child_process');
      const child = spawn(command, { shell: true });

      this.receiveProcess = child;

      child.stdout?.on('data', (data: Buffer) => {
        this.handleOutput(data.toString());
      });

      child.stderr?.on('data', (data: Buffer) => {
        logger.debug(`Signal stderr: ${data.toString().trim()}`);
      });

      child.on('close', (code: number) => {
        logger.warn(`Signal process exited with code ${code}`);
        if (this.running) {
          setTimeout(() => {
            if (this.running) {
              this.startReceiving().catch(err => {
                logger.error({ err }, 'Failed to restart Signal receiver');
              });
            }
          }, 5000);
        }
      });

      child.on('error', (err: Error) => {
        logger.error({ err }, 'Signal process error');
      });
    } catch (err) {
      logger.debug({ err }, 'signal-cli not available, install signal-cli for Signal channel');
    }
  }

  private handleOutput(output: string): void {
    const lines = output.split('\n').filter(line => line.trim());
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.envelope) {
          this.handleEnvelope(parsed.envelope);
        }
      } catch {
        // Not JSON, ignore
      }
    }
  }

  private handleEnvelope(envelope: Record<string, unknown>): void {
    try {
      const syncMessage = envelope.syncMessage as Record<string, unknown>;
      const dataMessage = (envelope.dataMessage || syncMessage?.sentMessage) as Record<string, unknown>;

      if (!dataMessage) return;

      const message = dataMessage.message as string || '';
      const timestamp = envelope.timestamp as number || Date.now();
      const source = envelope.source as string || (envelope.source as Record<string, unknown>)?.number as string || '';
      const sourceName = envelope.sourceName as string || source;
      const groupInfo = dataMessage.groupInfo as Record<string, unknown>;
      const groupId = groupInfo?.groupId as string;

      if (!message.trim()) return;

      const msgId = `${source}_${timestamp}`;
      if (this.processedMessageIds.has(msgId)) return;
      this.processedMessageIds.add(msgId);
      if (this.processedMessageIds.size > 1000) {
        const first = this.processedMessageIds.values().next().value;
        if (first) this.processedMessageIds.delete(first);
      }

      const chatId = groupId || source;
      const senderId = source;

      this.publishInbound({
        chat_id: chatId,
        sender_id: senderId,
        sender_name: sourceName,
        text: message,
        metadata: {
          message_id: msgId,
          timestamp,
          is_group: !!groupId,
        },
      });
    } catch (err) {
      logger.error({ err }, 'Error handling Signal envelope');
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    if (this.receiveProcess && typeof (this.receiveProcess as { kill?: (signal: string) => void }).kill === 'function') {
      try {
        (this.receiveProcess as { kill: (signal: string) => void }).kill('SIGTERM');
      } catch (err) {
        logger.debug({ err }, 'Error killing Signal process');
      }
    }

    this.receiveProcess = null;
    this.unsubscribeAll();
    this.running = false;
    logger.info('Signal channel stopped');
  }

  async send(chatId: string, text: string, options?: SendOptions): Promise<void> {
    try {
      const signalCliPath = this.signalConfig.signal_cli_path || 'signal-cli';
      const phoneNumber = this.signalConfig.phone_number;

      if (!phoneNumber) {
        throw new Error('Signal phone number not configured');
      }

      const isGroup = chatId.includes('group') || chatId.length > 20;
      const recipientArg = isGroup ? `--group '${chatId}'` : `'${chatId}'`;
      const dbusArg = this.signalConfig.dbus_mode ? '--dbus' : '';

      const command = `${signalCliPath} ${dbusArg} -u '${phoneNumber}' send ${recipientArg} -m '${text.replace(/'/g, "'\\''")}'`;

      await new Promise<void>((resolve, reject) => {
        exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
          if (error) {
            logger.error({ error, stderr }, 'Signal send error');
            reject(error);
          } else {
            resolve();
          }
        });
      });
    } catch (err) {
      logger.error({ err, chat_id: chatId }, 'Failed to send Signal message');
      throw err;
    }
  }

  async sendDelta(chatId: string, delta: string, options?: SendOptions): Promise<void> {
    if (!this.config.streaming) return;

    const streamEnd = options?.metadata?.stream_end as boolean;
    const streamId = (options?.metadata?.stream_id as string) || chatId;

    const current = this.streamBuffers.get(streamId) || '';
    const next = current + delta;
    this.streamBuffers.set(streamId, next);

    if (streamEnd) {
      await this.send(chatId, next, options);
      this.streamBuffers.delete(streamId);
    }
  }
}
