export interface CronJob {
  id: string;
  name: string;
  schedule: CronSchedule;
  action: CronAction;
  enabled: boolean;
  timezone?: string;
  metadata?: Record<string, unknown>;
}

export interface CronSchedule {
  expression: string;
  description?: string;
}

export interface CronAction {
  type: 'message' | 'task';
  payload: Record<string, unknown>;
}

export interface CronExecutionRecord {
  job_id: string;
  fire_at: string;
  completed_at?: string;
  success: boolean;
  error?: string;
}

export interface TriggerCronSpec {
  schedule: string;
  timezone?: string;
  start_date?: string;
  end_date?: string;
}

export function validateCronExpression(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) {
    return false;
  }
  return true;
}
