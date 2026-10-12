export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "REVISION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "NO_CHANGE",
  "RATE_LIMITED",
  "DB_BUSY",
  "RESOURCE_LIMIT",
  "REPLAY_VERSION_UNSUPPORTED",
  "IMPORT_INVALID",
  "INTERNAL_ERROR",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  IMPORT_INVALID: 400,
  REPLAY_VERSION_UNSUPPORTED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  NO_CHANGE: 200, // a valid no-op is 200 with changed:false; the code exists for engine/service typing
  RATE_LIMITED: 429,
  DB_BUSY: 503,
  RESOURCE_LIMIT: 503,
  INTERNAL_ERROR: 500,
};

export type ApiError = {
  error: { code: ErrorCode; message: string; requestId: string; details?: unknown };
};

/** Typed engine/service failure. Engine functions throw this for malformed input; never for no-ops. */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}
