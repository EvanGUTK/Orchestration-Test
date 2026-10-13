import type { Migration } from "../migrate.js";
import { migration001 } from "./001-initial.js";
import { migration002 } from "./002-undo-depth.js";

/** Ordered, append-only. Never edit an applied migration; add version N+1. */
export const MIGRATIONS: readonly Migration[] = [migration001, migration002];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;
