import { generateTurnId } from '../utils/helpers.js';

export interface TriggerTurnContext {
  turn_id: string;
  trigger_id: string;
  fire_at: string;
  session_id: string | null;
  channel: string;
  account_identity: string;
}

export function buildTriggerTurnContext(
  trigger: { trigger_id: string; channel: string; account_identity: string; session_id: string | null },
  fireAt: string,
): TriggerTurnContext {
  return {
    turn_id: generateTurnId(),
    trigger_id: trigger.trigger_id,
    fire_at: fireAt,
    session_id: trigger.session_id,
    channel: trigger.channel,
    account_identity: trigger.account_identity,
  };
}
