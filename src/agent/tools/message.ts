import { BaseTool, ToolContext, ToolResult, createToolResult, createToolError } from './base.js';
import { z } from 'zod';
import path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import { currentRequestContext } from './context.js';
import { logger } from '../../utils/logger.js';

const MessageToolSchema = z.object({
  content: z.string().describe(
    'Message content for proactive or cross-channel delivery. ' +
    'Do not use this for a normal reply in the current chat.',
  ),
  channel: z.string().optional().describe(
    'Optional target channel for cross-channel/proactive delivery. ' +
    'Do not set this to the current runtime channel for a normal reply.',
  ),
  chat_id: z.string().optional().describe(
    'Optional target chat/user ID for cross-channel/proactive delivery. ' +
    'On WebSocket/WebUI turns: omit chat_id to use the server\'s conversation id. ' +
    'Do not set this to the current runtime chat for a normal reply.',
  ),
  media: z.array(z.string()).optional().describe(
    'Optional list of existing file paths to attach. ' +
    'Use artifact paths returned by generate_image here when delivering generated images.',
  ),
  buttons: z.array(z.array(z.string())).optional().describe(
    'Optional: inline keyboard buttons as list of rows, each row is list of button labels.',
  ),
});

export interface OutboundMessage {
  channel: string;
  chat_id: string;
  content: string;
  media: string[];
  buttons: string[][];
  metadata: Record<string, unknown>;
}

export type SendCallback = (msg: OutboundMessage) => Promise<void>;

const _sentInTurnVar = new AsyncLocalStorage<boolean>();
const _turnDeliveredMediaVar = new AsyncLocalStorage<string[]>();
const _recordChannelDeliveryVar = new AsyncLocalStorage<boolean>();
const _suppressDeliveryVar = new AsyncLocalStorage<boolean>();

export class MessageTool extends BaseTool {
  name = 'message';
  description = (
    'Proactively send a message to a user/channel, optionally with file attachments. ' +
    'Use this for reminders, cross-channel delivery, or explicit proactive sends. ' +
    'Do not use this for the normal reply in the current chat: answer naturally instead. ' +
    'If channel/chat_id would target the current runtime conversation, do not call this tool ' +
    'unless the user explicitly asked you to proactively send an existing file attachment. ' +
    'When generate_image creates images in the current chat, use the message tool ' +
    'with the artifact paths in the media parameter to deliver the images to the user. ' +
    'For proactive attachment delivery, use the \'media\' parameter with file paths. ' +
    'Do NOT use read_file to send files — that only reads content for your own analysis.'
  );
  input_schema = MessageToolSchema;
  tags = ['message', 'communication'];

  private _send_callback: SendCallback | null = null;
  private _workspace: string;
  private _restrict_to_workspace: boolean;
  private _fallback_channel = '';
  private _fallback_chat_id = '';
  private _fallback_message_id: string | null = null;
  private _fallback_metadata: Record<string, unknown> = {};

  constructor(options?: {
    sendCallback?: SendCallback;
    defaultChannel?: string;
    defaultChatId?: string;
    defaultMessageId?: string | null;
    workspace?: string;
    restrictToWorkspace?: boolean;
  }) {
    super();
    this._send_callback = options?.sendCallback ?? null;
    this._workspace = options?.workspace ?? process.cwd();
    this._restrict_to_workspace = options?.restrictToWorkspace ?? false;
    this._fallback_channel = options?.defaultChannel ?? '';
    this._fallback_chat_id = options?.defaultChatId ?? '';
    this._fallback_message_id = options?.defaultMessageId ?? null;
  }

  setSendCallback(callback: SendCallback): void {
    this._send_callback = callback;
  }

  startTurn(): void {
    _sentInTurnVar.enterWith(false);
    _turnDeliveredMediaVar.enterWith([]);
  }

  turnDeliveredMediaPaths(): string[] {
    return [...(_turnDeliveredMediaVar.getStore() ?? [])];
  }

  setRecordChannelDelivery(active: boolean): void {
    _recordChannelDeliveryVar.enterWith(active);
  }

  setSuppressDelivery(active: boolean): void {
    _suppressDeliveryVar.enterWith(active);
  }

  private _getSentInTurn(): boolean {
    return _sentInTurnVar.getStore() ?? false;
  }

  private _setSentInTurn(value: boolean): void {
    _sentInTurnVar.enterWith(value);
  }

  private _resolveMedia(media: string[]): string[] {
    const resolved: string[] = [];
    const workspace = this._workspace;
    for (const p of media) {
      if (p.startsWith('http://') || p.startsWith('https://')) {
        resolved.push(p);
      } else if (!this._restrict_to_workspace) {
        const filePath = path.isAbsolute(p) ? p : path.resolve(workspace, p);
        resolved.push(filePath);
      } else {
        const resolvedPath = path.resolve(workspace, p);
        if (!resolvedPath.startsWith(path.resolve(workspace))) {
          throw new Error(`Path is outside workspace: ${p}`);
        }
        resolved.push(resolvedPath);
      }
    }
    return resolved;
  }

  async execute(args: unknown, _context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
      let content = params.content;

      content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      if (params.buttons !== undefined) {
        if (!Array.isArray(params.buttons) || !params.buttons.every(
          (row) => Array.isArray(row) && row.every((label) => typeof label === 'string'),
        )) {
          return createToolError('Error: buttons must be a list of list of strings');
        }
      }

      const requestCtx = currentRequestContext();
      const defaultChannel = requestCtx?.channel ?? this._fallback_channel;
      const defaultChatId = requestCtx?.chat_id ?? this._fallback_chat_id;
      const defaultMessageId = requestCtx?.message_id ?? this._fallback_message_id;
      const defaultMetadata = requestCtx?.metadata ?? this._fallback_metadata;

      const channel = params.channel || defaultChannel;
      const explicitChatId = params.chat_id;

      if (
        defaultChannel === 'websocket' &&
        channel === 'websocket' &&
        explicitChatId !== undefined &&
        explicitChatId.trim() !== '' &&
        explicitChatId.trim() !== defaultChatId.trim()
      ) {
        return createToolError(
          'Error: chat_id does not match the active WebSocket conversation. ' +
          'Omit chat_id (and usually channel) so delivery uses the current ' +
          'conversation id from context — WebSocket client_id strings ' +
          '(e.g. anon-…) are not chat ids.',
        );
      }

      const chatId = params.chat_id || defaultChatId;
      const sameTarget = channel === defaultChannel && chatId === defaultChatId;
      let messageId: string | null | undefined;
      if (sameTarget) {
        messageId = params.chat_id ? undefined : defaultMessageId;
      } else {
        messageId = null;
      }

      if (!channel || !chatId) {
        return createToolError('Error: No target channel/chat specified');
      }

      if (!this._send_callback) {
        return createToolError('Error: Message sending not configured');
      }

      let media: string[] | undefined = params.media;
      if (media) {
        try {
          media = this._resolveMedia(media);
        } catch (e) {
          return createToolError(`Error: media path is not allowed: ${(e as Error).message}`);
        }
      }

      const metadata: Record<string, unknown> = sameTarget ? { ...defaultMetadata } : {};
      if (messageId) {
        metadata['message_id'] = messageId;
      }
      if (_recordChannelDeliveryVar.getStore() || media) {
        metadata['_record_channel_delivery'] = true;
      }

      const msg: OutboundMessage = {
        channel,
        chat_id: chatId,
        content,
        media: media || [],
        buttons: params.buttons || [],
        metadata,
      };

      if (_suppressDeliveryVar.getStore()) {
        logger.debug('MessageTool: delivery suppressed during internal check');
        return createToolResult(`Message acknowledged for ${channel}:${chatId} (not delivered)`);
      }

      try {
        await this._send_callback(msg);
        if (channel === defaultChannel && chatId === defaultChatId) {
          this._setSentInTurn(true);
          if (media) {
            const prev = _turnDeliveredMediaVar.getStore() ?? [];
            _turnDeliveredMediaVar.enterWith([...prev, ...media]);
          }
        }
        const mediaInfo = media ? ` with ${media.length} attachments` : '';
        const buttonInfo = params.buttons
          ? ` with ${params.buttons.reduce((sum, row) => sum + row.length, 0)} button(s)`
          : '';
        return createToolResult(`Message sent to ${channel}:${chatId}${mediaInfo}${buttonInfo}`);
      } catch (e) {
        return createToolError(`Error sending message: ${(e as Error).message}`);
      }
    } catch (e) {
      return createToolError(`Error: ${(e as Error).message}`);
    }
  }
}

export function getMessageTools(): BaseTool[] {
  return [new MessageTool()];
}
