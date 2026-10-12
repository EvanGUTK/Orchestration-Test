import { DomainError, ERROR_HTTP_STATUS, type ApiError, type ErrorCode } from "@2048/contracts";

export { DomainError };

export function httpStatusFor(code: ErrorCode): number {
  return ERROR_HTTP_STATUS[code];
}

export function envelope(code: ErrorCode, message: string, requestId: string, details?: unknown): ApiError {
  return { error: { code, message, requestId, ...(details === undefined ? {} : { details }) } };
}

export const unauthenticated = (message = "Authentication required") => new DomainError("UNAUTHENTICATED", message);
export const forbidden = (message: string, details?: unknown) => new DomainError("FORBIDDEN", message, details);
export const notFound = (message = "Not found") => new DomainError("NOT_FOUND", message);
export const validation = (message: string, details?: unknown) => new DomainError("VALIDATION_ERROR", message, details);
