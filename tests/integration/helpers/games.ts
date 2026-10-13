// Game API helpers (CONTRACTS.md HTTP table + contracts api.ts) and a TEST-ONLY state seed.
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import type { Direction, GameResponse, GameState, MoveResponse } from "@g2048/contracts";
import { checksum, legalMoves, maxExponent, serialize } from "@g2048/engine";
import type { Client, Res } from "./http.js";

let counter = 0;
/** Unique command id matching CommandId (8..64 chars of [A-Za-z0-9_-]). */
export function cmd(prefix = "cmd"): string {
  counter += 1;
  return `${prefix}-${counter}-${randomBytes(6).toString("hex")}`;
}

export type CreateGameBody =
  | { mode: "classic"; seed?: string }
  | { mode: "practice"; practice: { size: number; fourWeight?: number; seed?: string; undo?: boolean } };

export async function createGame(c: Client, body: CreateGameBody): Promise<GameResponse> {
  const r = await c.post<GameResponse>("/games", body);
  // CONTRACT-001 C14: POST /games -> 201 GameResponse
  if (r.status !== 201) throw new Error(`POST /games ${JSON.stringify(body)} -> ${r.status} ${r.text}`);
  return r.json;
}

export async function getGame(c: Client, id: string): Promise<GameResponse> {
  const r = await c.get<GameResponse>(`/games/${id}`);
  if (r.status !== 200) throw new Error(`GET /games/${id} -> ${r.status} ${r.text}`);
  return r.json;
}

export function move(
  c: Client,
  id: string,
  direction: Direction,
  expectedRevision: number,
  commandId = cmd("mv"),
): Promise<Res<MoveResponse>> {
  return c.post<MoveResponse>(`/games/${id}/moves`, { commandId, expectedRevision, direction });
}

/** Applies a legal move (first legal direction, rotated by `turn`) and returns the new state. */
export async function legalMove(c: Client, id: string, state: GameState, turn = 0): Promise<GameState> {
  const legal = legalMoves(state.board);
  const d = legal[turn % legal.length];
  if (!d) throw new Error("no legal move");
  const r = await move(c, id, d, state.revision);
  expect(r.status, r.text).toBe(200);
  return r.json.state;
}

/** C14: undo/forfeit take RevisionCommandRequest and return 200 GameResponse. */
export async function undo(c: Client, id: string, expectedRevision: number, commandId = cmd("undo")) {
  return c.post<GameResponse>(`/games/${id}/undo`, { commandId, expectedRevision });
}

export async function forfeit(c: Client, id: string, expectedRevision: number, commandId = cmd("ff")) {
  return c.post<GameResponse>(`/games/${id}/forfeit`, { commandId, expectedRevision });
}

/**
 * TEST-ONLY seed (QA): overwrites a game's current state in the private test database, written against
 * migration 001 (`games` columns + the `game_snapshots` row at the same revision), with the engine's
 * checksum so the row is internally consistent. Used where no API can reach a state (huge values,
 * move-cap edge, leaderboard fixtures). Never used against $DATABASE_PATH (helpers/app.ts guards).
 */
export function seedGameState(db: DatabaseSync, gameId: string, state: GameState): void {
  const now = new Date().toISOString();
  const sum = checksum(state);
  const finished = state.status === "active" ? null : now;
  db.exec("BEGIN IMMEDIATE");
  try {
    const info = db
      .prepare(
        `UPDATE games SET board_json = ?, rng_state = ?, score = ?, max_exponent = ?, accepted_moves = ?,
           revision = ?, status = ?, celebrated_2048 = ?, state_checksum = ?, updated_at = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(
        JSON.stringify(state.board),
        JSON.stringify(state.rng),
        state.score,
        maxExponent(state.board),
        state.acceptedMoves,
        state.revision,
        state.status,
        state.celebrated2048 ? 1 : 0,
        sum,
        now,
        finished,
        gameId,
      );
    if (Number(info.changes) !== 1) throw new Error(`seedGameState: game ${gameId} not found`);
    db.prepare(
      `INSERT INTO game_snapshots (game_id, revision, state_json, score, checksum, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (game_id, revision) DO UPDATE SET state_json = excluded.state_json,
         score = excluded.score, checksum = excluded.checksum`,
    ).run(gameId, state.revision, serialize(state), state.score, sum, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export type MoveRow = {
  revision: number;
  command_id: string;
  kind: string;
  direction: string | null;
  score_delta: string;
  checksum: string;
  undone: number;
};

export function moveRows(db: DatabaseSync, gameId: string): MoveRow[] {
  return db
    .prepare(
      "SELECT revision, command_id, kind, direction, score_delta, checksum, undone FROM game_moves WHERE game_id = ? ORDER BY revision",
    )
    .all(gameId) as MoveRow[];
}

export function gameRow(db: DatabaseSync, gameId: string): Record<string, unknown> {
  const row = db.prepare("SELECT * FROM games WHERE id = ?").get(gameId) as
    Record<string, unknown> | undefined;
  if (!row) throw new Error(`no games row ${gameId}`);
  return row;
}
