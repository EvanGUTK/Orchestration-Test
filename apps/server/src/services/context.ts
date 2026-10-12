import type { DatabaseSync } from "node:sqlite";
import type { DatabaseWriter } from "@g2048/database";

export type Clock = () => Date;

/**
 * Shared adapters handed to every service. Reads use `db` directly (synchronous, never inside an
 * open transaction because writer jobs are synchronous); all writes go through `writer`, the single
 * authoritative, bounded writer queue.
 */
export type ServiceContext = {
  db: DatabaseSync;
  writer: DatabaseWriter;
  clock: Clock;
};

export function nowIso(ctx: ServiceContext): string {
  return ctx.clock().toISOString();
}
