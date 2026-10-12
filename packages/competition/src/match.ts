import { BOT_STRATEGIES, ELO_ALGORITHM_VERSION, RULESETS } from "@g2048/contracts";
import type {
  BotStrategy,
  Decimal,
  DuelOutcome,
  Exponent,
  MatchKind,
  MatchStatus,
  RatingEvent,
  SeatId,
  SeatResult,
  SeatTerminalReason,
} from "@g2048/contracts";
import { assertDecimal, assertExponentOrNull, compareDecimal, compareExponent } from "./decimal.js";
import { decideDuel, duelOutcomeScores } from "./duel.js";
import { eloDelta } from "./elo.js";
import { fail, requireId } from "./errors.js";

/**
 * Pure duel/match lifecycle reducer.
 *
 *   lobby --join(second participant)--> active --seat-terminal(a), seat-terminal(b)--> active (both terminal)
 *         --finish--> finished                       lobby --abandon-lobby--> abandoned-lobby
 *
 * - Each seat becomes terminal exactly once (move-cap / dead-board / forfeit). One seat's dead
 *   board never ends the other seat: the match stays active until both are terminal.
 * - There is no wall-clock input and no timeout command: an absent participant's seat stays
 *   open until an explicit forfeit, so elapsed time can never award a win.
 * - `finish` succeeds exactly once. Only human-human matches produce RatingEvents (elo-v1,
 *   idempotency key `${matchId}:${accountId}`); human-bot and bot-bot never touch human Elo.
 *   Two finishes computed concurrently from the same base state yield byte-identical rating
 *   events with the same keys, so the rating ledger / DB UNIQUE(match, account) keeps one.
 * Every rejected command throws CompetitionError and leaves the input state untouched.
 */

export type HumanParticipant = { readonly kind: "human"; readonly accountId: string };
export type BotParticipant = {
  readonly kind: "bot";
  readonly strategy: BotStrategy;
  readonly botVersion: string;
};
export type Participant = HumanParticipant | BotParticipant;

export type MatchSeat = {
  readonly participant: Participant | null;
  readonly score: Decimal;
  readonly maxExponent: Exponent | null;
  readonly acceptedMoves: number;
  readonly terminal: SeatTerminalReason | null;
};

export type MatchState = {
  readonly id: string;
  readonly kind: MatchKind;
  readonly season: string;
  readonly rulesetVersion: string;
  readonly moveCap: number;
  readonly status: MatchStatus;
  readonly seats: { readonly a: MatchSeat; readonly b: MatchSeat };
  readonly outcome: DuelOutcome | null;
  readonly ratingEvents: readonly RatingEvent[];
  /** Sequence of the last emitted event (per-match WebSocket sequence). */
  readonly sequence: number;
};

export type CreateMatchInput = {
  readonly id: string;
  readonly kind: MatchKind;
  readonly season: string;
  /** Defaults to duel-v1. */
  readonly rulesetVersion?: string;
  /** Defaults to the duel-v1 move cap (500). */
  readonly moveCap?: number;
  /** Takes seat "a". */
  readonly creator: Participant;
};

export type SeatProgress = {
  readonly seat: SeatId;
  readonly score: Decimal;
  readonly maxExponent: Exponent | null;
  readonly acceptedMoves: number;
};

export type MatchCommand =
  | { readonly type: "join"; readonly participant: Participant; readonly seat?: SeatId }
  | { readonly type: "abandon-lobby" }
  | ({ readonly type: "seat-progress" } & SeatProgress)
  | ({ readonly type: "seat-terminal"; readonly reason: SeatTerminalReason } & SeatProgress)
  | { readonly type: "finish"; readonly ratings?: { readonly a: number; readonly b: number } };

export type MatchEvent =
  | { readonly type: "match.created"; readonly matchId: string; readonly sequence: number }
  | {
      readonly type: "seat.joined";
      readonly matchId: string;
      readonly seat: SeatId;
      readonly participant: Participant;
      readonly sequence: number;
    }
  | { readonly type: "match.started"; readonly matchId: string; readonly sequence: number }
  | { readonly type: "match.abandoned"; readonly matchId: string; readonly sequence: number }
  | {
      readonly type: "seat.progress";
      readonly matchId: string;
      readonly seat: SeatId;
      readonly result: SeatResult;
      readonly acceptedMoves: number;
      readonly sequence: number;
    }
  | {
      readonly type: "seat.ended";
      readonly matchId: string;
      readonly seat: SeatId;
      readonly result: SeatResult;
      readonly acceptedMoves: number;
      /** true when both seats are now terminal and `finish` may be applied. */
      readonly readyToFinish: boolean;
      readonly sequence: number;
    }
  | {
      readonly type: "match.finished";
      readonly matchId: string;
      readonly outcome: DuelOutcome;
      readonly sequence: number;
    }
  | { readonly type: "rating.updated"; readonly rating: RatingEvent; readonly sequence: number };

export type MatchTransition = { readonly state: MatchState; readonly events: readonly MatchEvent[] };

const EMPTY_SEAT: MatchSeat = {
  participant: null,
  score: "0",
  maxExponent: null,
  acceptedMoves: 0,
  terminal: null,
};

export function createMatch(input: CreateMatchInput): MatchTransition {
  const id = requireId(input.id, "id");
  const season = requireId(input.season, "season");
  const rulesetVersion = requireId(input.rulesetVersion ?? RULESETS["duel-v1"].version, "rulesetVersion");
  const moveCap = input.moveCap ?? RULESETS["duel-v1"].moveCap;
  if (!Number.isSafeInteger(moveCap) || moveCap < 1)
    fail("VALIDATION_ERROR", "moveCap must be a positive integer");
  if (input.kind !== "human-human" && input.kind !== "human-bot" && input.kind !== "bot-bot") {
    fail("VALIDATION_ERROR", "unknown match kind");
  }
  const creator = validateParticipant(input.creator);
  if (input.kind === "human-human" && creator.kind !== "human") {
    fail("PARTICIPANT_KIND_MISMATCH", "human-human matches are created by a human");
  }
  if (input.kind === "bot-bot" && creator.kind !== "bot") {
    fail("PARTICIPANT_KIND_MISMATCH", "bot-bot matches seat only bots");
  }
  const state: MatchState = {
    id,
    kind: input.kind,
    season,
    rulesetVersion,
    moveCap,
    status: "lobby",
    seats: { a: { ...EMPTY_SEAT, participant: creator }, b: EMPTY_SEAT },
    outcome: null,
    ratingEvents: [],
    sequence: 2,
  };
  return {
    state,
    events: [
      { type: "match.created", matchId: id, sequence: 1 },
      { type: "seat.joined", matchId: id, seat: "a", participant: creator, sequence: 2 },
    ],
  };
}

export function reduceMatch(state: MatchState, command: MatchCommand): MatchTransition {
  switch (command.type) {
    case "join":
      return join(state, command.participant, command.seat);
    case "abandon-lobby":
      return abandonLobby(state);
    case "seat-progress":
      return seatProgress(state, command);
    case "seat-terminal":
      return seatTerminal(state, command);
    case "finish":
      return finish(state, command.ratings);
    default:
      return fail("VALIDATION_ERROR", "unknown match command");
  }
}

export function seatResult(state: MatchState, seat: SeatId): SeatResult {
  const s = state.seats[seat];
  return { score: s.score, maxExponent: s.maxExponent, terminal: s.terminal };
}

/** Outcome if both seats are terminal, otherwise null (does not change state). */
export function pendingOutcome(state: MatchState): DuelOutcome | null {
  return decideDuel(seatResult(state, "a"), seatResult(state, "b"));
}

export function ratingIdempotencyKey(matchId: string, accountId: string): string {
  return `${matchId}:${accountId}`;
}

function join(
  state: MatchState,
  rawParticipant: Participant,
  requestedSeat: SeatId | undefined,
): MatchTransition {
  if (state.status !== "lobby") fail("INVALID_TRANSITION", `cannot join a match in status ${state.status}`);
  const participant = validateParticipant(rawParticipant);
  const seat: SeatId = requestedSeat ?? (state.seats.a.participant === null ? "a" : "b");
  if (seat !== "a" && seat !== "b") fail("VALIDATION_ERROR", "seat must be a or b");
  if (state.seats[seat].participant !== null) fail("SEAT_OCCUPIED", `seat ${seat} is already occupied`);
  const other = state.seats[otherSeat(seat)].participant;
  if (other === null) fail("INVALID_TRANSITION", "lobby has no creator seat");
  if (other.kind === "human" && participant.kind === "human" && other.accountId === participant.accountId) {
    fail("SAME_ACCOUNT", "the same account cannot take both seats");
  }
  const kinds = [other.kind, participant.kind].sort().join("-");
  const expected =
    state.kind === "human-human" ? "human-human" : state.kind === "bot-bot" ? "bot-bot" : "bot-human";
  if (kinds !== expected)
    fail("PARTICIPANT_KIND_MISMATCH", `a ${participant.kind} cannot join a ${state.kind} match`);
  const seats = { ...state.seats, [seat]: { ...EMPTY_SEAT, participant } };
  const next: MatchState = { ...state, seats, status: "active", sequence: state.sequence + 2 };
  return {
    state: next,
    events: [
      { type: "seat.joined", matchId: state.id, seat, participant, sequence: state.sequence + 1 },
      { type: "match.started", matchId: state.id, sequence: state.sequence + 2 },
    ],
  };
}

function abandonLobby(state: MatchState): MatchTransition {
  if (state.status !== "lobby")
    fail("INVALID_TRANSITION", `cannot abandon a match in status ${state.status}`);
  const sequence = state.sequence + 1;
  return {
    state: { ...state, status: "abandoned-lobby", sequence },
    events: [{ type: "match.abandoned", matchId: state.id, sequence }],
  };
}

function seatProgress(state: MatchState, command: SeatProgress): MatchTransition {
  const seat = validateSeatUpdate(state, command);
  if (command.acceptedMoves >= state.moveCap) {
    fail("VALIDATION_ERROR", "a seat at the move cap is terminal; send seat-terminal with reason move-cap");
  }
  const updated: MatchSeat = { ...seat, ...pickProgress(command) };
  const sequence = state.sequence + 1;
  return {
    state: { ...state, seats: { ...state.seats, [command.seat]: updated }, sequence },
    events: [
      {
        type: "seat.progress",
        matchId: state.id,
        seat: command.seat,
        result: toResult(updated),
        acceptedMoves: updated.acceptedMoves,
        sequence,
      },
    ],
  };
}

function seatTerminal(
  state: MatchState,
  command: SeatProgress & { reason: SeatTerminalReason },
): MatchTransition {
  const seat = validateSeatUpdate(state, command);
  const { reason } = command;
  if (reason !== "move-cap" && reason !== "dead-board" && reason !== "forfeit") {
    fail("VALIDATION_ERROR", "reason must be move-cap, dead-board, or forfeit");
  }
  if (reason === "move-cap" && command.acceptedMoves !== state.moveCap) {
    fail("VALIDATION_ERROR", `move-cap requires exactly ${state.moveCap} accepted moves`);
  }
  const updated: MatchSeat = { ...seat, ...pickProgress(command), terminal: reason };
  const seats = { ...state.seats, [command.seat]: updated };
  const readyToFinish = seats.a.terminal !== null && seats.b.terminal !== null;
  const sequence = state.sequence + 1;
  return {
    state: { ...state, seats, sequence },
    events: [
      {
        type: "seat.ended",
        matchId: state.id,
        seat: command.seat,
        result: toResult(updated),
        acceptedMoves: updated.acceptedMoves,
        readyToFinish,
        sequence,
      },
    ],
  };
}

function finish(
  state: MatchState,
  ratings: { readonly a: number; readonly b: number } | undefined,
): MatchTransition {
  if (state.status === "finished") fail("MATCH_ALREADY_FINISHED", "match is already finished");
  if (state.status !== "active")
    fail("INVALID_TRANSITION", `cannot finish a match in status ${state.status}`);
  const outcome = pendingOutcome(state);
  if (outcome === null) fail("MATCH_NOT_READY", "both seats must be terminal before the match finishes");

  let ratingEvents: RatingEvent[] = [];
  if (state.kind === "human-human") {
    if (ratings === undefined) fail("RATINGS_REQUIRED", "human-human finish requires both current ratings");
    ratingEvents = buildRatingEvents(state, outcome, ratings);
  } else if (ratings !== undefined) {
    fail("RATINGS_FORBIDDEN", `${state.kind} matches never change human Elo`);
  }

  const finishedSeq = state.sequence + 1;
  const events: MatchEvent[] = [
    { type: "match.finished", matchId: state.id, outcome, sequence: finishedSeq },
  ];
  ratingEvents.forEach((rating, i) =>
    events.push({ type: "rating.updated", rating, sequence: finishedSeq + 1 + i }),
  );
  return {
    state: {
      ...state,
      status: "finished",
      outcome,
      ratingEvents,
      sequence: finishedSeq + ratingEvents.length,
    },
    events,
  };
}

function buildRatingEvents(
  state: MatchState,
  outcome: DuelOutcome,
  ratings: { readonly a: number; readonly b: number },
): RatingEvent[] {
  const a = state.seats.a.participant;
  const b = state.seats.b.participant;
  if (a?.kind !== "human" || b?.kind !== "human")
    fail("INVALID_TRANSITION", "rated seats must both be human");
  const scores = duelOutcomeScores(outcome);
  const { deltaA, deltaB } = eloDelta(ratings.a, ratings.b, scores.a);
  const make = (accountId: string, before: number, delta: number, result: 1 | 0.5 | 0): RatingEvent => ({
    matchId: state.id,
    accountId,
    season: state.season,
    rulesetVersion: state.rulesetVersion,
    before,
    after: before + delta,
    delta,
    outcome: result,
    algorithm: ELO_ALGORITHM_VERSION,
    idempotencyKey: ratingIdempotencyKey(state.id, accountId),
  });
  return [make(a.accountId, ratings.a, deltaA, scores.a), make(b.accountId, ratings.b, deltaB, scores.b)];
}

function validateSeatUpdate(state: MatchState, command: SeatProgress): MatchSeat {
  if (state.status !== "active")
    fail("INVALID_TRANSITION", `seat updates require an active match, not ${state.status}`);
  if (command.seat !== "a" && command.seat !== "b") fail("VALIDATION_ERROR", "seat must be a or b");
  const seat = state.seats[command.seat];
  if (seat.terminal !== null) fail("SEAT_ALREADY_TERMINAL", `seat ${command.seat} is already terminal`);
  assertDecimal(command.score, "score");
  assertExponentOrNull(command.maxExponent, "maxExponent");
  const moves = command.acceptedMoves;
  if (!Number.isSafeInteger(moves) || moves < 0 || moves > state.moveCap) {
    fail("VALIDATION_ERROR", `acceptedMoves must be an integer in 0..${state.moveCap}`);
  }
  // Duel rules have no undo, so a seat's progress never goes backwards.
  if (moves < seat.acceptedMoves) fail("VALIDATION_ERROR", "acceptedMoves cannot decrease");
  if (compareDecimal(command.score, seat.score) < 0) fail("VALIDATION_ERROR", "score cannot decrease");
  if (compareExponent(command.maxExponent, seat.maxExponent) < 0) {
    fail("VALIDATION_ERROR", "maxExponent cannot decrease");
  }
  return seat;
}

function pickProgress(command: SeatProgress): Pick<MatchSeat, "score" | "maxExponent" | "acceptedMoves"> {
  return { score: command.score, maxExponent: command.maxExponent, acceptedMoves: command.acceptedMoves };
}

function toResult(seat: MatchSeat): SeatResult {
  return { score: seat.score, maxExponent: seat.maxExponent, terminal: seat.terminal };
}

function otherSeat(seat: SeatId): SeatId {
  return seat === "a" ? "b" : "a";
}

function validateParticipant(p: Participant): Participant {
  if (p === null || typeof p !== "object") fail("VALIDATION_ERROR", "participant is required");
  if (p.kind === "human") return { kind: "human", accountId: requireId(p.accountId, "accountId") };
  if (p.kind === "bot") {
    const strategy = BOT_STRATEGIES.find((known) => known === p.strategy);
    if (strategy === undefined) fail("VALIDATION_ERROR", "unknown bot strategy");
    return {
      kind: "bot",
      strategy,
      botVersion: requireId(p.botVersion, "botVersion"),
    };
  }
  return fail("VALIDATION_ERROR", "participant kind must be human or bot");
}
