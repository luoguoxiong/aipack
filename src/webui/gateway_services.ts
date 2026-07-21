import { logger } from '../utils/logger.js';

export interface GatewayService {
  id: string;
  name: string;
  type: string;
  status: 'running' | 'stopped' | 'error';
  endpoint?: string;
  started_at?: string;
  last_heartbeat?: string;
}

export class GatewayServicesManager {
  private services: Map<string, GatewayService> = new Map();

  register(service: GatewayService): void {
    this.services.set(service.id, service);
    logger.info({ serviceId: service.id, name: service.name }, 'Gateway service registered');
  }

  unregister(serviceId: string): boolean {
    const removed = this.services.delete(serviceId);
    if (removed) {
      logger.info({ serviceId }, 'Gateway service unregistered');
    }
    return removed;
  }

  list(): GatewayService[] {
    return Array.from(this.services.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(serviceId: string): GatewayService | undefined {
    return this.services.get(serviceId);
  }

  updateStatus(serviceId: string, status: GatewayService['status']): boolean {
    const service = this.services.get(serviceId);
    if (!service) return false;
    service.status = status;
    if (status === 'running') {
      service.last_heartbeat = new Date().toISOString();
    }
    return true;
  }

  payload(): { services: GatewayService[] } {
    return { services: this.list() };
  }
}
