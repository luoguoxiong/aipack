import { WebSocket } from 'ws';
import { logger } from '../utils/logger.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface WsLogMessage {
  type: 'log';
  level: LogLevel;
  message: string;
  timestamp: string;
  data?: unknown;
}

export class WsLogger {
  private connections: Set<WebSocket> = new Set();
  private buffer: WsLogMessage[] = [];
  private maxBufferSize = 1000;

  addConnection(ws: WebSocket): void {
    this.connections.add(ws);
    for (const msg of this.buffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    }
    ws.on('close', () => {
      this.connections.delete(ws);
    });
    logger.debug({ connections: this.connections.size }, 'WS logger connection added');
  }

  log(level: LogLevel, message: string, data?: unknown): void {
    const logMsg: WsLogMessage = {
      type: 'log',
      level,
      message,
      timestamp: new Date().toISOString(),
      data,
    };

    this.buffer.push(logMsg);
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }

    for (const ws of this.connections) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(logMsg));
      }
    }

    const logFn = logger[level] as typeof logger.info;
    if (data !== undefined) {
      logFn({ data }, message);
    } else {
      logFn(message);
    }
  }

  debug(message: string, data?: unknown): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: unknown): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: unknown): void {
    this.log('error', message, data);
  }

  getBuffer(): WsLogMessage[] {
    return [...this.buffer];
  }

  clearBuffer(): void {
    this.buffer = [];
  }

  getConnectionCount(): number {
    return this.connections.size;
  }
}

export const wsLogger = new WsLogger();
