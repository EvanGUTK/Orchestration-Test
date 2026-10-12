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

const USERNAME = /^[a-z0-9][a-z0-9_.-]{2,31}$/;

export const usernameSchema = z
  .string()
  .max(128)
  .transform(normalizeUsername)
  .refine((s) => USERNAME.test(s), "username must be 3-32 characters: letters, digits, '_', '.', '-'");

export const displayNameSchema = z
  .string()
  .max(256)
  .transform((s) => s.normalize("NFC").trim().replace(/\s+/gu, " "))
  .refine((s) => graphemes(s) >= 1 && graphemes(s) <= 32, "displayName must be 1-32 characters")
  .refine((s) => !CONTROL_OR_MARKUP.test(s), "displayName contains control characters or angle brackets");

export const passwordSchema = z
  .string()
  .min(8, "password must be at least 8 characters")
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
export const eventsQuery = z.strictObject({
  cursor: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
