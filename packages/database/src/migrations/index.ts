import type { Migration } from "../migrate.js";
import { migration001 } from "./001-initial.js";

/** Ordered, append-only. Never edit an applied migration; add version N+1. */
export const MIGRATIONS: readonly Migration[] = [migration001];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;
