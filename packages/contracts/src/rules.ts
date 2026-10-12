export type Ruleset = {
  /** Stable identifier stored on games; unique per distinct parameter set. */
  version: string;
  boardSize: number; // 3..8
  /** Accepted-move cap; null = unlimited. Reaching it sets status "completed" and emits `move-cap`. */
  moveCap: number | null;
  startTiles: number; // initial spawns, default 2
  /** Spawn draw is uniform in [0,10): value < spawnFourTenths => tile 4 else tile 2. Default 1 (10% fours). */
  spawnFourTenths: number; // 0..10
  /** Maximum undo history length (0 = undo disabled). */
  undoLimit: number;
  /** true for official ranked/duel rules: undo and custom options are rejected by the server. */
  official: boolean;
};

export const MIN_BOARD_SIZE = 3;
export const MAX_BOARD_SIZE = 8;
export const HISTORY_CAP = 100;
export const SNAPSHOT_INTERVAL = 50;
export const SEAT_MOVE_CAP = 500;

export const CLASSIC_RULES: Ruleset = {
  version: "classic-v1",
  boardSize: 4,
  moveCap: null,
  startTiles: 2,
  spawnFourTenths: 1,
  undoLimit: HISTORY_CAP,
  official: false,
};

export const RANKED_RULES: Ruleset = {
  version: "ranked-v1",
  boardSize: 4,
  moveCap: SEAT_MOVE_CAP,
  startTiles: 2,
  spawnFourTenths: 1,
  undoLimit: 0,
  official: true,
};

export const DUEL_RULES: Ruleset = { ...RANKED_RULES, version: "duel-v1" };

export function customRules(opts: {
  boardSize: number;
  spawnFourTenths?: number;
  startTiles?: number;
  moveCap?: number | null;
}): Ruleset {
  const boardSize = opts.boardSize;
  const spawnFourTenths = opts.spawnFourTenths ?? 1;
  const startTiles = opts.startTiles ?? 2;
  const moveCap = opts.moveCap ?? null;
  if (!Number.isInteger(boardSize) || boardSize < MIN_BOARD_SIZE || boardSize > MAX_BOARD_SIZE) {
    throw new RangeError("boardSize must be an integer from 3 to 8");
  }
  if (!Number.isInteger(spawnFourTenths) || spawnFourTenths < 0 || spawnFourTenths > 10) {
    throw new RangeError("spawnFourTenths must be an integer from 0 to 10");
  }
  if (!Number.isInteger(startTiles) || startTiles < 1 || startTiles > boardSize * boardSize - 1) {
    throw new RangeError("startTiles out of range");
  }
  if (moveCap !== null && (!Number.isSafeInteger(moveCap) || moveCap < 1)) {
    throw new RangeError("moveCap must be null or a positive safe integer");
  }
  return {
    version: `custom-v1:${boardSize}:${spawnFourTenths}:${startTiles}:${moveCap ?? "none"}`,
    boardSize,
    moveCap,
    startTiles,
    spawnFourTenths,
    undoLimit: HISTORY_CAP,
    official: false,
  };
}

/** Resolve a stored ruleset id back to its parameters (inverse of customRules/constants). */
export function resolveRules(version: string): Ruleset | null {
  if (version === CLASSIC_RULES.version) return CLASSIC_RULES;
  if (version === RANKED_RULES.version) return RANKED_RULES;
  if (version === DUEL_RULES.version) return DUEL_RULES;
  const m = /^custom-v1:(\d+):(\d+):(\d+):(none|\d+)$/.exec(version);
  if (!m) return null;
  try {
    const rules = customRules({
      boardSize: Number(m[1]),
      spawnFourTenths: Number(m[2]),
      startTiles: Number(m[3]),
      moveCap: m[4] === "none" ? null : Number(m[4]),
    });
    return rules.version === version ? rules : null;
  } catch {
    return null;
  }
}
