import type { Decimal, Exponent } from "./exact.ts";
import type { Direction, DomainEvent, GameState } from "./state.ts";
import type { ErrorCode } from "./errors.ts";

/** Frozen request/response shapes for /api/v1. All ids are UUID strings; all scores Decimal strings. */

export type GameMode =
  | "classic"
  | "practice"
  | "ranked"
  | "bot-exhibition"
  | "duel"
  | "bot-duel"
  | "bot-league";
export type Preferences = {
  theme: "light" | "dark" | "high-contrast" | "system";
  soundMuted: boolean;
  motion: "full" | "reduced" | "system";
  tileStyle: "numbers" | "powers" | "numbers-pattern";
  keyBindings: Record<Direction, string[]>;
  botSpeed: "slow" | "normal" | "fast";
};

export type Identity = {
  kind: "user" | "guest";
  userId: string;
  username?: string;
  displayName: string;
  preferences: Preferences;
  csrfToken: string;
};

export type RegisterRequest = { username: string; displayName: string; password: string };
export type LoginRequest = { username: string; password: string };
export type ChangePasswordRequest = { oldPassword: string; newPassword: string };
export type DeleteProfileRequest = { password: string };
export type PatchProfileRequest = { displayName?: string; preferences?: Partial<Preferences> };

export type CustomOptions = { boardSize?: number; seed?: string; spawnFourTenths?: number };
export type CreateGameRequest = {
  mode: Extract<GameMode, "classic" | "practice" | "bot-exhibition">;
  custom?: CustomOptions; // practice (and bot-exhibition board size) only
  bot?: BotConfig; // bot-exhibition only
};

export type GameView = {
  id: string;
  mode: GameMode;
  rulesetVersion: string;
  engineVersion: string;
  seed: string | null; // null for ranked/duel games until terminal (policy: not a security guarantee)
  state: GameState;
  undoAvailable: number;
  challengeId?: string;
  matchId?: string;
  seat?: 0 | 1;
  createdAt: string;
  updatedAt: string;
};

export type MoveRequest = { commandId: string; expectedRevision: number; direction: Direction };
export type UndoRequest = { commandId: string; expectedRevision: number };
export type ForfeitRequest = { commandId: string; expectedRevision: number };
export type MoveResponse = {
  game: GameView;
  changed: boolean; // false => NO_CHANGE no-op (HTTP 200); revision/RNG untouched
  scoreDelta: Decimal;
  events: DomainEvent[];
  sequence: number; // revision after this command
  code?: Extract<ErrorCode, "NO_CHANGE">;
};

export type EventsPage = {
  events: { sequence: number; direction: Direction; events: DomainEvent[]; checksum: string }[];
  nextCursor: number | null;
};

export type Page<T> = { items: T[]; nextCursor: string | null };

export type LeaderboardKind = "casual" | "challenge" | "duel-elo" | "bot";
export type LeaderboardQuery = {
  kind: LeaderboardKind;
  ruleset?: string;
  season?: string;
  challenge?: string;
  account?: string;
  cursor?: string;
  limit?: number; // 1..100, default 25
};
export type LeaderboardEntry = {
  rank: number;
  accountId: string | null;
  displayName: string; // anonymized when account deleted
  score?: Decimal;
  maxExponent?: Exponent;
  rating?: number;
  played?: number;
  won?: number;
  drawn?: number;
  lost?: number;
  gameId?: string;
  createdAt: string;
};

export type Challenge = {
  id: string;
  seasonId: string;
  rulesetVersion: string;
  title: string;
  moveCap: number;
  status: "open" | "closed";
  myAttempt?: { gameId: string; status: "active" | "completed" | "forfeited" };
};

export type MatchKind = "human-vs-human" | "human-vs-bot" | "bot-vs-bot";
export type MatchStatus = "lobby" | "active" | "finished";
export type MatchOutcome = "seat0" | "seat1" | "draw";
export type SeatView = {
  seat: 0 | 1;
  kind: "human" | "bot";
  displayName: string;
  gameId: string | null;
  terminalReason: "move-cap" | "dead" | "forfeit" | null;
  score?: Decimal;
  maxExponent?: Exponent;
  acceptedMoves?: number;
};
export type MatchView = {
  id: string;
  kind: MatchKind;
  status: MatchStatus;
  outcome: MatchOutcome | null;
  seasonId: string;
  rulesetVersion: string;
  seats: [SeatView, SeatView | null];
  ratingEvents: RatingEvent[];
};
export type CreateMatchRequest = { kind: MatchKind; bot?: BotConfig; opponentBot?: BotConfig };
export type RatingEvent = {
  matchId: string;
  accountId: string;
  seasonId: string;
  rulesetVersion: string;
  before: number;
  after: number;
  delta: number;
  outcome: 0 | 0.5 | 1;
  idempotencyKey: string;
  algorithm: "elo-v1";
};

export type BotStrategy = "random" | "greedy" | "heuristic" | "expectimax";
export type BotConfig = {
  strategy: BotStrategy;
  seed: string;
  nodeBudget: number; // per move
  timeBudgetMs: number; // per move
  depth?: number;
};
export type BotRunRequest = {
  config: BotConfig;
  boardSize?: number;
  gameSeed?: string;
  mode: "exhibition" | "league";
  maxMoves?: number;
};
export type BotRunView = {
  id: string;
  status: "running" | "paused" | "finished" | "cancelled" | "error";
  config: BotConfig;
  botVersion: string;
  gameId: string | null;
  moves: number;
  lastExplanation?: string;
};

export type ReplayView = {
  schemaVersion: 1;
  engineVersion: string;
  rulesetVersion: string;
  ruleset: import("./rules.ts").Ruleset;
  seed: string;
  moves: { sequence: number; direction: Direction; checksum: string }[];
  snapshots: { sequence: number; checksum: string; state: GameState }[];
  finalChecksum: string;
  finalScore: Decimal;
  undoMarkers: { atSequence: number; branch: number }[];
};

export type HealthResponse = { status: "ok" };
export type ReadyResponse = { status: "ready"; schemaVersion: number; migrations: number };
