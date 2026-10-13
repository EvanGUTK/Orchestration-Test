import type { Decimal, Direction, DomainEvent, GameMode, GameState, Ruleset } from "@g2048/contracts";

/** A running game as the UI sees it. `state` is always the authoritative GameState. */
export type GameSession = {
  readonly id: string;
  readonly mode: GameMode;
  readonly rules: Ruleset;
  /** Seed shown to the player for casual/practice games; null when the authority hides it. */
  readonly seed: string | null;
  readonly state: GameState;
  /** Whether an undo is currently possible. */
  readonly canUndo: boolean;
  /** Undo steps available when known locally; null when the server manages history. */
  readonly undoDepth: number | null;
  /** Where the authoritative state lives. */
  readonly authority: "local" | "server";
};

export type MoveFailure = {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  /**
   * True when the move may still be pending (connection lost / server busy after retries). The adapter
   * keeps the command and its commandId; calling `move` again with the same direction re-sends it
   * idempotently, so a lost response can never double-apply.
   */
  readonly retryable?: boolean;
  readonly requestId?: string | null;
};

export type MoveOutcome =
  | {
      readonly ok: true;
      readonly session: GameSession;
      readonly changed: boolean;
      readonly scoreDelta: Decimal;
      readonly events: readonly DomainEvent[];
    }
  | MoveFailure;

export type StartRequest = {
  readonly mode: GameMode;
  readonly rules: Ruleset;
  /** Optional explicit seed (practice). The adapter generates one when absent. */
  readonly seed?: string | undefined;
};

/**
 * Where moves are applied: locally with the pure engine (guest, offline) or on the local server
 * (accounts; authoritative moves with commandId + expectedRevision). The MoveQueue never calls `move`
 * concurrently, and each method resolves in call order.
 */
export interface GameAdapter {
  readonly kind: "local" | "server";
  current(): GameSession | null;
  start(request: StartRequest): Promise<GameSession>;
  move(direction: Direction): Promise<MoveOutcome>;
  /** Returns the restored session, or null when there is nothing to undo. May throw transport errors. */
  undo(): Promise<GameSession | null>;
  /** Ends the current game (status "forfeited"). */
  forfeit(): Promise<GameSession | null>;
  /** Re-reads the authoritative state and drops any unresolved command (it is reflected in the state). */
  reload(): Promise<GameSession | null>;
  /** Detaches the current game (and removes a local guest save). Server games stay resumable. */
  discard(): Promise<void>;
  /** Local games: what is needed to build a ReplayFile (initial state + accepted final-path moves). */
  replayData?(): ReplayData | null;
}

export type ReplayData = {
  readonly mode: GameMode;
  readonly rules: Ruleset;
  readonly seed: string;
  readonly initial: GameState;
  readonly moves: readonly Direction[];
};
