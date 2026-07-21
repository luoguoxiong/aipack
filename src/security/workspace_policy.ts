export interface WorkspacePolicy {
  allow_network: boolean;
  allow_file_read: boolean;
  allow_file_write: boolean;
  allow_system: boolean;
  allowed_paths?: string[];
  blocked_paths?: string[];
  max_file_size_kb?: number;
}

export const DEFAULT_WORKSPACE_POLICY: WorkspacePolicy = {
  allow_network: true,
  allow_file_read: true,
  allow_file_write: true,
  allow_system: false,
};

export function createWorkspacePolicy(opts?: Partial<WorkspacePolicy>): WorkspacePolicy {
  return {
    ...DEFAULT_WORKSPACE_POLICY,
    ...(opts || {}),
  };
}

export function isPathAllowed(policy: WorkspacePolicy, path: string): boolean {
  if (policy.blocked_paths) {
    for (const blocked of policy.blocked_paths) {
      if (path.startsWith(blocked) || path.match(new RegExp(blocked))) {
        return false;
      }
    }
  }
  if (policy.allowed_paths) {
    for (const allowed of policy.allowed_paths) {
      if (path.startsWith(allowed) || path.match(new RegExp(allowed))) {
        return true;
      }
    }
    return false;
  }
  return true;
}

export function isNetworkAllowed(policy: WorkspacePolicy): boolean {
  return policy.allow_network;
}

export function isFileReadAllowed(policy: WorkspacePolicy): boolean {
  return policy.allow_file_read;
}

export function isFileWriteAllowed(policy: WorkspacePolicy): boolean {
  return policy.allow_file_write;
}

export function isSystemAllowed(policy: WorkspacePolicy): boolean {
  return policy.allow_system;
}