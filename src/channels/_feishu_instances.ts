export interface FeishuInstance {
  app_id: string;
  app_secret: string;
  tenant_access_token: string;
  token_expire_time: number;
  lark_host: string;
}

const _instances: Map<string, FeishuInstance> = new Map();

export function getFeishuInstance(appId: string): FeishuInstance | undefined {
  return _instances.get(appId);
}

export function setFeishuInstance(appId: string, instance: FeishuInstance): void {
  _instances.set(appId, instance);
}

export function removeFeishuInstance(appId: string): void {
  _instances.delete(appId);
}

export function clearFeishuInstances(): void {
  _instances.clear();
}

export function listFeishuInstances(): FeishuInstance[] {
  return Array.from(_instances.values());
}