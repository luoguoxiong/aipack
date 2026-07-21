export interface LocalTrigger {
  trigger_id: string;
  channel: string;
  account_identity: string;
  type: 'cron' | 'event';
  spec: Record<string, unknown>;
  label: string | null;
  user_id: string | null;
  session_id: string | null;
  payload: Record<string, unknown> | null;
  system_prompt: string | null;
  created_at: string;
  updated_at: string;
  last_fire_at: string | null;
  fire_count: number;
  enabled: boolean;
  pinned: boolean;
  _etag: string;
}

export interface LocalTriggerEnqueueState {
  queue_path: string;
  entry_id: string;
  trigger: LocalTrigger;
  fire_at: string;
}

export function isTriggerEqual(a: LocalTrigger, b: LocalTrigger): boolean {
  return a.type === b.type && a.channel === b.channel && a.account_identity === b.account_identity;
}
