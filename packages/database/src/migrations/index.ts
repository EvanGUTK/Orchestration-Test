import type { Migration } from "../migrate.js";
import { migration001 } from "./001-initial.js";
import { migration002 } from "./002-undo-depth.js";
import { migration003 } from "./003-replays-and-boards.js";
import { migration004 } from "./004-match-events.js";

/** Ordered, append-only. Never edit an applied migration; add version N+1. */
export const MIGRATIONS: readonly Migration[] = [migration001, migration002, migration003, migration004];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;
