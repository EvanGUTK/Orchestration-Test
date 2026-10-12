// ENG-05 | High values
// Pass evidence: exponents 54, 256, 4096 and score > 2^53 survive engine/JSON/SQLite (UI is QA-005/e2e).
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { GameState } from "@g2048/contracts";
import { E } from "./engine-api.js";
import { CLASSIC, VECTORS, frozen, makeState, rows } from "./helpers.js";

const TWO_53 = (1n << 53n).toString(); // 9007199254740992

function sqliteRoundTrip(state: GameState): { state: GameState; scoreType: string; score: string } {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE games (id INTEGER PRIMARY KEY, score TEXT NOT NULL, state TEXT NOT NULL)");
    db.prepare("INSERT INTO games (score, state) VALUES (?, ?)").run(state.score, E.serialize(state));
    const row = db.prepare("SELECT score, typeof(score) AS t, state FROM games").get() as {
      score: string;
      t: string;
      state: string;
    };
    return { state: E.deserialize(row.state), scoreType: row.t, score: row.score };
  } finally {
    db.close();
  }
}

describe("ENG-05 high values", () => {
  it("golden high-value slide: 53+53 and 4095+4095 merge to 54 and 4096 with an exact 1234-digit delta", () => {
    const hv = VECTORS.highValue;
    const res = E.slide(frozen(hv.before.state.board), hv.direction);
    expect(res.board.cells).toEqual(hv.slide.cells);
    expect(res.scoreDelta).toBe(hv.slide.scoreDelta);
    expect(res.scoreDelta).toBe(((1n << 54n) + (1n << 4096n)).toString());
    expect(res.scoreDelta).toHaveLength(hv.slide.scoreDeltaDigits);
    const merged = res.events.filter((e) => e.type === "tile.merged");
    expect(merged.map((m) => (m.type === "tile.merged" ? [m.to, m.exponent, m.value] : null))).toEqual(
      hv.slide.merges.map((m) => [m.to, m.exponent, m.value]),
    );
  });

  it("golden high-value applyMove matches the oracle state and checksum", () => {
    const hv = VECTORS.highValue;
    const res = E.applyMove(frozen(hv.before.state), hv.direction, CLASSIC);
    expect(res.scoreDelta).toBe(hv.applyMove.scoreDelta);
    expect(res.state).toEqual(hv.applyMove.after.state);
    expect(E.checksum(res.state)).toBe(hv.applyMove.after.checksum);
    expect(E.canonicalJson(res.state)).toBe(hv.applyMove.after.canonicalJson);
  });

  it("exponent 256 merge (fixture huge-exponent) is exact", () => {
    const res = E.slide(frozen(rows("255 255 . .", ". . . .", ". . . .", ". . . .")), "left");
    expect(res.board.cells[0]).toBe("256");
    expect(res.scoreDelta).toBe((1n << 256n).toString());
  });

  it("score above 2^53 accumulates exactly (no Number rounding)", () => {
    const state = frozen(
      makeState(rows("1 1 . .", ". . . .", ". . . .", ". . . .").cells, { score: "9007199254740993" }),
    );
    const res = E.applyMove(state, "left", CLASSIC);
    expect(res.state.score).toBe("9007199254740997");
    const big = frozen(
      makeState(rows("53 53 . .", ". . . .", ". . . .", ". . . .").cells, { score: TWO_53 }),
    );
    expect(E.applyMove(big, "left", CLASSIC).state.score).toBe(((1n << 53n) + (1n << 54n)).toString());
  });

  it("exponents 54, 256, 4096 and a >2^53 score survive serialize/deserialize and JSON.parse", () => {
    const state = makeState(rows("54 256 4096 .", ". . . .", ". . . .", ". 1 . .").cells, {
      score: ((1n << 4096n) + 12345n).toString(),
      celebrated2048: true,
    });
    const text = E.serialize(frozen(state));
    const parsed = JSON.parse(text) as GameState;
    expect(parsed.score).toBe(state.score);
    expect(parsed.board.cells.slice(0, 3)).toEqual(["54", "256", "4096"]);
    expect(E.deserialize(text)).toEqual(state);
    expect(E.maxExponent(frozen(state.board))).toBe("4096");
  });

  it("the same values survive a SQLite TEXT round trip byte-for-byte", () => {
    const hv = VECTORS.highValue.applyMove.after.state;
    const back = sqliteRoundTrip(frozen(hv));
    expect(back.scoreType).toBe("text");
    expect(back.score).toBe(hv.score);
    expect(back.state).toEqual(hv);
    expect(E.checksum(back.state)).toBe(VECTORS.highValue.applyMove.after.checksum);
  });

  it("decimal helpers are exact and numeric (not lexical)", () => {
    expect(E.pow2Decimal("54")).toBe("18014398509481984");
    expect(E.pow2Decimal("4096")).toBe((1n << 4096n).toString());
    expect(E.pow2Decimal("1")).toBe("2");
    expect(E.addDecimal("9007199254740993", "1")).toBe("9007199254740994");
    expect(E.addDecimal("0", "0")).toBe("0");
    expect(E.addDecimal("99999999999999999999", "1")).toBe("100000000000000000000");
    expect(E.compareDecimal("10", "9")).toBe(1);
    expect(E.compareDecimal("9", "10")).toBe(-1);
    expect(E.compareDecimal("9007199254740993", "9007199254740992")).toBe(1);
    expect(E.compareDecimal("123", "123")).toBe(0);
    expect(E.maxExponent(frozen(rows(". . . .", ". . . .", ". . . .", ". . . .")))).toBeNull();
    expect(E.maxExponent(frozen(rows("9 10 . .", ". . . .", ". . . .", ". . . .")))).toBe("10");
  });
});
