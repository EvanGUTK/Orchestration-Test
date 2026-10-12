import type { Database as SqliteDatabase } from "better-sqlite3";

type Raw = Record<string, unknown>;

export type ReplayListRow = {
  id: string;
  source: "game" | "import";
  mode: string;
  rulesetVersion: string;
  score: string;
  maxExponent: string;
  acceptedMoves: number;
  createdAt: string;
};

export type ReplayImportRow = {
  id: string;
  ownerUserId: string | null;
  ownerGuestId: string | null;
  rulesetVersion: string;
  seed: string;
  finalScore: string;
  maxExponent: string;
  acceptedMoves: number;
  finalChecksum: string;
  replayJson: string;
  createdAt: string;
};

export function replayRepo(db: SqliteDatabase) {
  const ins = db.prepare(
    `INSERT INTO replay_imports (id, owner_user_id, owner_guest_id, ruleset_version, seed, final_score, max_exponent, accepted_moves, final_checksum, replay_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const get = db.prepare("SELECT * FROM replay_imports WHERE id = ?");
  const count = (col: string) => db.prepare(`SELECT count(*) AS n FROM replay_imports WHERE ${col} = ?`).pluck();
  return {
    insertImport(r: ReplayImportRow): void {
      ins.run(r.id, r.ownerUserId, r.ownerGuestId, r.rulesetVersion, r.seed, r.finalScore, r.maxExponent, r.acceptedMoves, r.finalChecksum, r.replayJson, r.createdAt);
    },
    getImport(id: string): ReplayImportRow | undefined {
      const r = get.get(id) as Raw | undefined;
      if (!r) return undefined;
      return {
        id: r.id as string, ownerUserId: (r.owner_user_id as string | null) ?? null, ownerGuestId: (r.owner_guest_id as string | null) ?? null,
        rulesetVersion: r.ruleset_version as string, seed: r.seed as string, finalScore: r.final_score as string, maxExponent: r.max_exponent as string,
        acceptedMoves: r.accepted_moves as number, finalChecksum: r.final_checksum as string, replayJson: r.replay_json as string, createdAt: r.created_at as string,
      };
    },
    countImports: (owner: { userId?: string; guestId?: string }) =>
      count(owner.userId ? "owner_user_id" : "owner_guest_id").get(owner.userId ?? owner.guestId) as number,
    /** Finished own games plus own imported replays, newest first, keyset-paginated on (created_at, id). */
    list(owner: { userId?: string; guestId?: string }, after: { createdAt: string; id: string } | undefined, limit: number): ReplayListRow[] {
      const gCol = owner.userId ? "owner_user_id" : "owner_guest_id";
      const id = owner.userId ?? owner.guestId;
      const cursor = after ? "WHERE (created_at < ? OR (created_at = ? AND id < ?))" : "";
      const args: unknown[] = [id, id];
      if (after) args.push(after.createdAt, after.createdAt, after.id);
      args.push(limit);
      const sql = `SELECT * FROM (
          SELECT id, 'game' AS source, mode, ruleset_version, score, max_exponent, accepted_moves, created_at FROM games WHERE ${gCol} = ? AND status <> 'active'
          UNION ALL
          SELECT id, 'import' AS source, 'practice' AS mode, ruleset_version, final_score AS score, max_exponent, accepted_moves, created_at FROM replay_imports WHERE ${gCol} = ?
        ) ${cursor} ORDER BY created_at DESC, id DESC LIMIT ?`;
      return (db.prepare(sql).all(...args) as Raw[]).map((r) => ({
        id: r.id as string, source: r.source as "game" | "import", mode: r.mode as string, rulesetVersion: r.ruleset_version as string,
        score: r.score as string, maxExponent: r.max_exponent as string, acceptedMoves: r.accepted_moves as number, createdAt: r.created_at as string,
      }));
    },
  };
}
export type ReplayRepo = ReturnType<typeof replayRepo>;
