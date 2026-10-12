import type { Database as SqliteDatabase } from "better-sqlite3";

type Raw = Record<string, unknown>;

export type BotRunStatus = "running" | "paused" | "finished" | "cancelled" | "error";

export type BotRunRow = {
  id: string;
  ownerUserId: string | null;
  ownerGuestId: string | null;
  botVersion: string;
  mode: "exhibition" | "league";
  configJson: string;
  budgetJson: string;
  status: BotRunStatus;
  gameId: string | null;
  matchId: string | null;
  gameSeed: string | null;
  rulesetVersion: string | null;
  maxMoves: number | null;
  paceMs: number;
  moves: number;
  lastExplanation: string | null;
  metricsJson: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

const run = (r: Raw): BotRunRow => ({
  id: r.id as string,
  ownerUserId: (r.owner_user_id as string | null) ?? null,
  ownerGuestId: (r.owner_guest_id as string | null) ?? null,
  botVersion: r.bot_version as string,
  mode: r.mode as BotRunRow["mode"],
  configJson: r.config_json as string,
  budgetJson: r.budget_json as string,
  status: r.status as BotRunStatus,
  gameId: (r.game_id as string | null) ?? null,
  matchId: (r.match_id as string | null) ?? null,
  gameSeed: (r.game_seed as string | null) ?? null,
  rulesetVersion: (r.ruleset_version as string | null) ?? null,
  maxMoves: (r.max_moves as number | null) ?? null,
  paceMs: r.pace_ms as number,
  moves: r.moves as number,
  lastExplanation: (r.last_explanation as string | null) ?? null,
  metricsJson: r.metrics_json as string,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
  finishedAt: (r.finished_at as string | null) ?? null,
});

export function botRunRepo(db: SqliteDatabase) {
  const ins = db.prepare(
    `INSERT INTO bot_runs (id, owner_user_id, owner_guest_id, bot_version, mode, config_json, budget_json, status, game_id, match_id,
       game_seed, ruleset_version, max_moves, pace_ms, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const get = db.prepare("SELECT * FROM bot_runs WHERE id = ?");
  const byGame = db.prepare("SELECT * FROM bot_runs WHERE game_id = ?");
  const progress = db.prepare("UPDATE bot_runs SET moves = ?, last_explanation = ?, updated_at = ? WHERE id = ?");
  const setStatus = db.prepare(
    `UPDATE bot_runs SET status = ?, updated_at = ?, finished_at = CASE WHEN ? IN ('finished','cancelled','error') THEN COALESCE(finished_at, ?) ELSE NULL END
     WHERE id = ? AND status NOT IN ('finished','cancelled','error')`,
  );
  const unfinished = db.prepare("SELECT * FROM bot_runs WHERE status IN ('running','paused') ORDER BY created_at, id");
  return {
    insert(r: {
      id: string; ownerUserId: string | null; ownerGuestId: string | null; botVersion: string; mode: "exhibition" | "league"; configJson: string;
      budgetJson: string; status: BotRunStatus; gameId: string | null; matchId: string | null; gameSeed: string; rulesetVersion: string;
      maxMoves: number | null; paceMs: number; at: string;
    }): void {
      ins.run(r.id, r.ownerUserId, r.ownerGuestId, r.botVersion, r.mode, r.configJson, r.budgetJson, r.status, r.gameId, r.matchId, r.gameSeed, r.rulesetVersion, r.maxMoves, r.paceMs, r.at, r.at);
    },
    get: (id: string) => { const r = get.get(id) as Raw | undefined; return r ? run(r) : undefined; },
    byGame: (gameId: string) => { const r = byGame.get(gameId) as Raw | undefined; return r ? run(r) : undefined; },
    progress: (id: string, moves: number, explanation: string | null, at: string) => void progress.run(moves, explanation, at, id),
    /** Terminal statuses are sticky: a finished/cancelled run never changes again (idempotent controls). */
    setStatus: (id: string, status: BotRunStatus, at: string) => setStatus.run(status, at, status, at, id).changes > 0,
    unfinished: () => (unfinished.all() as Raw[]).map(run),
    countActive(owner: { userId?: string; guestId?: string }): number {
      const col = owner.userId ? "owner_user_id" : "owner_guest_id";
      return (db.prepare(`SELECT count(*) AS n FROM bot_runs WHERE ${col} = ? AND status IN ('running','paused')`).get(owner.userId ?? owner.guestId) as { n: number }).n;
    },
  };
}
export type BotRunRepo = ReturnType<typeof botRunRepo>;
