export interface SessionMetadata {
  appId: string;
  appVersion: string;
  command: string;
  args: string[];
  invocationId: string;
}

export interface RuntimeAnnotations {
  appId?: string;
  appName?: string;
  appCommand?: string;
}

export function buildSessionMetadata(
  appId: string,
  appVersion: string,
  command: string,
  args: string[],
): SessionMetadata {
  return {
    appId,
    appVersion,
    command,
    args,
    invocationId: `${appId}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
  };
}

export function metadataToAnnotations(metadata: SessionMetadata): RuntimeAnnotations {
  return {
    appId: metadata.appId,
    appName: metadata.appId,
    appCommand: metadata.command,
  };
}

export function formatAppMention(appId: string, version?: string): string {
  if (version) {
    return `${appId}@${version}`;
  }
  return appId;
}

export function parseAppMention(mention: string): { appId: string; version?: string } {
  const parts = mention.split('@');
  if (parts.length === 2) {
    return { appId: parts[0], version: parts[1] };
  }
  return { appId: mention };
}

export function sanitizeAppId(appId: string): string {
  return appId.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

export function generateInvocationId(appId: string): string {
  return `${sanitizeAppId(appId)}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function buildRuntimeContext(annotations: RuntimeAnnotations): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  if (annotations.appId) context.app_id = annotations.appId;
  if (annotations.appName) context.app_name = annotations.appName;
  if (annotations.appCommand) context.app_command = annotations.appCommand;
  return context;
}