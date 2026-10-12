import type { Decimal, Direction, DomainEvent, GameMode, GameState, Ruleset } from "@g2048/contracts";

/** A running game as the UI sees it. `state` is always the authoritative GameState. */
export type GameSession = {
  readonly id: string;
  readonly mode: GameMode;
  readonly rules: Ruleset;
  /** Seed shown to the player for casual/practice games; null when the authority hides it. */
  readonly seed: string | null;
  readonly state: GameState;
  /** Number of undo steps currently available (0 when the ruleset forbids undo). */
  readonly undoDepth: number;
};

export type MoveOutcome =
  | {
      readonly ok: true;
      readonly session: GameSession;
      readonly changed: boolean;
      readonly scoreDelta: Decimal;
      readonly events: readonly DomainEvent[];
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

export type StartRequest = {
  readonly mode: GameMode;
  readonly rules: Ruleset;
  /** Optional explicit seed (practice). The adapter generates one when absent. */
  readonly seed?: string | undefined;
};

/**
 * Where moves are applied. FRONTEND-001 ships the local (guest, offline) implementation backed by the
 * pure engine; FRONTEND-002 adds a server implementation (authoritative moves with commandId +
 * expectedRevision). Every method resolves in call order; the MoveQueue never calls `move` concurrently.
 */
export interface GameAdapter {
  readonly kind: "local" | "server";
  current(): GameSession | null;
  start(request: StartRequest): Promise<GameSession>;
  move(direction: Direction): Promise<MoveOutcome>;
  undo(): Promise<GameSession | null>;
  /** Removes the current game (and its local save). */
  discard(): Promise<void>;
}
