import { DomainError, compareDecimal, isDecimal, isExponent } from "@2048/contracts";
import type { Decimal, Exponent, MatchKind, MatchOutcome, MatchStatus } from "@2048/contracts";
import { resolveDuel } from "./duel.ts";
import type { DuelDecidedBy, DuelSeat, SeatTerminalReason } from "./duel.ts";
import { rateMatch } from "./elo.ts";
import type { RateMatchInput } from "./elo.ts";
import type { RatingEvent } from "@2048/contracts";

export type SeatSlot = {
  seat: 0 | 1;
  kind: "human" | "bot";
  /** Account id for humans; null for bots. */
  accountId: string | null;
  /** Display label for bots (strategy/version); null for humans. */
  botLabel: string | null;
  gameId: string | null;
  acceptedMoves: number;
  game: DuelSeat;
};

export type MatchState = {
  id: string;
  kind: MatchKind;
  seasonId: string;
  rulesetVersion: string;
  status: MatchStatus;
  seats: [SeatSlot, SeatSlot | null];
  outcome: MatchOutcome | null;
  decidedBy: DuelDecidedBy | null;
  /** true iff this match may ever produce Elo: finished human-vs-human only. */
  ratable: boolean;
  /** Set by the `rated` event after rating events were persisted; prevents a second rating. */
  rated: boolean;
};

export type MatchEvent =
  | { type: "join"; accountId: string; gameId?: string | null }
  | { type: "attach-game"; seat: 0 | 1; gameId: string }
  | { type: "progress"; seat: 0 | 1; score: Decimal; maxExponent: Exponent; acceptedMoves: number }
  | { type: "seat-ended"; seat: 0 | 1; reason: Exclude<SeatTerminalReason, "forfeit">; score: Decimal; maxExponent: Exponent; acceptedMoves: number }
  | { type: "forfeit"; seat: 0 | 1 }
  | { type: "rated" };

export type CreateMatchInput = {
  id: string;
  kind: MatchKind;
  seasonId: string;
  rulesetVersion: string;
  /** Host account (human-vs-human and human-vs-bot). */
  hostAccountId?: string;
  /** Bot labels: seat 1 for human-vs-bot; both seats for bot-vs-bot. */
  botLabels?: string[];
};

const ZERO_SEAT_GAME: DuelSeat = { terminalReason: null, score: "0", maxExponent: "0" };

function humanSeat(seat: 0 | 1, accountId: string): SeatSlot {
  return { seat, kind: "human", accountId, botLabel: null, gameId: null, acceptedMoves: 0, game: ZERO_SEAT_GAME };
}
function botSeat(seat: 0 | 1, label: string): SeatSlot {
  return { seat, kind: "bot", accountId: null, botLabel: label, gameId: null, acceptedMoves: 0, game: ZERO_SEAT_GAME };
}

export function createMatch(input: CreateMatchInput): MatchState {
  const base = { id: input.id, kind: input.kind, seasonId: input.seasonId, rulesetVersion: input.rulesetVersion, outcome: null, decidedBy: null, rated: false } as const;
  if (input.kind === "human-vs-human") {
    if (!input.hostAccountId) throw new DomainError("VALIDATION_ERROR", "host account required");
    return { ...base, status: "lobby", seats: [humanSeat(0, input.hostAccountId), null], ratable: true };
  }
  if (input.kind === "human-vs-bot") {
    const label = input.botLabels?.[0];
    if (!input.hostAccountId || !label) throw new DomainError("VALIDATION_ERROR", "host account and one bot label required");
    return { ...base, status: "active", seats: [humanSeat(0, input.hostAccountId), botSeat(1, label)], ratable: false };
  }
  const [a, b] = input.botLabels ?? [];
  if (!a || !b) throw new DomainError("VALIDATION_ERROR", "two bot labels required");
  return { ...base, status: "active", seats: [botSeat(0, a), botSeat(1, b)], ratable: false };
}

export function seatForAccount(state: MatchState, accountId: string): 0 | 1 | null {
  if (state.seats[0].accountId === accountId) return 0;
  if (state.seats[1]?.accountId === accountId) return 1;
  return null;
}

function seatOf(state: MatchState, seat: 0 | 1): SeatSlot {
  const slot = state.seats[seat];
  if (!slot) throw new DomainError("FORBIDDEN", "seat is not occupied");
  return slot;
}

function withSeat(state: MatchState, seat: 0 | 1, slot: SeatSlot): MatchState {
  return { ...state, seats: seat === 0 ? [slot, state.seats[1]] : [state.seats[0], slot] };
}

function validateSeatFacts(score: Decimal, maxExponent: Exponent, acceptedMoves: number): void {
  if (!isDecimal(score) || !isExponent(maxExponent) || !Number.isSafeInteger(acceptedMoves) || acceptedMoves < 0) {
    throw new DomainError("VALIDATION_ERROR", "invalid seat score, exponent or move count");
  }
}

function finalizeIfDone(state: MatchState): MatchState {
  const s1 = state.seats[1];
  if (state.status !== "active" || !s1) return state;
  const res = resolveDuel(state.seats[0].game, s1.game);
  if (res.status === "pending") return state;
  return { ...state, status: "finished", outcome: res.outcome, decidedBy: res.decidedBy };
}

/**
 * Pure match/seat state machine. Returns the SAME object for exact duplicates (idempotent redelivery /
 * restart replays) and throws DomainError for illegal transitions. Never consults a clock: an absent
 * participant keeps the match pending until an explicit `forfeit`.
 */
export function reduceMatch(state: MatchState, event: MatchEvent): MatchState {
  switch (event.type) {
    case "join": {
      if (state.kind !== "human-vs-human") throw new DomainError("FORBIDDEN", "only human-vs-human lobbies accept joins");
      if (state.seats[1]) {
        if (state.seats[1].accountId === event.accountId) return state; // idempotent re-join
        throw new DomainError("FORBIDDEN", "no free seat");
      }
      if (state.status !== "lobby") throw new DomainError("FORBIDDEN", "match is not in the lobby");
      if (state.seats[0].accountId === event.accountId) throw new DomainError("FORBIDDEN", "cannot join your own match");
      const slot = { ...humanSeat(1, event.accountId), gameId: event.gameId ?? null };
      return { ...state, status: "active", seats: [state.seats[0], slot] };
    }
    case "attach-game": {
      const slot = seatOf(state, event.seat);
      if (slot.gameId === event.gameId) return state;
      if (slot.gameId !== null) throw new DomainError("FORBIDDEN", "seat already has a game");
      return withSeat(state, event.seat, { ...slot, gameId: event.gameId });
    }
    case "progress": {
      if (state.status !== "active") throw new DomainError("FORBIDDEN", "match is not active");
      const slot = seatOf(state, event.seat);
      if (slot.game.terminalReason !== null) throw new DomainError("FORBIDDEN", "seat already ended");
      validateSeatFacts(event.score, event.maxExponent, event.acceptedMoves);
      if (event.acceptedMoves < slot.acceptedMoves || compareDecimal(event.score, slot.game.score) < 0 || compareDecimal(event.maxExponent, slot.game.maxExponent) < 0) {
        throw new DomainError("REVISION_CONFLICT", "seat progress cannot regress");
      }
      if (event.acceptedMoves === slot.acceptedMoves && event.score === slot.game.score && event.maxExponent === slot.game.maxExponent) return state;
      return withSeat(state, event.seat, { ...slot, acceptedMoves: event.acceptedMoves, game: { terminalReason: null, score: event.score, maxExponent: event.maxExponent } });
    }
    case "seat-ended": {
      if (state.status === "lobby") throw new DomainError("FORBIDDEN", "match has not started");
      const slot = seatOf(state, event.seat);
      validateSeatFacts(event.score, event.maxExponent, event.acceptedMoves);
      if (slot.game.terminalReason !== null) {
        if (slot.game.terminalReason === event.reason && slot.game.score === event.score && slot.game.maxExponent === event.maxExponent && slot.acceptedMoves === event.acceptedMoves) return state;
        throw new DomainError("FORBIDDEN", "seat already ended with a different result");
      }
      if (event.acceptedMoves < slot.acceptedMoves || compareDecimal(event.score, slot.game.score) < 0) {
        throw new DomainError("REVISION_CONFLICT", "seat result cannot regress");
      }
      const next = withSeat(state, event.seat, { ...slot, acceptedMoves: event.acceptedMoves, game: { terminalReason: event.reason, score: event.score, maxExponent: event.maxExponent } });
      return finalizeIfDone(next);
    }
    case "forfeit": {
      if (state.status === "lobby") throw new DomainError("FORBIDDEN", "cannot forfeit before the match starts");
      const slot = seatOf(state, event.seat);
      if (slot.game.terminalReason !== null) return state; // exactly once; also a no-op after a natural end
      const next = withSeat(state, event.seat, { ...slot, game: { ...slot.game, terminalReason: "forfeit" } });
      return finalizeIfDone(next);
    }
    case "rated": {
      if (!canRate(state)) {
        if (state.rated) return state;
        throw new DomainError("FORBIDDEN", "match is not ratable");
      }
      return { ...state, rated: true };
    }
  }
}

/** True only for a finished, human-vs-human match with two distinct accounts that has not been rated yet. */
export function canRate(state: MatchState): boolean {
  const s1 = state.seats[1];
  return (
    state.status === "finished" &&
    state.ratable &&
    !state.rated &&
    state.outcome !== null &&
    s1 !== null &&
    state.seats[0].accountId !== null &&
    s1.accountId !== null &&
    state.seats[0].accountId !== s1.accountId
  );
}

/** Rating events for a rate-able match given the current ratings, or null when it must not be rated (bots, unfinished, already rated). */
export function ratingEventsFor(state: MatchState, ratings: { seat0: number; seat1: number }): [RatingEvent, RatingEvent] | null {
  if (!canRate(state)) return null;
  const s1 = state.seats[1]!;
  const input: RateMatchInput = {
    matchId: state.id,
    seasonId: state.seasonId,
    rulesetVersion: state.rulesetVersion,
    seat0: { accountId: state.seats[0].accountId!, rating: ratings.seat0 },
    seat1: { accountId: s1.accountId!, rating: ratings.seat1 },
    outcome: state.outcome!,
  };
  return rateMatch(input);
}
