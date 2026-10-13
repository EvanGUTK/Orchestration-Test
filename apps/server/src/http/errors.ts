import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ERROR_HTTP_STATUS, type ApiError, type ErrorCode } from "@g2048/contracts";
import { DbBusyError } from "@g2048/database";
import { isEngineError } from "@g2048/engine";
import { CompetitionError } from "@g2048/competition";

/** A typed, client-safe failure. `message` and `details` are sent to the client verbatim. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly headers: Record<string, string>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export function envelope(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): ApiError {
  return { error: details ? { code, message, requestId, details } : { code, message, requestId } };
}

export function sendError(reply: FastifyReply, request: FastifyRequest, error: AppError): FastifyReply {
  for (const [name, value] of Object.entries(error.headers)) void reply.header(name, value);
  return reply
    .code(ERROR_HTTP_STATUS[error.code])
    .send(envelope(error.code, error.message, request.id, error.details));
}

/** Converts any thrown value into an AppError without leaking internals. */
export function toAppError(error: unknown): AppError | null {
  if (error instanceof AppError) return error;
  if (error instanceof DbBusyError) {
    return new AppError("DB_BUSY", "The database is busy; retry shortly", undefined, { "retry-after": "1" });
  }
  if (error instanceof CompetitionError) {
    // Rule violations from the pure competition reducers (e.g. ATTEMPT_CONSUMED, CHALLENGE_CLOSED).
    return error.code === "VALIDATION_ERROR"
      ? new AppError("VALIDATION_ERROR", error.message)
      : new AppError("FORBIDDEN", error.message, { reason: error.code });
  }
  if (isEngineError(error)) {
    switch (error.code) {
      case "RESOURCE_LIMIT":
        return new AppError(
          "RESOURCE_LIMIT",
          "That move would exceed the supported tile size; the game was not changed",
        );
      case "GAME_NOT_ACTIVE":
        return new AppError("FORBIDDEN", "Game is not active");
      case "REPLAY_VERSION_UNSUPPORTED":
        return new AppError(
          "REPLAY_VERSION_UNSUPPORTED",
          "This game was saved by an unsupported engine version",
        );
      default:
        return null; // engine VALIDATION_ERROR on stored data is a server-side integrity problem (500)
    }
  }
  const fastifyError = error as Partial<FastifyError>;
  switch (fastifyError.code) {
    case "FST_ERR_CTP_BODY_TOO_LARGE":
      return new AppError("VALIDATION_ERROR", "Request body too large");
    case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
      return new AppError("VALIDATION_ERROR", "Unsupported content type; send application/json");
    case "FST_ERR_CTP_EMPTY_JSON_BODY":
    case "FST_ERR_CTP_INVALID_JSON_BODY":
      return new AppError("VALIDATION_ERROR", "Malformed JSON body");
    default:
      break;
  }
  if (
    typeof fastifyError.statusCode === "number" &&
    fastifyError.statusCode >= 400 &&
    fastifyError.statusCode < 500
  ) {
    return new AppError("VALIDATION_ERROR", "Invalid request");
  }
  return null;
}

type Issue = { path: readonly PropertyKey[]; message: string };
type SafeParser<T> = {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: readonly Issue[] } };
};

/** Validates with a contracts (zod) schema; failures become VALIDATION_ERROR with field paths only. */
export function parseWith<T>(schema: SafeParser<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new AppError("VALIDATION_ERROR", "Request validation failed", {
    issues: result.error.issues.slice(0, 20).map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  });
}

/** Installs the JSON error envelope for all errors and unknown API routes. No stack traces. */
export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const known = toAppError(error);
    if (known) {
      if (known.code === "DB_BUSY") request.log.warn({ code: known.code }, "database busy");
      return sendError(reply, request, known);
    }
    request.log.error({ err: error }, "unhandled error");
    return sendError(reply, request, new AppError("INTERNAL_ERROR", "Internal server error"));
  });
}

export function apiNotFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return sendError(reply, request, new AppError("NOT_FOUND", "Not found"));
}

/**
 * Route-level handler for replay imports: body-parsing failures (oversize, malformed JSON, wrong
 * content type) are reported as IMPORT_INVALID so the client gets an actionable, typed rejection.
 */
export function importErrorHandler(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const code = (error as Partial<FastifyError>).code ?? "";
  if (error instanceof RangeError) {
    // e.g. pathologically nested JSON: a client error, never a 500.
    return sendError(reply, request, new AppError("IMPORT_INVALID", "Replay file is too deeply nested"));
  }
  if (code.startsWith("FST_ERR_CTP_")) {
    const message =
      code === "FST_ERR_CTP_BODY_TOO_LARGE" ? "Replay file is too large" : "Replay file is not valid JSON";
    return sendError(reply, request, new AppError("IMPORT_INVALID", message));
  }
  const known = toAppError(error);
  if (known) return sendError(reply, request, known);
  request.log.error({ err: error }, "unhandled error");
  return sendError(reply, request, new AppError("INTERNAL_ERROR", "Internal server error"));
}
