import { logger } from '../utils/logger.js';
import type { LocalTrigger } from '../triggers/local_types.js';
import type { TriggerTurnContext } from '../triggers/local_turns.js';

export interface CronBoundRunnerOptions {
  onFire: (ctx: TriggerTurnContext, trigger: LocalTrigger) => Promise<void>;
}

export class CronBoundRunner {
  private _onFire: (ctx: TriggerTurnContext, trigger: LocalTrigger) => Promise<void>;
  private _bound = false;

  constructor(opts: CronBoundRunnerOptions) {
    this._onFire = opts.onFire;
  }

  bind(): void {
    this._bound = true;
    logger.debug('Cron bound runner bound');
  }

  unbind(): void {
    this._bound = false;
    logger.debug('Cron bound runner unbound');
  }

  get isBound(): boolean {
    return this._bound;
  }

  async fire(ctx: TriggerTurnContext, trigger: LocalTrigger): Promise<void> {
    if (!this._bound) {
      logger.warn({ trigger_id: trigger.trigger_id }, 'Cron runner not bound, skipping fire');
      return;
    }
    try {
      await this._onFire(ctx, trigger);
    } catch (err) {
      logger.error({ err, trigger_id: trigger.trigger_id }, 'Error firing cron trigger');
    }
  }
}
