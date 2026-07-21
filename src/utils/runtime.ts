export const EMPTY_FINAL_RESPONSE_MESSAGE = 
  '[No response generated. The model may have returned empty content.]';

export function buildBudgetExhaustedFinalizationMessage(): string {
  return EMPTY_FINAL_RESPONSE_MESSAGE;
}

export function buildFinalizationRetryMessage(): string {
  return 'Let me try again to complete the response.';
}

export function buildGoalContinueMessage(): string {
  return 'Continue working toward the goal. What is your next step?';
}

export function buildLengthRecoveryMessage(): string {
  return 'The conversation was truncated. Please summarize what we know and continue.';
}

export function repeatedExternalLookupError(): string {
  return 'External lookup repeatedly failed. Please try a different approach.';
}

export function repeatedWorkspaceViolationError(): string {
  return 'Workspace access denied. Please work within the allowed workspace directory.';
}
