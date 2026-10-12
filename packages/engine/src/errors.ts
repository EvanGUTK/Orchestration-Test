import type { EngineErrorCode } from "@g2048/contracts";

/** Typed engine failure. Engine functions never throw raw errors for invalid input. */
export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}

export function isEngineError(value: unknown): value is EngineError {
  return value instanceof EngineError;
}

/** Shorthand for VALIDATION_ERROR. */
export function invalid(message: string): EngineError {
  return new EngineError("VALIDATION_ERROR", message);
}
