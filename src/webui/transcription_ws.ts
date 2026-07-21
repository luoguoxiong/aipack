import { WebSocket } from 'ws';
import { logger } from '../utils/logger.js';

export interface TranscriptionSession {
  id: string;
  ws: WebSocket;
  language?: string;
  isTranscribing: boolean;
  startTime: number;
}

export class TranscriptionWsManager {
  private sessions: Map<string, TranscriptionSession> = new Map();

  handleConnection(ws: WebSocket, sessionId: string, _query: Record<string, string>): void {
    const session: TranscriptionSession = {
      id: sessionId,
      ws,
      isTranscribing: false,
      startTime: Date.now(),
    };
    this.sessions.set(sessionId, session);
    logger.info({ sessionId }, 'Transcription WebSocket connected');

    ws.send(
      JSON.stringify({
        type: 'ready',
        sessionId,
      }),
    );

    ws.on('message', (data) => {
      this.handleMessage(sessionId, data);
    });

    ws.on('close', () => {
      this.handleClose(sessionId);
    });

    ws.on('error', (err) => {
      logger.warn({ err, sessionId }, 'Transcription WebSocket error');
    });
  }

  private handleMessage(sessionId: string, data: WebSocket.Data): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      if (typeof data === 'string') {
        const msg = JSON.parse(data);
        this.handleCommand(sessionId, msg);
      } else {
        this.handleAudioData(sessionId, data as Buffer);
      }
    } catch (err) {
      logger.warn({ err, sessionId }, 'Failed to handle transcription message');
    }
  }

  private handleCommand(sessionId: string, msg: Record<string, unknown>): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    switch (msg.type) {
      case 'start':
        session.isTranscribing = true;
        session.language = typeof msg.language === 'string' ? msg.language : undefined;
        session.ws.send(JSON.stringify({ type: 'started', language: session.language }));
        break;
      case 'stop':
        session.isTranscribing = false;
        session.ws.send(JSON.stringify({ type: 'stopped' }));
        break;
      case 'config':
        if (typeof msg.language === 'string') {
          session.language = msg.language;
        }
        break;
      default:
        logger.warn({ type: msg.type, sessionId }, 'Unknown transcription command');
    }
  }

  private handleAudioData(sessionId: string, _data: Buffer): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isTranscribing) return;
  }

  private handleClose(sessionId: string): void {
    this.sessions.delete(sessionId);
    logger.info({ sessionId }, 'Transcription WebSocket disconnected');
  }

  sendTranscript(sessionId: string, text: string, isFinal: boolean): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.ws.readyState !== session.ws.OPEN) return false;

    session.ws.send(
      JSON.stringify({
        type: 'transcript',
        text,
        isFinal,
        timestamp: new Date().toISOString(),
      }),
    );
    return true;
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.ws.close();
    }
    this.sessions.clear();
  }
}

export const transcriptionWsManager = new TranscriptionWsManager();
