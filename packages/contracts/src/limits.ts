/** Documented operational limits (ARCHITECTURE "size/timeout limits"). */
export const LIMITS = {
  requestBodyBytes: 64 * 1024,
  replayImportBytes: 5 * 1024 * 1024,
  replayMaxMoves: 200_000,
  eventsPageMax: 500,
  listPageMax: 100,
  undoHistoryMax: 100,
  /** RESOURCE_LIMIT guard: no tile above this exponent is created; current state is preserved. */
  maxExponent: 1_000_000,
  wsMaxSubscriptions: 32,
  wsOutboundQueueMax: 256,
  wsHeartbeatMs: 15_000,
  loginAttemptsPerWindow: 5,
  loginWindowMs: 60_000,
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
  botNodeBudgetMax: 5_000_000,
  botTimeBudgetMsMax: 10_000,
  concurrentBotRunsMax: 8,
  dbWriterQueueMax: 1_000,
} as const;

export const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/; // after ASCII-lowercase normalization
export const DISPLAY_NAME_MIN = 1; // Unicode code points
export const DISPLAY_NAME_MAX = 48;
export const PASSWORD_MIN = 12; // Unicode code points
export const PASSWORD_MAX = 128;
export const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
export const EXPONENT_PATTERN = /^[1-9][0-9]*$/;
