import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../utils/logger.js';

export interface WsHttpHandler {
  path: string;
  handle: (ws: WebSocket, req: http.IncomingMessage, query: Record<string, string>) => void;
}

export class WsHttpServer {
  private server: http.Server;
  private wss: WebSocketServer;
  private handlers: Map<string, WsHttpHandler> = new Map();

  constructor(server: http.Server) {
    this.server = server;
    this.wss = new WebSocketServer({ noServer: true });

    this.server.on('upgrade', (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
  }

  registerHandler(handler: WsHttpHandler): void {
    this.handlers.set(handler.path, handler);
    logger.info({ path: handler.path }, 'WebSocket handler registered');
  }

  private handleUpgrade(
    request: http.IncomingMessage,
    socket: import('stream').Duplex,
    head: Buffer,
  ): void {
    const url = request.url || '/';
    const pathname = url.split('?')[0];
    const queryStr = url.split('?')[1] || '';
    const query = this.parseQuery(queryStr);

    const handler = this.handlers.get(pathname);
    if (!handler) {
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit('connection', ws, request);
      handler.handle(ws, request, query);
    });
  }

  private parseQuery(queryString: string): Record<string, string> {
    const params: Record<string, string> = {};
    if (!queryString) return params;
    const pairs = queryString.split('&');
    for (const pair of pairs) {
      const [key, value] = pair.split('=');
      if (key) {
        params[decodeURIComponent(key)] = decodeURIComponent(value || '');
      }
    }
    return params;
  }

  getConnectionCount(): number {
    return this.wss.clients.size;
  }

  close(): void {
    this.wss.close();
  }
}
