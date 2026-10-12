export type WsEventType =
  | "game.updated"
  | "match.seat-ended"
  | "match.finished"
  | "rating.updated"
  | "bot.progress"
  | "bot.finished"
  | "server.recovering";

/** `sequence` is the resource's committed revision/sequence; clients ignore sequence <= last seen. */
export type WsEnvelope<T = unknown> = {
  protocolVersion: 1;
  type: WsEventType;
  resourceId: string;
  sequence: number;
  payload: T;
};

export type WsClientMessage =
  | { type: "subscribe"; resourceId: string; lastSequence: number }
  | { type: "unsubscribe"; resourceId: string }
  | { type: "pong" };
