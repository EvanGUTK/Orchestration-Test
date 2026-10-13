import type { Direction, GameState } from "./domain.js";
import type { Ruleset } from "./rules.js";
import type { REPLAY_SCHEMA_VERSION } from "./versions.js";

/** Portable replay. Imports are validated, size-limited, and never ranked. */
export type ReplayFile = {
  replaySchemaVersion: typeof REPLAY_SCHEMA_VERSION;
  engineVersion: string;
  rulesetVersion: string;
  /** Full ruleset used (C16). Required for practice-v1 (size/fourWeight/undo); exporters always include it. */
  rules?: Ruleset;
  seed: string;
  initialState: GameState;
  initialChecksum: string;
  /** Accepted (changed) moves on the final path, in order; revision is state.revision after the move. Undone moves excluded. */
  moves: { revision: number; direction: Direction; checksum: string }[];
  finalChecksum: string;
  meta: { mode: string; displayName: string | null; createdAt: string; source: "local" | "import" };
};
