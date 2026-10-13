import type { DatabaseSync } from "node:sqlite";
import type { WsEventType } from "@g2048/contracts";
import type { CatchUp } from "../realtime/hub.js";
import { matchesRepo } from "./repo.js";

export type MatchEvent = { sequence: number; type: WsEventType; payload: unknown };

/**
 * Per-match event log for WebSocket catch-up by sequence (match_events, migration 4). Events are
 * written in the same transaction as the state change, so a reconnecting client (also after a
 * server restart) receives exactly the events after its lastSequence. A gap larger than the
 * catch-up limit is answered with `server.recovering`; the client then refetches GET /matches/:id.
 */
export class MatchEventLog {
  /** Inside the writer transaction. */
  append(db: DatabaseSync, matchId: string, event: MatchEvent, now: string): void {
    matchesRepo.insertMatchEvent(db, { matchId, ...event, now });
  }

  catchUp(db: DatabaseSync, matchId: string, lastSequence: number, limit: number): CatchUp {
    const current = matchesRepo.get(db, matchId)?.sequence ?? 0;
    if (lastSequence >= current) return { kind: "events", events: [] };
    if (current - lastSequence > limit) return { kind: "resync" };
    const events = matchesRepo.matchEventsAfter(db, matchId, lastSequence, limit);
    // Every sequence from lastSequence+1 to current must be present; otherwise resync.
    if (events.length !== current - lastSequence || events[0]?.sequence !== lastSequence + 1) {
      return { kind: "resync" };
    }
    return {
      kind: "events",
      events: events.map((e) => ({
        resource: "match" as const,
        resourceId: matchId,
        type: e.type as WsEventType,
        sequence: e.sequence,
        payload: e.payload,
      })),
    };
  }
}
