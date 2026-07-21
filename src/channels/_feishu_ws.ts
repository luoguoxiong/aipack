import { EventEmitter } from 'events';

export interface FeishuWSMessage {
  schema: string;
  header: FeishuWSHeader;
  event?: FeishuWSEvent;
}

export interface FeishuWSHeader {
  event_id: string;
  event_type: string;
  tenant_key: string;
  app_id: string;
  create_time: string;
}

export interface FeishuWSEvent {
  message?: FeishuMessage;
  user?: FeishuUser;
}

export interface FeishuMessage {
  message_id: string;
  chat_id: string;
  sender_id: FeishuSenderId;
  content: string;
  create_time: string;
}

export interface FeishuSenderId {
  union_id?: string;
  user_id?: string;
  open_id?: string;
}

export interface FeishuUser {
  open_id?: string;
  user_id?: string;
  union_id?: string;
}

export class FeishuWebSocket extends EventEmitter {
  private _url: string;
  private _token: string;
  private _reconnectDelay: number;

  constructor(url: string, token: string) {
    super();
    this._url = url;
    this._token = token;
    this._reconnectDelay = 1000;
  }

  connect(): void {
    this.emit('connecting');
  }

  disconnect(): void {
    this.emit('disconnecting');
  }

  sendMessage(message: FeishuWSMessage): void {
    this.emit('message', message);
  }

  private _handleReconnect(): void {
    setTimeout(() => {
      this.connect();
    }, this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000);
  }
}