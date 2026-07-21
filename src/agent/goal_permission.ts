const _GOAL_MUTATION_ALLOWED_KEY = 'nanobot_goal_mutation_allowed';

let _goalMutationAllowed = false;

export function goalMutationAllowed(): boolean {
  return _goalMutationAllowed;
}

export function revokeGoalMutationPermission(): void {
  _goalMutationAllowed = false;
}

export function withGoalMutationPermission<T>(
  allowed: boolean,
  fn: () => T,
): T {
  const previous = _goalMutationAllowed;
  _goalMutationAllowed = allowed;
  try {
    return fn();
  } finally {
    _goalMutationAllowed = previous;
  }
}

export async function withGoalMutationPermissionAsync<T>(
  allowed: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = _goalMutationAllowed;
  _goalMutationAllowed = allowed;
  try {
    return await fn();
  } finally {
    _goalMutationAllowed = previous;
  }
}
