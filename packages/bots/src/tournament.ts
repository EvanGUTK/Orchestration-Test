import { DUEL_RULES, DomainError, compareDecimal } from "@2048/contracts";
import type { BotConfig, Decimal, Exponent, Ruleset } from "@2048/contracts";
import { sha256Hex } from "@2048/engine";
import { BOT_VERSION, describeBot, validateBotConfig } from "./config.ts";
import { BotGame, maxExponentOf } from "./run.ts";
import type { AbortSignalLike } from "./types.ts";

export type TournamentEntry = { id: string; config: BotConfig };

/** The structured-cloneable part of the options (what a worker thread receives). */
export type SerializableTournamentOptions = {
  entries: TournamentEntry[];
  /** One game per (entry, seed); every entry plays the same seeds. */
  gameSeeds: string[];
  rules?: Ruleset; // default: official duel rules (4x4, 500-move cap)
  maxMoves?: number;
};

export type TournamentOptions = SerializableTournamentOptions & {
  /** Polled inside every search: cancels mid-game, not just between games. */
  signal?: AbortSignalLike;
  /** Progress callback, once per finished game. */
  onGame?: (game: TournamentGame) => void;
};

export type TournamentGame = {
  entryId: string;
  gameSeed: string;
  score: Decimal;
  maxExponent: Exponent;
  moves: number;
  nodes: number;
  status: string;
  finalChecksum: string;
};

export type LeagueRow = {
  entryId: string;
  strategy: string;
  difficulty: number;
  played: number;
  /** Pairwise per-seed results against every other entry: win 2 points, draw 1. */
  points: number;
  wins: number;
  draws: number;
  losses: number;
  totalScore: Decimal;
  bestScore: Decimal;
  bestMaxExponent: Exponent;
};

export type TournamentResult = {
  botVersion: string;
  rulesetVersion: string;
  games: TournamentGame[];
  table: LeagueRow[];
  /** SHA-256 of the canonical games+table JSON: equal checksums == identical repeat run. */
  resultsChecksum: string;
  cancelled: boolean;
};

function cmpGames(a: TournamentGame, b: TournamentGame): number {
  const s = compareDecimal(a.score, b.score);
  return s !== 0 ? s : compareDecimal(a.maxExponent, b.maxExponent);
}

/**
 * Repeatable bot league. Same entries + seeds + versions + node budgets => identical results: games are
 * played with `ignoreTimeBudget`, so wall time never changes a decision. Each game is a full ruleset game
 * with the entry's own bot-seed stream; results are compared with exact decimals.
 */
export function runTournament(opts: TournamentOptions): TournamentResult {
  const rules = opts.rules ?? DUEL_RULES;
  if (opts.entries.length < 2) throw new DomainError("VALIDATION_ERROR", "a tournament needs at least two entries");
  if (opts.gameSeeds.length < 1) throw new DomainError("VALIDATION_ERROR", "a tournament needs at least one game seed");
  const ids = new Set(opts.entries.map((e) => e.id));
  if (ids.size !== opts.entries.length) throw new DomainError("VALIDATION_ERROR", "entry ids must be unique");
  const entries = opts.entries.map((e) => ({ id: e.id, config: validateBotConfig(e.config) }));

  const games: TournamentGame[] = [];
  let cancelled = false;
  outer: for (const gameSeed of opts.gameSeeds) {
    for (const entry of entries) {
      if (opts.signal?.aborted) { cancelled = true; break outer; }
      const game = new BotGame({ rules, gameSeed, config: entry.config, maxMoves: opts.maxMoves, ignoreTimeBudget: true, signal: opts.signal });
      game.runToEnd();
      if (!game.finished) { cancelled = true; break outer; }
      const g: TournamentGame = {
        entryId: entry.id,
        gameSeed,
        score: game.state.score,
        maxExponent: maxExponentOf(game.state),
        moves: game.moves.length,
        nodes: game.totalNodes,
        status: game.state.status,
        finalChecksum: game.last?.checksum ?? "",
      };
      games.push(g);
      opts.onGame?.(g);
    }
  }

  const rows = new Map<string, LeagueRow>();
  for (const e of entries) {
    const meta = describeBot(e.config);
    rows.set(e.id, { entryId: e.id, strategy: meta.strategy, difficulty: meta.difficulty, played: 0, points: 0, wins: 0, draws: 0, losses: 0, totalScore: "0", bestScore: "0", bestMaxExponent: "0" });
  }
  for (const g of games) {
    const r = rows.get(g.entryId)!;
    r.played++;
    r.totalScore = (BigInt(r.totalScore) + BigInt(g.score)).toString();
    if (compareDecimal(g.score, r.bestScore) > 0) r.bestScore = g.score;
    if (compareDecimal(g.maxExponent, r.bestMaxExponent) > 0) r.bestMaxExponent = g.maxExponent;
  }
  for (const seed of opts.gameSeeds) {
    const forSeed = games.filter((g) => g.gameSeed === seed);
    for (let i = 0; i < forSeed.length; i++) {
      for (let j = i + 1; j < forSeed.length; j++) {
        const a = forSeed[i]!;
        const b = forSeed[j]!;
        const ra = rows.get(a.entryId)!;
        const rb = rows.get(b.entryId)!;
        const c = cmpGames(a, b);
        if (c > 0) { ra.wins++; ra.points += 2; rb.losses++; }
        else if (c < 0) { rb.wins++; rb.points += 2; ra.losses++; }
        else { ra.draws++; rb.draws++; ra.points++; rb.points++; }
      }
    }
  }
  const table = [...rows.values()].sort((a, b) => b.points - a.points || compareDecimal(b.totalScore, a.totalScore) || (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));
  const body = { botVersion: BOT_VERSION, rulesetVersion: rules.version, games, table };
  return { ...body, resultsChecksum: sha256Hex(JSON.stringify(body)), cancelled };
}
