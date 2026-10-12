import { describe, expect, it } from "vitest";
import { CLASSIC_RULES, RANKED_RULES, DUEL_RULES, customRules } from "@2048/contracts";
import { assertRankedRequestAllowed, attemptEndReason, decideAttempt, isOfficialRankedRules, isStandingEligible } from "../src/index.ts";

const open = { status: "open", rulesetVersion: "ranked-v1" } as const;

describe("ranked challenge attempt rules", () => {
  it("creates the first attempt, resumes an active one, consumes completed/forfeited", () => {
    expect(decideAttempt({ identityKind: "user", challenge: open, existing: null })).toEqual({ action: "create" });
    expect(decideAttempt({ identityKind: "user", challenge: open, existing: { gameId: "g1", status: "active" } })).toEqual({ action: "resume", gameId: "g1" });
    for (const status of ["completed", "forfeited"] as const) {
      expect(decideAttempt({ identityKind: "user", challenge: open, existing: { gameId: "g1", status } })).toEqual({ action: "reject", code: "FORBIDDEN", reason: "attempt-consumed" });
    }
  });

  it("rejects guests, closed challenges, and unsupported rulesets", () => {
    expect(decideAttempt({ identityKind: "guest", challenge: open, existing: null })).toMatchObject({ action: "reject", reason: "guest" });
    expect(decideAttempt({ identityKind: "user", challenge: { ...open, status: "closed" }, existing: null })).toMatchObject({ reason: "challenge-closed" });
    expect(decideAttempt({ identityKind: "user", challenge: { ...open, status: "closed" }, existing: { gameId: "g", status: "active" } })).toMatchObject({ reason: "challenge-closed" });
    expect(decideAttempt({ identityKind: "user", challenge: { status: "open", rulesetVersion: "classic-v1" }, existing: null })).toMatchObject({ reason: "ruleset-unsupported" });
  });

  it("recognises only the official rules", () => {
    expect(isOfficialRankedRules(RANKED_RULES)).toBe(true);
    expect(isOfficialRankedRules(CLASSIC_RULES)).toBe(false);
    expect(isOfficialRankedRules(DUEL_RULES)).toBe(false); // duel ruleset is not the ranked-challenge ruleset
    expect(isOfficialRankedRules(customRules({ boardSize: 4, moveCap: 500 }))).toBe(false);
    expect(isOfficialRankedRules({ ...RANKED_RULES, undoLimit: 1 })).toBe(false);
    expect(isOfficialRankedRules({ ...RANKED_RULES, moveCap: 501 })).toBe(false);
  });

  it("rejects undo and custom options, allows move/forfeit", () => {
    expect(() => assertRankedRequestAllowed({ kind: "undo" })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() => assertRankedRequestAllowed({ kind: "custom-options" })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() => assertRankedRequestAllowed({ kind: "move" })).not.toThrow();
    expect(() => assertRankedRequestAllowed({ kind: "forfeit" })).not.toThrow();
  });

  it("maps terminal state to end reason and standing eligibility", () => {
    expect(attemptEndReason({ status: "active" }, false)).toBeNull();
    expect(attemptEndReason({ status: "forfeited" }, true)).toBe("forfeit");
    expect(attemptEndReason({ status: "completed" }, true)).toBe("dead");
    expect(attemptEndReason({ status: "completed" }, false)).toBe("move-cap");
    expect(isStandingEligible("completed")).toBe(true);
    expect(isStandingEligible("forfeited")).toBe(false);
    expect(isStandingEligible("active")).toBe(false);
  });
});
