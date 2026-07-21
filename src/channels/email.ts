import { logger } from '../utils/logger.js';
import { MessageBus } from '../bus/queue.js';
import { BaseChannel, ChannelConfig, SendOptions } from './base.js';

export interface EmailChannelConfig extends ChannelConfig {
  consent_granted?: boolean;
  imap_host?: string;
  imap_port?: number;
  imap_username?: string;
  imap_password?: string;
  imap_mailbox?: string;
  imap_use_ssl?: boolean;
  smtp_host?: string;
  smtp_port?: number;
  smtp_username?: string;
  smtp_password?: string;
  smtp_use_tls?: boolean;
  smtp_use_ssl?: boolean;
  from_address?: string;
  auto_reply_enabled?: boolean;
  poll_interval_seconds?: number;
  mark_seen?: boolean;
  post_action?: 'delete' | 'move' | null;
  post_action_move_mailbox?: string | null;
  post_action_expunge?: boolean;
  max_body_chars?: number;
  subject_prefix?: string;
  allow_from?: string[];
  verify_dkim?: boolean;
  verify_spf?: boolean;
  allowed_attachment_types?: string[];
  max_attachment_size?: number;
  max_attachments_per_email?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ImapConnection = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ImapFetch = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ImapMessage = any;

export class EmailChannel extends BaseChannel {
  name = 'email';
  private processedUids: Set<string> = new Set();
  private lastSubjectByChat: Map<string, string> = new Map();
  private lastMessageIdByChat: Map<string, string> = new Map();
  private pollTimer?: NodeJS.Timeout;

  protected get emailConfig(): EmailChannelConfig {
    return this.config as EmailChannelConfig;
  }

  constructor(bus: MessageBus, config: EmailChannelConfig) {
    super(bus, config);
    this.name = config.name || 'email';
  }

  async start(): Promise<void> {
    if (this.running) return;

    if (!this.emailConfig.consent_granted) {
      logger.warn('Email channel disabled: consent_granted is false');
      return;
    }

    if (!this.validateConfig()) {
      return;
    }

    this.subscribeToOutbound();
    this.subscribeToStream();

    this.running = true;
    this.startPolling();
    logger.info('Email channel started (IMAP polling mode)');
  }

  private validateConfig(): boolean {
    const config = this.emailConfig;
    if (!config.imap_host || !config.imap_username || !config.imap_password) {
      logger.error('Email IMAP not fully configured: host, username, password required');
      return false;
    }
    if (!config.smtp_host || !config.smtp_username || !config.smtp_password) {
      logger.error('Email SMTP not fully configured: host, username, password required');
      return false;
    }
    return true;
  }

  private startPolling(): void {
    const interval = Math.max(5, this.emailConfig.poll_interval_seconds || 30) * 1000;
    this.pollTimer = setInterval(() => {
      this.fetchNewMessages().catch(err => {
        logger.error({ err }, 'Email poll error');
      });
    }, interval);
  }

  private async fetchNewMessages(): Promise<void> {
    try {
      // @ts-ignore - dynamic import
      const imapModule = await import('imap');
      // @ts-ignore - dynamic import
      const mailparserModule = await import('mailparser');

      const Imap = imapModule.default || imapModule;
      const simpleParser = mailparserModule.simpleParser;

      const config = this.emailConfig;

      const connection = new Imap({
        user: config.imap_username,
        password: config.imap_password,
        host: config.imap_host,
        port: config.imap_port || 993,
        tls: config.imap_use_ssl !== false,
        tlsOptions: { rejectUnauthorized: false },
      }) as ImapConnection;

      connection.once('ready', () => {
        connection.openBox(config.imap_mailbox || 'INBOX', false, (err: unknown) => {
          if (err) {
            logger.error({ err }, 'Failed to open mailbox');
            connection.end();
            return;
          }

          connection.search(['UNSEEN'], (searchErr: unknown, results: number[]) => {
            if (searchErr) {
              logger.error({ err: searchErr }, 'Failed to search emails');
              connection.end();
              return;
            }

            if (!results || results.length === 0) {
              connection.end();
              return;
            }

            const fetch = connection.fetch(results, { bodies: '', markSeen: config.mark_seen !== false });
            const messagesToProcess: Array<{ uid: string; source: Buffer }> = [];

            fetch.on('message', (msg: ImapMessage) => {
              let uid = '';
              let rawBody = Buffer.from('');

              msg.on('body', (stream: NodeJS.ReadableStream) => {
                const chunks: Buffer[] = [];
                stream.on('data', (chunk: Buffer) => chunks.push(chunk));
                stream.on('end', () => {
                  rawBody = Buffer.concat(chunks);
                });
              });

              msg.on('attributes', (attrs: Record<string, unknown>) => {
                uid = String(attrs.uid || '');
              });

              msg.on('end', () => {
                if (uid && rawBody.length > 0) {
                  messagesToProcess.push({ uid, source: rawBody });
                }
              });
            });

            fetch.on('end', async () => {
              for (const { uid, source } of messagesToProcess) {
                try {
                  const parsed = await simpleParser(source);
                  await this.processEmail(uid, parsed);
                } catch (err) {
                  logger.error({ err }, 'Failed to parse email');
                }
              }
              connection.end();
            });

            fetch.on('error', (fetchErr: unknown) => {
              logger.error({ err: fetchErr }, 'Error fetching emails');
              connection.end();
            });
          });
        });
      });

      connection.once('error', (err: unknown) => {
        logger.error({ err }, 'IMAP connection error');
      });

      connection.connect();
    } catch (err) {
      logger.debug({ err }, 'Email dependencies not available, install imap and mailparser');
    }
  }

  private async processEmail(uid: string, parsed: Record<string, unknown>): Promise<void> {
    try {
      if (this.processedUids.has(uid)) return;
      this.processedUids.add(uid);
      if (this.processedUids.size > 100000) {
        const first = this.processedUids.values().next().value;
        if (first) this.processedUids.delete(first);
      }

      const from = parsed.from as { value: Array<{ address: string; name: string }> } | undefined;
      const sender = from?.value?.[0]?.address || 'unknown';
      const senderName = from?.value?.[0]?.name || sender;

      if (!this.isAllowed(sender)) {
        logger.info(`Email from ${sender} not in allow_from list, skipping`);
        return;
      }

      const subject = parsed.subject as string || '';
      const messageId = parsed.messageId as string || '';
      let text = parsed.text as string || '';
      const attachments = (parsed.attachments || []) as Array<{ filename: string; content: Buffer; size: number; contentType: string }>;

      const maxBodyChars = this.emailConfig.max_body_chars || 12000;
      if (text.length > maxBodyChars) {
        text = text.slice(0, maxBodyChars) + '...';
      }

      if (subject) {
        this.lastSubjectByChat.set(sender, subject);
      }
      if (messageId) {
        this.lastMessageIdByChat.set(sender, messageId);
      }

      const mediaPaths: string[] = [];
      const maxAttachments = this.emailConfig.max_attachments_per_email || 5;
      const maxAttachmentSize = this.emailConfig.max_attachment_size || 2000000;
      const allowedTypes = this.emailConfig.allowed_attachment_types || [];

      if (allowedTypes.length > 0) {
        let processedCount = 0;
        const path = await import('path');
        const fs = await import('fs');
        const os = await import('os');
        const mediaDir = path.join(os.tmpdir(), 'nanobot-email-media');
        if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

        for (const att of attachments) {
          if (processedCount >= maxAttachments) break;
          if (att.size > maxAttachmentSize) continue;

          const allowed = allowedTypes.some(t => {
            if (t === '*') return true;
            if (t.endsWith('/*')) {
              const prefix = t.slice(0, -1);
              return att.contentType.startsWith(prefix);
            }
            return att.contentType === t;
          });

          if (!allowed) continue;

          const safeName = this.sanitizeFilename(att.filename || 'attachment');
          const filePath = path.join(mediaDir, `${Date.now()}_${safeName}`);
          fs.writeFileSync(filePath, att.content);
          mediaPaths.push(filePath);
          processedCount++;
        }
      }

      this.publishInbound({
        chat_id: sender,
        sender_id: sender,
        sender_name: senderName,
        text,
        media: mediaPaths.length > 0 ? mediaPaths : undefined,
        metadata: {
          uid,
          subject,
          message_id: messageId,
        },
      });
    } catch (err) {
      logger.error({ err }, 'Error processing email');
    }
  }

  private sanitizeFilename(name: string): string {
    name = name.trim();
    name = name.split(/[\\/]/).pop() || name;
    name = name.replace(/[^\w.\-()\[\]]/g, '_').replace(/^[._\s]+|[._\s]+$/g, '');
    return name || 'file';
  }

  private isAllowed(sender: string): boolean {
    const allowFrom = this.emailConfig.allow_from || [];
    if (allowFrom.includes('*')) return true;
    if (allowFrom.includes(sender)) return true;
    return allowFrom.some(pattern => {
      if (pattern.includes('*') || pattern.includes('?')) {
        const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        return regex.test(sender);
      }
      return false;
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    this.unsubscribeAll();
    this.running = false;
    logger.info('Email channel stopped');
  }

  async send(chatId: string, text: string, options?: SendOptions): Promise<void> {
    try {
      // @ts-ignore - dynamic import
      const nodemailerModule = await import('nodemailer');
      const nodemailer = nodemailerModule.default || nodemailerModule;

      const config = this.emailConfig;
      const transporter = nodemailer.createTransport({
        host: config.smtp_host,
        port: config.smtp_port || 587,
        secure: config.smtp_use_ssl === true,
        auth: {
          user: config.smtp_username,
          pass: config.smtp_password,
        },
        tls: config.smtp_use_tls !== false ? { rejectUnauthorized: false } : undefined,
      });

      const subject = this.lastSubjectByChat.get(chatId)
        ? `${config.subject_prefix || 'Re: '}${this.lastSubjectByChat.get(chatId)}`
        : 'Message from nanobot';

      const mailOptions: Record<string, unknown> = {
        from: config.from_address || config.smtp_username,
        to: chatId,
        subject,
        text,
        html: this.textToHtml(text),
      };

      const lastMessageId = this.lastMessageIdByChat.get(chatId);
      if (lastMessageId) {
        mailOptions['inReplyTo'] = lastMessageId;
        mailOptions['references'] = lastMessageId;
      }

      if (options?.media && options.media.length > 0) {
        const fs = await import('fs');
        const path = await import('path');
        mailOptions['attachments'] = options.media.map(filePath => ({
          filename: path.basename(filePath),
          content: fs.readFileSync(filePath),
        }));
      }

      await transporter.sendMail(mailOptions);
      logger.info(`Email sent to ${chatId}`);
    } catch (err) {
      logger.error({ err, chat_id: chatId }, 'Failed to send email');
      throw err;
    }
  }

  private textToHtml(text: string): string {
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
    return `<html><body><p>${escaped}</p></body></html>`;
  }

  async sendDelta(_chatId: string, _delta: string, _options?: SendOptions): Promise<void> {
  }
}
