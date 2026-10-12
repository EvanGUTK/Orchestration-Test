import { z } from "zod";
import type { PROTOCOL_VERSION } from "./versions.js";

export const WS_PATH = "/api/v1/events";
export const WS_EVENT_TYPES = [
  "game.updated",
  "match.seat-ended",
  "match.finished",
  "rating.updated",
  "bot.progress",
  "bot.finished",
  "server.recovering",
] as const;
export type WsEventType = (typeof WS_EVENT_TYPES)[number];

/** Server to client. sequence is per resource (game revision / match sequence); clients drop sequence at or below last seen. */
export type WsEnvelope<P = unknown> = {
  protocolVersion: typeof PROTOCOL_VERSION;
  type: WsEventType;
  resourceId: string;
  sequence: number;
  payload: P;
};

/** Client to server messages. */
export const WsClientMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe"),
    resource: z.enum(["game", "match", "bot-run"]),
    resourceId: z.string().min(1).max(64),
    lastSequence: z.number().int().min(0),
  }),
  z.object({ type: z.literal("unsubscribe"), resourceId: z.string().min(1).max(64) }),
  z.object({ type: z.literal("ping") }),
]);
export type WsClientMessage = z.infer<typeof WsClientMessage>;
