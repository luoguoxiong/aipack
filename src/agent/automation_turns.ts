import { InboundMessage, OutboundMessage } from '../bus/queue.js';

export class AutomationTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutomationTurnError';
  }
}

export async function publishNextDeferredTurn(
  deferredQueues: Map<string, InboundMessage[]>,
  publishInbound: (msg: InboundMessage) => Promise<void>,
  sessionKey: string,
): Promise<boolean> {
  const queue = deferredQueues.get(sessionKey);
  if (!queue || queue.length === 0) return false;
  const msg = queue.shift()!;
  if (queue.length === 0) {
    deferredQueues.delete(sessionKey);
  }
  await publishInbound(msg);
  return true;
}

export interface AutomationTurnCoordinatorOptions {
  publishInbound: (msg: InboundMessage) => Promise<void>;
  dispatch: (msg: InboundMessage) => Promise<unknown>;
  isRunning: () => boolean;
  turnId: (msg: InboundMessage) => string | null | undefined;
  pendingId: (msg: InboundMessage) => string | null | undefined;
  shouldDeferTurn: (msg: InboundMessage, sessionKey: string, activeSessionKeys: string[]) => boolean;
  missingIdError: string;
  duplicateIdError: (id: string) => string;
  deferredQueues?: Map<string, InboundMessage[]>;
}

export class AutomationTurnCoordinator {
  private _publishInbound: (msg: InboundMessage) => Promise<void>;
  private _dispatch: (msg: InboundMessage) => Promise<unknown>;
  private _isRunning: () => boolean;
  private _turnId: (msg: InboundMessage) => string | null | undefined;
  private _pendingId: (msg: InboundMessage) => string | null | undefined;
  private _shouldDeferTurn: (msg: InboundMessage, sessionKey: string, activeSessionKeys: string[]) => boolean;
  private _missingIdError: string;
  private _duplicateIdError: (id: string) => string;
  deferredQueues: Map<string, InboundMessage[]>;
  private _waiters: Map<string, { resolve: (value: OutboundMessage | null) => void; reject: (reason: unknown) => void }> = new Map();
  private _pendingMessagesByTurnId: Map<string, InboundMessage> = new Map();

  constructor(options: AutomationTurnCoordinatorOptions) {
    this._publishInbound = options.publishInbound;
    this._dispatch = options.dispatch;
    this._isRunning = options.isRunning;
    this._turnId = options.turnId;
    this._pendingId = options.pendingId;
    this._shouldDeferTurn = options.shouldDeferTurn;
    this._missingIdError = options.missingIdError;
    this._duplicateIdError = options.duplicateIdError;
    this.deferredQueues = options.deferredQueues ?? new Map();
  }

  async submit(msg: InboundMessage): Promise<OutboundMessage | null> {
    const turnId = this._turnId(msg);
    if (!turnId) {
      throw new Error(this._missingIdError);
    }
    if (this._waiters.has(turnId)) {
      throw new Error(this._duplicateIdError(turnId));
    }

    let resolve!: (value: OutboundMessage | null) => void;
    let reject!: (reason: unknown) => void;
    const future = new Promise<OutboundMessage | null>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this._waiters.set(turnId, { resolve, reject });
    this._pendingMessagesByTurnId.set(turnId, msg);

    try {
      if (this._isRunning()) {
        await this._publishInbound(msg);
      } else {
        await this._dispatch(msg);
      }
      try {
        return await future;
      } catch (err) {
        if (err instanceof AutomationTurnError) {
          throw err;
        }
        throw new AutomationTurnError(
          (err as Error).message || (err as Error).name,
        );
      }
    } finally {
      this._waiters.delete(turnId);
      this._pendingMessagesByTurnId.delete(turnId);
    }
  }

  deferIfActive(
    msg: InboundMessage,
    options: { sessionKey: string; activeSessionKeys: string[] },
  ): boolean {
    const { sessionKey, activeSessionKeys } = options;
    if (!this._shouldDeferTurn(msg, sessionKey, activeSessionKeys)) {
      return false;
    }
    let pendingMsg = msg;
    if (sessionKey !== msg.session_key) {
      pendingMsg = { ...msg, session_key: sessionKey };
    }
    if (!this.deferredQueues.has(sessionKey)) {
      this.deferredQueues.set(sessionKey, []);
    }
    this.deferredQueues.get(sessionKey)!.push(pendingMsg);
    return true;
  }

  complete(
    msg: InboundMessage,
    options: { response?: OutboundMessage | null; error?: unknown } = {},
  ): void {
    const turnId = this._turnId(msg);
    if (!turnId) return;
    const waiter = this._waiters.get(turnId);
    if (!waiter) return;

    if (options.error !== undefined && options.error !== null) {
      const error = options.error instanceof Error
        ? options.error
        : new AutomationTurnError(String(options.error));
      waiter.reject(error);
    } else {
      waiter.resolve(options.response ?? null);
    }
  }

  pendingIdsForSession(sessionKey: string): Set<string> {
    const pendingIds = new Set<string>();

    const queue = this.deferredQueues.get(sessionKey);
    if (queue) {
      for (const msg of queue) {
        const pendingId = this._pendingId(msg);
        if (pendingId) {
          pendingIds.add(pendingId);
        }
      }
    }

    for (const msg of this._pendingMessagesByTurnId.values()) {
      if (msg.session_key !== sessionKey) continue;
      const pendingId = this._pendingId(msg);
      if (pendingId) {
        pendingIds.add(pendingId);
      }
    }

    return pendingIds;
  }

  async publishNextDeferred(sessionKey: string): Promise<boolean> {
    return publishNextDeferredTurn(
      this.deferredQueues,
      this._publishInbound,
      sessionKey,
    );
  }
}
