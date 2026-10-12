import { z } from "zod";
import { BOT_STRATEGIES } from "./competition.js";
import type {
  BotStrategy,
  DuelOutcome,
  MatchKind,
  MatchStatus,
  SeatId,
  SeatTerminalReason,
} from "./competition.js";
import type { Decimal, DomainEvent, Exponent, GameState } from "./domain.js";
import {
  DECIMAL_PATTERN,
  DISPLAY_NAME_MAX,
  DISPLAY_NAME_MIN,
  LIMITS,
  PASSWORD_MAX,
  PASSWORD_MIN,
} from "./limits.js";
import type { GameMode } from "./rules.js";
import { PracticeOptionsSchema } from "./rules.js";

/** HTTP request schemas. The server validates every body/query with these; the web client may reuse them. */
const codePoints = (s: string) => [...s].length;

export const UsernameInput = z.string().min(1).max(64); // normalized + pattern-checked server-side
export const DisplayNameInput = z
  .string()
  .refine((s) => codePoints(s) >= DISPLAY_NAME_MIN && codePoints(s) <= DISPLAY_NAME_MAX, "1-48 characters");
export const PasswordInput = z
  .string()
  .refine((s) => codePoints(s) >= PASSWORD_MIN && codePoints(s) <= PASSWORD_MAX, "12-128 characters");

export const RegisterRequest = z.object({
  username: UsernameInput,
  displayName: DisplayNameInput,
  password: PasswordInput,
});
export const LoginRequest = z.object({
  username: UsernameInput,
  password: z
    .string()
    .min(1)
    .max(PASSWORD_MAX * 4),
});
export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1),
  newPassword: PasswordInput,
});
export const DeleteProfileRequest = z.object({ password: z.string().min(1) });
/** Owner reset is a local CLI operation, never HTTP. */

export const PreferencesSchema = z
  .object({
    theme: z.enum(["system", "light", "dark", "high-contrast"]),
    soundMuted: z.boolean(),
    motion: z.enum(["system", "reduced", "full"]),
    tileDisplay: z.enum(["value", "exponent", "auto"]),
    keyBindings: z.record(z.enum(["up", "right", "down", "left"]), z.array(z.string().max(32)).max(4)),
    botSpeedMs: z.number().int().min(0).max(5000),
  })
  .partial()
  .strict();
export type Preferences = z.infer<typeof PreferencesSchema>;
export const PatchProfileRequest = z
  .object({ displayName: DisplayNameInput.optional(), preferences: PreferencesSchema.optional() })
  .strict();

/** Ranked games come from POST /challenges/:id/attempts; duel/bot games from /matches and /bots/runs. */
export const CreateGameRequest = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("classic"), seed: z.string().min(1).max(128).optional() }),
  z.object({ mode: z.literal("practice"), practice: PracticeOptionsSchema }),
]);

export const CommandId = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
export const MoveRequest = z.object({
  commandId: CommandId,
  expectedRevision: z.number().int().min(0),
  direction: z.enum(["up", "right", "down", "left"]),
});
export const RevisionCommandRequest = z.object({
  commandId: CommandId,
  expectedRevision: z.number().int().min(0),
});

export const PageQuery = z.object({
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.listPageMax).default(25),
});
export const EventsQuery = z.object({
  afterRevision: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(LIMITS.eventsPageMax).default(100),
});
export const LeaderboardQuery = PageQuery.extend({
  scope: z.enum(["casual", "challenge", "duel-elo", "bot-league"]),
  ruleset: z.string().max(32).optional(),
  season: z.string().max(64).optional(),
  challenge: z.string().max(64).optional(),
  account: z.string().max(64).optional(),
});

export const BotConfigSchema = z.object({
  strategy: z.enum(BOT_STRATEGIES),
  nodeBudget: z.number().int().min(1).max(LIMITS.botNodeBudgetMax),
  timeBudgetMs: z.number().int().min(1).max(LIMITS.botTimeBudgetMsMax),
});
export type BotConfig = z.infer<typeof BotConfigSchema>;

export const CreateMatchRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human-human") }),
  z.object({ kind: z.literal("human-bot"), bot: BotConfigSchema }),
  z.object({
    kind: z.literal("bot-bot"),
    bots: z.tuple([BotConfigSchema, BotConfigSchema]),
    seed: z.string().min(1).max(128).optional(),
  }),
]);
export const CreateBotRunRequest = BotConfigSchema.extend({
  seed: z.string().min(1).max(128),
  practice: PracticeOptionsSchema.omit({ seed: true }).optional(),
  maxMoves: z.number().int().min(1).max(100_000).default(1000),
  stepMode: z.boolean().default(false),
});

/** Response shapes (JSON). Exact values stay decimal strings. */
export type PublicUser = { id: string; username: string; displayName: string; createdAt: string };
export type MeResponse = {
  user: PublicUser | null;
  guest: { id: string } | null;
  csrfToken: string;
  preferences: Preferences;
};
export type GameSummary = {
  id: string;
  mode: GameMode;
  rulesetVersion: string;
  status: GameState["status"];
  score: Decimal;
  maxExponent: Exponent | null;
  acceptedMoves: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
export type GameResponse = { game: GameSummary; state: GameState; canUndo: boolean };
export type MoveResponse = {
  changed: boolean;
  scoreDelta: Decimal;
  state: GameState;
  events: DomainEvent[];
  /** Present only for valid no-op moves (HTTP 200, changed:false). */
  code?: "NO_CHANGE";
};
export type GameEventRecord = {
  revision: number;
  kind: "move" | "undo" | "forfeit";
  direction: "up" | "right" | "down" | "left" | null;
  events: DomainEvent[];
  checksum: string;
};
export type GameEventsResponse = { events: GameEventRecord[]; nextAfterRevision: number; done: boolean };
export type Page<T> = { items: T[]; nextCursor: string | null };
export type LeaderboardEntry = {
  rank: number;
  accountId: string | null; // null when anonymized/deleted or a bot
  displayName: string;
  botStrategy: BotStrategy | null;
  score: Decimal | null;
  maxExponent: Exponent | null;
  rating: number | null;
  gameId: string | null;
  createdAt: string;
};
export type ChallengeSummary = {
  id: string;
  season: string;
  rulesetVersion: string;
  moveCap: number;
  status: "open" | "closed";
  myAttempt: { status: "in-progress" | "completed" | "forfeited"; gameId: string } | null;
};
export type SeatView = {
  seat: SeatId;
  kind: "human" | "bot";
  displayName: string;
  accountId: string | null;
  botStrategy: BotStrategy | null;
  gameId: string | null;
  score: Decimal;
  maxExponent: Exponent | null;
  acceptedMoves: number;
  terminal: SeatTerminalReason | null;
};
export type MatchView = {
  id: string;
  kind: MatchKind;
  status: MatchStatus;
  rulesetVersion: string;
  season: string;
  seats: SeatView[];
  outcome: DuelOutcome | null;
  ratingChanges: { accountId: string; before: number; after: number; delta: number }[];
};
export type BotRunView = {
  id: string;
  strategy: BotStrategy;
  botVersion: string;
  status: "queued" | "running" | "paused" | "finished" | "cancelled" | "failed";
  gameId: string | null;
  nodeBudget: number;
  timeBudgetMs: number;
  seed: string;
  movesPlayed: number;
  lastDecision: { direction: string; explanation: string; nodesSearched: number; fallback: boolean } | null;
};

export const DecimalSchema = z.string().regex(DECIMAL_PATTERN);
