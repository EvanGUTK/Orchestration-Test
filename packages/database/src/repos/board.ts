import type { Database as SqliteDatabase } from "better-sqlite3";

/**
 * Keyset-paginated, exactly ordered boards. Each board is a SELECT exposing every sort key as an aliased
 * column; ordering uses (length, lexical) of canonical decimals so scores of any size sort exactly and
 * never pass through REAL. Cursors carry the key values of the last row plus its rank.
 */
export type SortKey = { alias: string; dir: "ASC" | "DESC" };

export type BoardCursor = { values: (string | number)[]; rank: number };

export function encodeBoardCursor(c: BoardCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeBoardCursor(raw: string, keyCount: number): BoardCursor {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as BoardCursor;
    if (
      !c || !Array.isArray(c.values) || c.values.length !== keyCount || !Number.isSafeInteger(c.rank) || c.rank < 0 ||
      !c.values.every((v) => typeof v === "string" || (typeof v === "number" && Number.isFinite(v)))
    ) throw new Error("shape");
    return c;
  } catch {
    throw new RangeError("Invalid cursor");
  }
}

/** SQL for "row A sorts strictly before row B" over `keys`, with column expressions for A and B. */
export function beforeChain(keys: readonly { a: string; b: string; dir: "ASC" | "DESC" }[]): string {
  const k = keys[0];
  if (!k) return "0";
  const cmp = k.dir === "DESC" ? `${k.a} > ${k.b}` : `${k.a} < ${k.b}`;
  if (keys.length === 1) return `(${cmp})`;
  return `(${cmp} OR (${k.a} = ${k.b} AND ${beforeChain(keys.slice(1))}))`;
}

export type BoardQuery = {
  /** SELECT ... producing every key alias plus the payload columns. */
  sql: string;
  params: unknown[];
  keys: readonly SortKey[];
};

export type BoardRow = Record<string, unknown> & { rank: number };

/** One page of a board. Ranks are 1-based positions in the unfiltered board order. */
export function boardPage(
  db: SqliteDatabase,
  q: BoardQuery,
  opts: { limit: number; cursor?: string | undefined; accountId?: string | undefined; accountColumn?: string },
): { rows: BoardRow[]; nextCursor: string | null } {
  const after = opts.cursor ? decodeBoardCursor(opts.cursor, q.keys.length) : null;
  const where: string[] = [];
  const params: unknown[] = [...q.params];
  if (after) {
    const parts: string[] = [];
    q.keys.forEach((k, i) => {
      const eq = q.keys.slice(0, i).map((p) => `${p.alias} = ?`);
      const cmp = `${k.alias} ${k.dir === "DESC" ? "<" : ">"} ?`;
      parts.push(`(${[...eq, cmp].join(" AND ")})`);
      params.push(...after.values.slice(0, i), after.values[i]);
    });
    where.push(`(${parts.join(" OR ")})`);
  }
  if (opts.accountId !== undefined) {
    where.push(`${opts.accountColumn ?? "account_id"} = ?`);
    params.push(opts.accountId);
  }
  const order = q.keys.map((k) => `${k.alias} ${k.dir}`).join(", ");
  const sql = `SELECT * FROM (${q.sql}) ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ?`;
  params.push(opts.limit + 1);
  const raw = db.prepare(sql).all(...params) as Record<string, unknown>[];
  const page = raw.slice(0, opts.limit);

  const rows: BoardRow[] = page.map((r, i) => {
    let rank: number;
    if (opts.accountId !== undefined) {
      rank = rankOf(db, q, r);
    } else {
      rank = (after?.rank ?? 0) + i + 1;
    }
    return { ...r, rank };
  });
  const last = page[page.length - 1];
  const next =
    raw.length > opts.limit && last
      ? encodeBoardCursor({ values: q.keys.map((k) => last[k.alias] as string | number), rank: rows[rows.length - 1]!.rank })
      : null;
  return { rows, nextCursor: next };
}

/** Rank of a board row among the whole board = 1 + number of rows strictly before it. */
export function rankOf(db: SqliteDatabase, q: BoardQuery, row: Record<string, unknown>): number {
  const before = beforeChain(q.keys.map((k) => ({ a: `b.${k.alias}`, b: "?", dir: k.dir })));
  // beforeChain emits each `?` in order of appearance; build the matching parameter list.
  const params: unknown[] = [];
  const emit = (i: number): void => {
    if (i >= q.keys.length) return;
    params.push(row[q.keys[i]!.alias]); // cmp
    if (i + 1 < q.keys.length) {
      params.push(row[q.keys[i]!.alias]); // equality
      emit(i + 1);
    }
  };
  emit(0);
  const n = db.prepare(`SELECT count(*) AS n FROM (${q.sql}) b WHERE ${before}`).get(...q.params, ...params) as { n: number };
  return n.n + 1;
}
