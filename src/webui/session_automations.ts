import { logger } from '../utils/logger.js';

export interface SessionAutomation {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  session_key: string;
  prompt: string;
  created_at: string;
  updated_at: string;
}

export class SessionAutomationsManager {
  private automations: Map<string, SessionAutomation> = new Map();

  list(): SessionAutomation[] {
    return Array.from(this.automations.values()).sort((a, b) =>
      b.updated_at.localeCompare(a.updated_at),
    );
  }

  get(id: string): SessionAutomation | undefined {
    return this.automations.get(id);
  }

  create(automation: Omit<SessionAutomation, 'id' | 'created_at' | 'updated_at'>): SessionAutomation {
    const id = `automation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const newAutomation: SessionAutomation = {
      ...automation,
      id,
      created_at: now,
      updated_at: now,
    };
    this.automations.set(id, newAutomation);
    logger.info({ id, name: automation.name }, 'Created session automation');
    return newAutomation;
  }

  update(id: string, updates: Partial<SessionAutomation>): SessionAutomation | undefined {
    const existing = this.automations.get(id);
    if (!existing) return undefined;
    const updated: SessionAutomation = {
      ...existing,
      ...updates,
      id,
      updated_at: new Date().toISOString(),
    };
    this.automations.set(id, updated);
    logger.info({ id }, 'Updated session automation');
    return updated;
  }

  delete(id: string): boolean {
    const deleted = this.automations.delete(id);
    if (deleted) {
      logger.info({ id }, 'Deleted session automation');
    }
    return deleted;
  }
}
