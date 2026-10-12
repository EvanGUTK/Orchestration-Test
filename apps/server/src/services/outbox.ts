import { WS_PROTOCOL_VERSION, type WsEnvelope, type WsEventType } from "@2048/contracts";

/**
 * Realtime events produced inside a database transaction. They are published ONLY after the transaction
 * commits (a rolled-back command never reaches a socket), carrying the committed sequence.
 */
export type Publication = {
  envelope: WsEnvelope;
  /** Account ids that receive the event even without an explicit subscription (match seats, rating owner). */
  accounts?: string[];
};

export class Outbox {
  readonly items: Publication[] = [];

  push<T>(type: WsEventType, resourceId: string, sequence: number, payload: T, accounts?: string[]): void {
    this.items.push({
      envelope: { protocolVersion: WS_PROTOCOL_VERSION, type, resourceId, sequence, payload },
      ...(accounts && accounts.length ? { accounts } : {}),
    });
  }
}

export type Publisher = (items: readonly Publication[]) => void;
