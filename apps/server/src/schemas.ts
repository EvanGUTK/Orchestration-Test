import { z } from "zod";
import { DomainError } from "@2048/contracts";
import type { Preferences } from "@2048/contracts";

/** Parse with zod and convert failures into the typed VALIDATION_ERROR envelope. */
export function parse<T extends z.ZodType>(schema: T, input: unknown, what = "request"): z.infer<T> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  throw new DomainError("VALIDATION_ERROR", `Invalid ${what}`, {
    issues: r.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}

const CONTROL_OR_MARKUP = /[\p{C}<>]/u;
const graphemes = (s: string) => [...s].length;

export function normalizeUsername(raw: string): string {
  return raw.trim().normalize("NFKC").toLowerCase();
}

// docs/PROJECT_SCOPE.md: ASCII lowercase, 3-24 characters [a-z0-9_], unique after normalization.
const USERNAME = /^[a-z0-9_]{3,24}$/;

export const usernameSchema = z
  .string()
  .max(128)
  .transform(normalizeUsername)
  .refine((s) => USERNAME.test(s), "username must be 3-24 characters: lowercase letters, digits and '_'");

export const displayNameSchema = z
  .string()
  .max(256)
  .transform((s) => s.normalize("NFC").trim().replace(/\s+/gu, " "))
  .refine((s) => graphemes(s) >= 1 && graphemes(s) <= 48, "displayName must be 1-48 characters")
  .refine((s) => !CONTROL_OR_MARKUP.test(s), "displayName contains control characters or angle brackets");

export const passwordSchema = z
  .string()
  .min(12, "password must be at least 12 characters")
  .max(128, "password must be at most 128 characters");

export const registerSchema = z.strictObject({ username: usernameSchema, displayName: displayNameSchema, password: passwordSchema });
// Login must not leak the username policy and must tolerate legacy values: only bound the size.
export const loginSchema = z.strictObject({ username: z.string().min(1).max(128), password: z.string().min(1).max(128) });
export const changePasswordSchema = z.strictObject({ oldPassword: z.string().min(1).max(128), newPassword: passwordSchema });
export const deleteProfileSchema = z.strictObject({ password: z.string().min(1).max(128) });

const direction = z.enum(["up", "right", "down", "left"]);
const keyList = z.array(z.string().min(1).max(32).refine((s) => !/[\p{C}]/u.test(s), "invalid key")).min(1).max(4);
const keyBindings = z.strictObject({ up: keyList, right: keyList, down: keyList, left: keyList });

export const preferencesPatchSchema = z.strictObject({
  theme: z.enum(["light", "dark", "high-contrast", "system"]),
  soundMuted: z.boolean(),
  motion: z.enum(["full", "reduced", "system"]),
  tileStyle: z.enum(["numbers", "powers", "numbers-pattern"]),
  keyBindings,
  botSpeed: z.enum(["slow", "normal", "fast"]),
}).partial();

export const patchProfileSchema = z
  .strictObject({ displayName: displayNameSchema.optional(), preferences: preferencesPatchSchema.optional() })
  .refine((v) => v.displayName !== undefined || v.preferences !== undefined, "nothing to update");

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  soundMuted: false,
  motion: "system",
  tileStyle: "numbers",
  keyBindings: {
    up: ["ArrowUp", "w"],
    right: ["ArrowRight", "d"],
    down: ["ArrowDown", "s"],
    left: ["ArrowLeft", "a"],
  },
  botSpeed: "normal",
};

export function mergePreferences(stored: string | null, patch?: Partial<Preferences>): Preferences {
  let base: Partial<Preferences> = {};
  if (stored) {
    try {
      base = JSON.parse(stored) as Partial<Preferences>;
    } catch {
      base = {};
    }
  }
  return { ...DEFAULT_PREFERENCES, ...base, ...patch };
}

const commandId = z.string().min(8).max(100).regex(/^[A-Za-z0-9_.:-]+$/, "commandId must be 8-100 URL-safe characters");
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const moveSchema = z.strictObject({ commandId, expectedRevision: revision, direction });
export const undoSchema = z.strictObject({ commandId, expectedRevision: revision });
export const forfeitSchema = undoSchema;

const botConfig = z.strictObject({
  strategy: z.enum(["random", "greedy", "heuristic", "expectimax"]),
  seed: z.string().min(1).max(128),
  nodeBudget: z.number().int().min(1).max(10_000_000),
  timeBudgetMs: z.number().int().min(1).max(60_000),
  depth: z.number().int().min(1).max(12).optional(),
});

export const createGameSchema = z.strictObject({
  mode: z.enum(["classic", "practice", "bot-exhibition"]),
  custom: z
    .strictObject({
      boardSize: z.number().int().optional(),
      seed: z.string().min(1).max(128).optional(),
      spawnFourTenths: z.number().int().optional(),
    })
    .optional(),
  bot: botConfig.optional(),
});

export const uuidParam = z.strictObject({ id: z.uuid() });
export const listGamesQuery = z.strictObject({
  status: z.enum(["active", "completed", "forfeited", "all"]).default("active"),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const eventsQuery = z
  .strictObject({
    cursor: z.coerce.number().int().min(0).optional(),
    after: z.coerce.number().int().min(0).optional(), // alias used by the web client
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .transform((q) => ({ cursor: q.cursor ?? q.after ?? 0, limit: q.limit }));

export const challengesQuery = z.strictObject({
  season: z.string().regex(/^s\d{4}-(0[1-9]|1[0-2])$/).optional(),
  status: z.enum(["open", "closed"]).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const leaderboardQuery = z.strictObject({
  kind: z.enum(["casual", "challenge", "duel-elo", "bot"]),
  ruleset: z.string().min(1).max(128).optional(),
  season: z.string().optional(),
  challenge: z.string().min(1).max(128).optional(),
  account: z.uuid().optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const matchesQuery = z.strictObject({
  scope: z.enum(["mine", "lobby"]).default("mine"),
  status: z.enum(["lobby", "active", "finished"]).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const createMatchSchema = z.strictObject({
  kind: z.enum(["human-vs-human", "human-vs-bot", "bot-vs-bot"]),
  bot: botConfig.optional(),
  opponentBot: botConfig.optional(),
});

export const botRunSchema = z.strictObject({
  config: botConfig,
  boardSize: z.number().int().optional(),
  gameSeed: z.string().min(1).max(128).optional(),
  mode: z.enum(["exhibition", "league"]),
  maxMoves: z.number().int().optional(),
});

export const replaysQuery = z.strictObject({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
