import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_STATE_KEYS,
  CreateGameRequest,
  DIRECTIONS,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  MoveRequest,
  PracticeOptionsSchema,
  RULESETS,
  USERNAME_PATTERN,
} from "./index.js";

const FROZEN_VECTORS_SHA256 = "e72474813ba02f21c3c68b9e6b94c7fa33ff696abe9d30b7cc63b23645c29f28";

describe("CONTRACT-001", () => {
  it("golden vectors are byte-identical to the reviewed QA-001 file", () => {
    const bytes = readFileSync(new URL("../vectors/engine-v1.json", import.meta.url));
    const normalized = Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
    expect(createHash("sha256").update(normalized).digest("hex")).toBe(FROZEN_VECTORS_SHA256);
  });

  it("canonical key order matches the vectors' canonical JSON", () => {
    const vectors = JSON.parse(
      readFileSync(new URL("../vectors/engine-v1.json", import.meta.url), "utf8"),
    ) as {
      newGame: { canonicalJson: string }[];
    };
    const keys = Object.keys(JSON.parse(vectors.newGame[0]!.canonicalJson) as object);
    expect(keys).toEqual([...CANONICAL_STATE_KEYS]);
  });

  it("directions enumerate in stable order", () => {
    expect(DIRECTIONS).toEqual(["up", "right", "down", "left"]);
  });

  it("ranked rulesets have a 500-move cap and no undo", () => {
    for (const version of ["ranked-v1", "duel-v1"] as const) {
      expect(RULESETS[version]).toMatchObject({ size: 4, moveCap: 500, undo: false, ranked: true });
    }
    expect(RULESETS["classic-v1"]).toMatchObject({ undo: true, historyLimit: 100, ranked: false });
  });

  it("every error code has an HTTP status; NO_CHANGE is not an error status", () => {
    for (const code of ERROR_CODES) expect(ERROR_HTTP_STATUS[code]).toBeTypeOf("number");
    expect(ERROR_HTTP_STATUS.NO_CHANGE).toBe(200);
    expect(ERROR_HTTP_STATUS.REVISION_CONFLICT).toBe(409);
  });

  it("validates request shapes", () => {
    expect(USERNAME_PATTERN.test("player_1")).toBe(true);
    expect(USERNAME_PATTERN.test("Player")).toBe(false);
    expect(PracticeOptionsSchema.safeParse({ size: 9 }).success).toBe(false);
    expect(PracticeOptionsSchema.parse({ size: 3 })).toMatchObject({ size: 3, fourWeight: 1, undo: true });
    expect(CreateGameRequest.safeParse({ mode: "ranked" }).success).toBe(false);
    expect(
      MoveRequest.safeParse({ commandId: "abc12345", expectedRevision: 0, direction: "left" }).success,
    ).toBe(true);
    expect(MoveRequest.safeParse({ commandId: "x", expectedRevision: -1, direction: "diag" }).success).toBe(
      false,
    );
  });
});
