import { z } from "zod";

/** Immutable ruleset definitions. Persisted canonically in the `rulesets` table with a SHA-256 digest. */
export type Ruleset = {
  readonly version: string;
  readonly size: number;
  /** Value draw v = uniform(10); spawn exponent "2" (tile 4) if v < fourWeight else "1" (tile 2). */
  readonly fourWeight: number;
  /** Accepted-move cap after which the game/seat is terminal; null = none. */
  readonly moveCap: number | null;
  readonly undo: boolean;
  /** Max undo history depth for casual modes. */
  readonly historyLimit: number;
  readonly ranked: boolean;
};

export const RULESETS = {
  "classic-v1": {
    version: "classic-v1",
    size: 4,
    fourWeight: 1,
    moveCap: null,
    undo: true,
    historyLimit: 100,
    ranked: false,
  },
  "ranked-v1": {
    version: "ranked-v1",
    size: 4,
    fourWeight: 1,
    moveCap: 500,
    undo: false,
    historyLimit: 0,
    ranked: true,
  },
  "duel-v1": {
    version: "duel-v1",
    size: 4,
    fourWeight: 1,
    moveCap: 500,
    undo: false,
    historyLimit: 0,
    ranked: true,
  },
  "bot-v1": {
    version: "bot-v1",
    size: 4,
    fourWeight: 1,
    moveCap: null,
    undo: false,
    historyLimit: 0,
    ranked: false,
  },
} as const satisfies Record<string, Ruleset>;

export type BuiltinRulesetVersion = keyof typeof RULESETS;

/** Custom practice: version "practice-v1", size 3..8, fourWeight 0..10; never ranked. */
export const PRACTICE_RULESET_VERSION = "practice-v1";
export const MIN_BOARD_SIZE = 3;
export const MAX_BOARD_SIZE = 8;

export const PracticeOptionsSchema = z.object({
  size: z.number().int().min(MIN_BOARD_SIZE).max(MAX_BOARD_SIZE),
  fourWeight: z.number().int().min(0).max(10).default(1),
  seed: z.string().min(1).max(128).optional(),
  undo: z.boolean().default(true),
});
export type PracticeOptions = z.infer<typeof PracticeOptionsSchema>;

export function practiceRuleset(options: Pick<PracticeOptions, "size" | "fourWeight" | "undo">): Ruleset {
  return {
    version: PRACTICE_RULESET_VERSION,
    size: options.size,
    fourWeight: options.fourWeight,
    moveCap: null,
    undo: options.undo,
    historyLimit: 100,
    ranked: false,
  };
}

export const GAME_MODES = [
  "classic",
  "practice",
  "ranked",
  "bot-exhibition",
  "duel-human",
  "duel-bot",
  "bot-vs-bot",
] as const;
export type GameMode = (typeof GAME_MODES)[number];

/** Which ruleset each mode uses. practice uses practiceRuleset(). */
export const MODE_RULESET: Record<Exclude<GameMode, "practice">, BuiltinRulesetVersion> = {
  classic: "classic-v1",
  ranked: "ranked-v1",
  "bot-exhibition": "bot-v1",
  "duel-human": "duel-v1",
  "duel-bot": "duel-v1",
  "bot-vs-bot": "duel-v1",
};

/** 2048 = exponent 11. Celebrated once per game; play continues. */
export const MILESTONE_2048_EXPONENT = 11;
/** Snapshots every N accepted moves (game_snapshots + replay seek). */
export const SNAPSHOT_INTERVAL = 50;
