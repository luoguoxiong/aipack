/**
 * Request - 请求入口
 *
 * 灵感来自 webpack 的 Entry。
 * 代表一次 Agent 运行的入口请求，包含用户输入、会话标识与运行选项。
 *
 * Webpack 映射: Entry
 */

// ─── 请求类型 ─────────────────────────────────────────────────────

export type RequestType = 'message' | 'stream' | 'continue' | 'replay';

// ─── 请求接口 ─────────────────────────────────────────────────────

export interface Request {
  /** 用户输入消息 */
  readonly message: string;
  /** 请求类型 */
  readonly type: RequestType;
  /** 会话标识 */
  readonly sessionKey: string;
  /** 通道标识 */
  readonly channel?: string;
  /** 聊天 ID */
  readonly chatId?: string;
  /** 发送者 ID */
  readonly senderId?: string;
  /** 媒体附件 */
  readonly media?: string[];
  /** 是否临时会话（不持久化） */
  readonly ephemeral?: boolean;
  /** 指定模型 */
  readonly model?: string;
  /** 指定模型预设 */
  readonly modelPreset?: string;
  /** 额外元数据 */
  readonly metadata?: Record<string, unknown>;
}

// ─── 请求构建器 ───────────────────────────────────────────────────

export class RequestBuilder {
  private _message: string = '';
  private _type: RequestType = 'message';
  private _sessionKey: string = 'sdk:default';
  private _channel?: string;
  private _chatId?: string;
  private _senderId?: string;
  private _media?: string[];
  private _ephemeral?: boolean;
  private _model?: string;
  private _modelPreset?: string;
  private _metadata: Record<string, unknown> = {};

  message(msg: string): this {
    this._message = msg;
    return this;
  }

  type(t: RequestType): this {
    this._type = t;
    return this;
  }

  sessionKey(key: string): this {
    this._sessionKey = key;
    return this;
  }

  channel(ch: string): this {
    this._channel = ch;
    return this;
  }

  chatId(id: string): this {
    this._chatId = id;
    return this;
  }

  senderId(id: string): this {
    this._senderId = id;
    return this;
  }

  media(m: string[]): this {
    this._media = m;
    return this;
  }

  ephemeral(e: boolean): this {
    this._ephemeral = e;
    return this;
  }

  model(m: string): this {
    this._model = m;
    return this;
  }

  modelPreset(p: string): this {
    this._modelPreset = p;
    return this;
  }

  metadata(key: string, value: unknown): this {
    this._metadata[key] = value;
    return this;
  }

  build(): Request {
    return {
      message: this._message,
      type: this._type,
      sessionKey: this._sessionKey,
      channel: this._channel,
      chatId: this._chatId,
      senderId: this._senderId,
      media: this._media,
      ephemeral: this._ephemeral,
      model: this._model,
      modelPreset: this._modelPreset,
      metadata: this._metadata,
    };
  }
}

export function createRequest(message: string, options?: Partial<Request>): Request {
  return {
    message,
    type: 'message',
    sessionKey: 'sdk:default',
    ...options,
  };
}
