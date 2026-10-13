import type { WsEventType } from "@g2048/contracts";
import type { DatabaseWriter } from "@g2048/database";

/** A committed domain change, in the shape of the WebSocket envelope minus `protocolVersion`. */
export type CommittedEvent = {
  type: WsEventType;
  resourceId: string;
  /** Per-resource sequence (game revision / match sequence); consumers drop sequence <= last seen. */
  sequence: number;
  payload: unknown;
};

export type EventListener = (event: CommittedEvent) => void;

/**
 * In-process publish/subscribe for committed changes (ARCHITECTURE: "Commit before sending a socket
 * event"). Producers call `publishAfterCommit` INSIDE a writer job; the event is delivered only if that
 * transaction commits, after COMMIT, in commit order. The realtime hub (apps/server/src/realtime)
 * subscribes and fans out to sockets. Listener errors are isolated.
 */
export class EventBus {
  readonly #writer: DatabaseWriter;
  readonly #listeners = new Set<EventListener>();

  constructor(writer: DatabaseWriter) {
    this.#writer = writer;
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Queue `event` for delivery after the current writer transaction commits (throws outside a job). */
  publishAfterCommit(event: CommittedEvent): void {
    this.#writer.afterCommit(() => this.#deliver(event));
  }

  /** For events that are not tied to a database write (e.g. `server.recovering`). */
  publishNow(event: CommittedEvent): void {
    this.#deliver(event);
  }

  #deliver(event: CommittedEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // a broken subscriber never affects producers or other subscribers
      }
    }
  }
}
