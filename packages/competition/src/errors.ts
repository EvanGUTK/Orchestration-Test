/**
 * Typed competition-rule failures. Reducers and helpers never throw raw errors for
 * invalid input or invalid transitions; the backend maps these codes to API errors
 * (VALIDATION_ERROR -> 400; transition/state conflicts -> 409; NOT_A_PARTICIPANT -> 403).
 */
export type CompetitionErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_TRANSITION"
  | "SEAT_OCCUPIED"
  | "SAME_ACCOUNT"
  | "PARTICIPANT_KIND_MISMATCH"
  | "SEAT_ALREADY_TERMINAL"
  | "MATCH_NOT_READY"
  | "MATCH_ALREADY_FINISHED"
  | "RATINGS_REQUIRED"
  | "RATINGS_FORBIDDEN"
  | "ATTEMPT_CONSUMED"
  | "NO_ATTEMPT"
  | "CHALLENGE_CLOSED"
  | "SEASON_EXISTS"
  | "SEASON_NOT_ACTIVE"
  | "RATING_STALE";

export class CompetitionError extends Error {
  readonly code: CompetitionErrorCode;

  constructor(code: CompetitionErrorCode, message: string) {
    super(message);
    this.name = "CompetitionError";
    this.code = code;
  }
}

export function fail(code: CompetitionErrorCode, message: string): never {
  throw new CompetitionError(code, message);
}

export function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    fail("VALIDATION_ERROR", `${field} must be a non-empty string of at most 128 characters`);
  }
  return value;
}
