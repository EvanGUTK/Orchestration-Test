import { RULESETS } from "@g2048/contracts";
import type {
  BotConfig,
  BotDecision,
  Decimal,
  Direction,
  DuelOutcome,
  Exponent,
  GameState,
  Ruleset,
  SeatTerminalReason,
} from "@g2048/contracts";
import { decideDuel } from "@g2048/competition";
import type { CancelSignal } from "./budget.js";
import {
  BOT_VERSION,
  createChooseMove,
  deriveBotRng,
  difficultyOf,
  validateBotConfig,
} from "./choose-move.js";
import type { EnginePort } from "./engine-port.js";

export type BotGameEnd = "move-cap" | "dead-board" | "max-moves" | "cancelled";

export type BotGameInput = {
  readonly rules: Ruleset;
  readonly config: BotConfig;
  /** Game seed (spawn stream). */
  readonly seed: string;
  /** Bot RNG seed; defaults to `seed` (derived under BOT_SEED_NAMESPACE, so the streams differ). */
  readonly botSeed?: string;
  /** Hard stop when the ruleset has no move cap. Defaults to rules.moveCap ?? 10_000. */
  readonly maxMoves?: number;
  readonly now?: () => number;
  readonly signal?: CancelSignal;
  readonly onMove?: (move: { index: number; decision: BotDecision; state: GameState }) => void;
};

export type BotGameResult = {
  readonly strategy: BotConfig["strategy"];
  readonly botVersion: string;
  readonly difficulty: ReturnType<typeof difficultyOf>;
  readonly config: BotConfig;
  readonly seed: string;
  readonly botSeed: string;
  readonly rulesetVersion: string;
  readonly moves: readonly Direction[];
  readonly end: BotGameEnd;
  readonly finalScore: Decimal;
  readonly maxExponent: Exponent | null;
  readonly acceptedMoves: number;
  readonly nodesSearched: number;
  readonly fallbackMoves: number;
  readonly finalState: GameState;
};

/**
 * Plays one complete single-seat bot game synchronously with the real engine transition.
 * Without `now` the game is a pure function of (rules, config, seed, botSeed): BOT-04.
 */
export function playBotGame(port: EnginePort, input: BotGameInput): BotGameResult {
  const config = validateBotConfig(input.config);
  const chooseMove = createChooseMove(port);
  const botSeed = input.botSeed ?? input.seed;
  const maxMoves = input.maxMoves ?? input.rules.moveCap ?? 10_000;
  let state = port.newGame(input.rules, input.seed);
  let rng = deriveBotRng(port, botSeed);
  const moves: Direction[] = [];
  let nodes = 0;
  let fallbacks = 0;
  let end: BotGameEnd | null = null;

  while (end === null) {
    if (state.status !== "active") {
      end =
        input.rules.moveCap !== null && state.acceptedMoves >= input.rules.moveCap
          ? "move-cap"
          : "dead-board";
      break;
    }
    if (moves.length >= maxMoves) {
      end = "max-moves";
      break;
    }
    if (input.signal?.cancelled === true) {
      end = "cancelled";
      break;
    }
    const result = chooseMove(state, input.rules, config, rng, input.signal, { now: input.now });
    if (result.kind === "no-legal-move") {
      end = "dead-board";
      break;
    }
    rng = result.rng;
    nodes += result.decision.nodesSearched;
    if (result.decision.fallback) fallbacks += 1;
    state = port.applyMove(state, result.decision.direction, input.rules).state;
    moves.push(result.decision.direction);
    input.onMove?.({ index: moves.length - 1, decision: result.decision, state });
  }

  return {
    strategy: config.strategy,
    botVersion: BOT_VERSION,
    difficulty: difficultyOf(config.strategy),
    config,
    seed: input.seed,
    botSeed,
    rulesetVersion: input.rules.version,
    moves,
    end,
    finalScore: state.score,
    maxExponent: port.maxExponent(state.board),
    acceptedMoves: state.acceptedMoves,
    nodesSearched: nodes,
    fallbackMoves: fallbacks,
    finalState: state,
  };
}

export type TournamentEntry = BotConfig & { readonly label?: string };
export type TournamentPairing = { readonly a: TournamentEntry; readonly b: TournamentEntry };

export type TournamentSeat = {
  readonly label: string;
  readonly strategy: BotConfig["strategy"];
  readonly nodeBudget: number;
  readonly score: Decimal;
  readonly maxExponent: Exponent | null;
  readonly acceptedMoves: number;
  readonly terminal: SeatTerminalReason;
  readonly nodesSearched: number;
  readonly fallbackMoves: number;
};

export type TournamentGame = {
  readonly seed: string;
  readonly pairing: number;
  readonly a: TournamentSeat;
  readonly b: TournamentSeat;
  readonly outcome: DuelOutcome;
};

export type TournamentRow = {
  readonly label: string;
  readonly played: number;
  readonly won: number;
  readonly drawn: number;
  readonly lost: number;
  readonly totalScore: Decimal;
};

export type TournamentResult = {
  readonly rulesetVersion: string;
  readonly botVersion: string;
  readonly games: readonly TournamentGame[];
  /** Sorted by wins desc, draws desc, label asc. */
  readonly table: readonly TournamentRow[];
};

/**
 * Deterministic bot-vs-bot league on duel rules (default duel-v1: same seed for both seats,
 * 500 accepted-move cap). Each seat plays the seed independently, then decideDuel scores the
 * pair. Budgets are node-based only (no clock), so identical inputs give identical results
 * regardless of machine speed (BOT-04). Results never touch human Elo.
 */
export function runTournament(
  port: EnginePort,
  input: {
    readonly seeds: readonly string[];
    readonly pairings: readonly TournamentPairing[];
    readonly rules?: Ruleset;
  },
): TournamentResult {
  const rules = input.rules ?? RULESETS["duel-v1"];
  if (rules.moveCap === null) throw new Error("tournament rules need a move cap");
  const games: TournamentGame[] = [];
  const rows = new Map<string, { played: number; won: number; drawn: number; lost: number; total: bigint }>();

  const playSeat = (entry: TournamentEntry, seed: string): TournamentSeat => {
    const label = entry.label ?? `${entry.strategy}/${entry.nodeBudget}`;
    const config: BotConfig = {
      strategy: entry.strategy,
      nodeBudget: entry.nodeBudget,
      timeBudgetMs: entry.timeBudgetMs,
    };
    const r = playBotGame(port, { rules, config, seed });
    return {
      label,
      strategy: r.strategy,
      nodeBudget: config.nodeBudget,
      score: r.finalScore,
      maxExponent: r.maxExponent,
      acceptedMoves: r.acceptedMoves,
      terminal: r.end === "move-cap" ? "move-cap" : "dead-board",
      nodesSearched: r.nodesSearched,
      fallbackMoves: r.fallbackMoves,
    };
  };
  const record = (seat: TournamentSeat, points: 1 | 0.5 | 0): void => {
    const row = rows.get(seat.label) ?? { played: 0, won: 0, drawn: 0, lost: 0, total: 0n };
    row.played += 1;
    if (points === 1) row.won += 1;
    else if (points === 0) row.lost += 1;
    else row.drawn += 1;
    row.total += BigInt(seat.score);
    rows.set(seat.label, row);
  };

  for (const seed of input.seeds) {
    input.pairings.forEach((pairing, index) => {
      const a = playSeat(pairing.a, seed);
      const b = playSeat(pairing.b, seed);
      const outcome = decideDuel(a, b);
      if (outcome === null) throw new Error("tournament seats must both be terminal");
      games.push({ seed, pairing: index, a, b, outcome });
      record(a, outcome === "seat-a" ? 1 : outcome === "draw" ? 0.5 : 0);
      record(b, outcome === "seat-b" ? 1 : outcome === "draw" ? 0.5 : 0);
    });
  }

  const table = [...rows.entries()]
    .map(([label, r]) => ({
      label,
      played: r.played,
      won: r.won,
      drawn: r.drawn,
      lost: r.lost,
      totalScore: r.total.toString(),
    }))
    .sort(
      (x, y) => y.won - x.won || y.drawn - x.drawn || (x.label < y.label ? -1 : x.label > y.label ? 1 : 0),
    );
  return { rulesetVersion: rules.version, botVersion: BOT_VERSION, games, table };
}
