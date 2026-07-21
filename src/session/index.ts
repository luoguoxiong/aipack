export { SessionManager, SessionStore } from './manager.js';
export type { Session, SessionMessage } from './manager.js';
export { UNIFIED_SESSION_KEY } from './manager.js';

export { sessionKeyForChannel } from './keys.js';

export {
  GOAL_STATE_KEY,
  GOAL_COMMAND,
  MAX_GOAL_OBJECTIVE_CHARS,
  discardLegacyGoalStateKey,
  goalStateRaw,
  sustainedGoalActive,
  explicitGoalRequested,
  sustainedGoalTurn,
  parseGoalState,
  goalStateRuntimeLines,
  goalStateWsBlob,
  runnerWallLLMTimeoutS,
} from './goal_state.js';

export { HIDDEN_HISTORY_META, isHiddenHistoryMessage } from './history_visibility.js';

export {
  INTERNAL_CONTINUATION_META,
  INTERNAL_CONTINUATION_KIND_META,
  INTERNAL_CONTINUATION_PENDING_META,
  INTERNAL_CONTINUATION_RUN_STARTED_AT_META,
  SKIP_USER_PERSIST_META,
  internalContinuationInbound,
  internalContinuationPending,
  internalContinuationRunStartedAt,
  shouldPersistUserMessage,
  shouldStreamBudgetResponse,
  shouldFinalizeOnMaxIterations,
  maybeContinueTurn,
  prepareSaveBoundary,
  clearInternalContinuationState,
  resetGoalContinuationRounds,
} from './turn_continuation.js';
