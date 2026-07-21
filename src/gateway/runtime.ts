import { logger } from '../utils/logger.js';
import { GatewayService } from './service.js';

export interface GatewayRuntimeOptions {
  service: GatewayService;
}

export class GatewayRuntime {
  private _service: GatewayService;
  private _running = false;

  constructor(opts: GatewayRuntimeOptions) {
    this._service = opts.service;
  }

  async start(): Promise<void> {
    if (this._running) {
      return;
    }
    this._running = true;
    logger.info('Gateway runtime started');
  }

  async stop(): Promise<void> {
    if (!this._running) {
      return;
    }
    this._running = false;
    logger.info('Gateway runtime stopped');
  }

  get isRunning(): boolean {
    return this._running;
  }
}
